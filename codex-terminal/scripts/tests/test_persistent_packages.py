import os
import stat
import subprocess
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "persistent-packages.sh"
UPDATER = Path(__file__).resolve().parents[1] / "update-apk-manifest"
INSTALLER = Path(__file__).resolve().parents[1] / "persist-install"
RUN_SCRIPT = Path(__file__).resolve().parents[2] / "run.sh"


class PersistentPackageMigrationTests(unittest.TestCase):
    def run_script(self, root: Path, action: str, env=None):
        command = (
            'function bashio::log.info() { :; }; '
            'function bashio::log.warning() { :; }; '
            'function bashio::log.error() { :; }; '
            f'set -- {action}; source "$SCRIPT_UNDER_TEST"'
        )
        return subprocess.run(
            ["bash", "-c", command],
            text=True,
            capture_output=True,
            env={
                **os.environ,
                "PERSIST_ROOT": str(root),
                "PERSIST_MANIFEST_UPDATER": str(UPDATER),
                "PERSIST_LOCK_HELPER": str(UPDATER),
                "SCRIPT_UNDER_TEST": str(SCRIPT),
                **(env or {}),
            },
            check=False,
        )

    @staticmethod
    def make_executable(path: Path, contents: str):
        path.write_text(contents, encoding="utf-8")
        path.chmod(path.stat().st_mode | stat.S_IXUSR)

    def make_fake_python_runtime(self, directory: Path):
        pip_runner = directory / "fake-venv-python"
        self.make_executable(
            pip_runner,
            """#!/bin/bash
if [ "${1:-}" = "-c" ]; then
    printf '%s\\n' "$FAKE_INTERPRETER_MARKER"
    exit 0
fi
printf '%s\\n' "$*" >> "$FAKE_PIP_LOG"
if [ "$*" = "-m pip install --upgrade -- pip" ]; then
    exit "${FAKE_PIP_UPGRADE_EXIT:-0}"
fi
exit "${FAKE_PIP_EXIT:-0}"
""",
        )
        system_python = directory / "fake-system-python"
        self.make_executable(
            system_python,
            """#!/bin/bash
set -eu
if [ "${1:-}" = "-c" ]; then
    printf '%s\\n' "$FAKE_INTERPRETER_MARKER"
    exit 0
fi
if [ "${1:-}" = "-m" ] && [ "${2:-}" = "venv" ]; then
    target="${3:?missing venv target}"
    mkdir -p "$target/bin"
    cp "$FAKE_VENV_PYTHON_TEMPLATE" "$target/bin/python"
    chmod +x "$target/bin/python"
    exit 0
fi
exit 64
""",
        )
        return system_python, pip_runner

    def test_legacy_binary_and_library_copies_are_quarantined_once(self):
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir) / "packages"
            (root / "bin").mkdir(parents=True)
            (root / "lib").mkdir()
            (root / "bin" / "user-tool").write_text("#!/bin/sh\n", encoding="utf-8")
            (root / "lib" / "libstale.so").write_text("stale", encoding="utf-8")

            first = self.run_script(root, "migrate")
            self.assertEqual(first.returncode, 0, first.stderr)
            self.assertTrue((root / "bin" / "user-tool").is_file())
            self.assertTrue((root / "legacy-copied-files" / "lib" / "libstale.so").is_file())
            self.assertTrue((root / "bin").is_dir())
            self.assertFalse((root / "lib").exists())
            self.assertTrue((root / ".manifest-package-migration-v2").is_file())

            (root / "bin" / "new-user-tool").write_text("new", encoding="utf-8")
            second = self.run_script(root, "migrate")
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assertTrue((root / "bin" / "new-user-tool").is_file())

    def test_concurrent_manifest_updates_do_not_drop_packages(self):
        with tempfile.TemporaryDirectory() as tempdir:
            manifest = Path(tempdir) / "apk-packages.txt"
            packages = [f"package-{index}" for index in range(24)]

            def update(package):
                return subprocess.run(
                    [sys.executable, str(UPDATER), str(manifest), package],
                    capture_output=True,
                    text=True,
                    check=False,
                )

            with ThreadPoolExecutor(max_workers=8) as executor:
                results = list(executor.map(update, packages))

            self.assertTrue(all(result.returncode == 0 for result in results))
            self.assertEqual(set(manifest.read_text(encoding="utf-8").splitlines()), set(packages))

    def test_manifest_updater_rejects_leading_dash_without_changing_manifest(self):
        with tempfile.TemporaryDirectory() as tempdir:
            manifest = Path(tempdir) / "apk-packages.txt"
            manifest.write_text("existing\n", encoding="utf-8")

            completed = subprocess.run(
                [sys.executable, str(UPDATER), str(manifest), "--repository=attacker"],
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertNotEqual(completed.returncode, 0)
            self.assertEqual(manifest.read_text(encoding="utf-8"), "existing\n")

    def test_manifests_replace_conflicting_constraints_by_package_identity(self):
        with tempfile.TemporaryDirectory() as tempdir:
            pip_manifest = Path(tempdir) / "requirements.txt"
            apk_manifest = Path(tempdir) / "apk-packages.txt"

            for arguments in (
                ["--kind", "pip", str(pip_manifest), "demo==1.0", "alpha>=2"],
                ["--kind", "pip", str(pip_manifest), "demo==2.0"],
                ["--kind", "apk", str(apk_manifest), "git=1.0-r0", "curl"],
                ["--kind", "apk", str(apk_manifest), "git=2.0-r0"],
            ):
                completed = subprocess.run(
                    [sys.executable, str(UPDATER), *arguments],
                    text=True,
                    capture_output=True,
                    check=False,
                )
                self.assertEqual(completed.returncode, 0, completed.stderr)

            self.assertEqual(
                pip_manifest.read_text(encoding="utf-8").splitlines(),
                ["alpha>=2", "demo==2.0"],
            )
            self.assertEqual(
                apk_manifest.read_text(encoding="utf-8").splitlines(),
                ["curl", "git=2.0-r0"],
            )

    def test_python_lock_is_released_by_kernel_when_holder_dies(self):
        with tempfile.TemporaryDirectory() as tempdir:
            lock_path = Path(tempdir) / "python.lock"
            with subprocess.Popen(
                [sys.executable, str(UPDATER), "--hold-lock", str(lock_path), "2"],
                text=True,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            ) as holder:
                self.assertIsNotNone(holder.stdout)
                self.assertEqual(holder.stdout.readline().strip(), "locked")
                holder.kill()
                holder.wait(timeout=5)

            successor = subprocess.run(
                [sys.executable, str(UPDATER), "--hold-lock", str(lock_path), "2"],
                text=True,
                input="",
                capture_output=True,
                check=False,
                timeout=5,
            )
            self.assertEqual(successor.returncode, 0, successor.stderr)
            self.assertEqual(successor.stdout.strip(), "locked")

    def test_restore_attempts_every_manifest_entry_before_reporting_failures(self):
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir) / "packages"
            root.mkdir()
            (root / "apk-packages.txt").write_text(
                "good-one\n--repository=attacker\nbad-package\ngood-two\n",
                encoding="utf-8",
            )
            bin_dir = Path(tempdir) / "bin"
            bin_dir.mkdir()
            log = Path(tempdir) / "apk.log"
            apk = bin_dir / "apk"
            apk.write_text(
                '#!/bin/sh\nprintf "%s\\n" "$*" >> "$APK_TEST_LOG"\n'
                'case "$*" in *bad-package*) exit 1 ;; esac\n',
                encoding="utf-8",
            )
            apk.chmod(apk.stat().st_mode | stat.S_IXUSR)

            completed = self.run_script(root, "restore", {
                "PATH": f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}",
                "APK_TEST_LOG": str(log),
            })
            self.assertEqual(completed.returncode, 1)
            calls = log.read_text(encoding="utf-8").splitlines()
            self.assertEqual(calls, [
                "add --no-cache -- good-one",
                "add --no-cache -- bad-package",
                "add --no-cache -- good-two",
            ])

    def test_apk_manifest_failure_is_reported_after_successful_install(self):
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir) / "packages"
            bin_dir = Path(tempdir) / "bin"
            bin_dir.mkdir()
            apk_log = Path(tempdir) / "apk.log"
            apk = bin_dir / "apk"
            self.make_executable(apk, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$APK_TEST_LOG"\n')
            failed_updater = Path(tempdir) / "failed-updater"
            self.make_executable(failed_updater, "#!/bin/sh\nexit 7\n")

            completed = self.run_script(
                root,
                "install-apk safe-package",
                {
                    "PATH": f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}",
                    "APK_TEST_LOG": str(apk_log),
                    "PERSIST_MANIFEST_UPDATER": str(failed_updater),
                },
            )

            self.assertNotEqual(completed.returncode, 0)
            self.assertEqual(apk_log.read_text(encoding="utf-8").strip(), "add --no-cache -- safe-package")

    def test_manual_install_rejects_leading_dash_before_package_manager(self):
        with tempfile.TemporaryDirectory() as tempdir:
            manager_log = Path(tempdir) / "manager.log"
            manager = Path(tempdir) / "manager"
            self.make_executable(
                manager,
                '#!/bin/sh\nprintf "%s\\n" "$*" >> "$MANAGER_LOG"\n',
            )
            command = (
                'export PERSIST_INSTALL_LIBRARY_ONLY=true; '
                'source "$INSTALLER_UNDER_TEST"; '
                'install_system_packages --repository=attacker'
            )
            completed = subprocess.run(
                ["bash", "-c", command],
                text=True,
                capture_output=True,
                env={
                    **os.environ,
                    "INSTALLER_UNDER_TEST": str(INSTALLER),
                    "PERSIST_PACKAGE_MANAGER": str(manager),
                    "MANAGER_LOG": str(manager_log),
                },
                check=False,
            )

            self.assertNotEqual(completed.returncode, 0)
            self.assertFalse(manager_log.exists())

    def test_user_facing_installer_does_not_claim_success_after_manager_failure(self):
        with tempfile.TemporaryDirectory() as tempdir:
            failed_manager = Path(tempdir) / "failed-manager"
            self.make_executable(failed_manager, "#!/bin/sh\nexit 7\n")
            command = (
                'export PERSIST_INSTALL_LIBRARY_ONLY=true; '
                'source "$INSTALLER_UNDER_TEST"; '
                'install_python_packages demo-package'
            )
            completed = subprocess.run(
                ["bash", "-c", command],
                text=True,
                capture_output=True,
                env={
                    **os.environ,
                    "INSTALLER_UNDER_TEST": str(INSTALLER),
                    "PERSIST_PACKAGE_MANAGER": str(failed_manager),
                },
                check=False,
            )

            self.assertNotEqual(completed.returncode, 0)
            self.assertNotIn("Python packages installed!", completed.stdout)
            self.assertIn("Failed to install or persist Python packages", completed.stdout)

    def test_run_script_reads_newline_config_arrays_and_rejects_options(self):
        with tempfile.TemporaryDirectory() as tempdir:
            install_log = Path(tempdir) / "install.log"
            installer = Path(tempdir) / "persist-install"
            self.make_executable(
                installer,
                '#!/bin/sh\nprintf "%s\\n" "$*" >> "$INSTALL_LOG"\n',
            )
            command = r'''
function bashio::log.info() { :; }
function bashio::log.warning() { :; }
function bashio::log.error() { :; }
function bashio::config() {
    case "$1" in
        persistent_apk_packages) printf 'curl\ngit\n--repository=attacker\n' ;;
        persistent_pip_packages) printf 'requests==2.32.0\nhttpx\n--editable\n' ;;
    esac
}
export CODEX_TERMINAL_RUN_LIBRARY_ONLY=true
source "$RUN_SCRIPT_UNDER_TEST"
if auto_install_packages; then
    exit 0
else
    exit $?
fi
'''
            completed = subprocess.run(
                ["bash", "-c", command],
                text=True,
                capture_output=True,
                env={
                    **os.environ,
                    "RUN_SCRIPT_UNDER_TEST": str(RUN_SCRIPT),
                    "PERSIST_INSTALL_BIN": str(installer),
                    "INSTALL_LOG": str(install_log),
                },
                check=False,
            )

            self.assertNotEqual(completed.returncode, 0)
            self.assertEqual(
                install_log.read_text(encoding="utf-8").splitlines(),
                ["curl git", "--python requests==2.32.0 httpx"],
            )

    def test_package_manager_reads_newline_config_arrays_without_jq(self):
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir) / "packages"
            auto_log = Path(tempdir) / "auto.log"
            command = r'''
function bashio::log.info() { :; }
function bashio::log.warning() { :; }
function bashio::log.error() { :; }
function bashio::config() {
    case "$1" in
        persistent_apk_packages) printf 'curl\ngit\n' ;;
        persistent_pip_packages) printf 'requests==2.32.0\nhttpx\n' ;;
    esac
}
set -- env
source "$SCRIPT_UNDER_TEST"
persist_apk_install() { printf 'apk:%s\n' "$*" >> "$AUTO_LOG"; }
persist_pip_install() { printf 'pip:%s\n' "$*" >> "$AUTO_LOG"; }
auto_install_packages
'''
            completed = subprocess.run(
                ["bash", "-c", command],
                text=True,
                capture_output=True,
                env={
                    **os.environ,
                    "PERSIST_ROOT": str(root),
                    "SCRIPT_UNDER_TEST": str(SCRIPT),
                    "AUTO_LOG": str(auto_log),
                },
                check=False,
            )

            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual(
                auto_log.read_text(encoding="utf-8").splitlines(),
                ["apk:curl git", "pip:requests==2.32.0 httpx"],
            )

    def test_pip_failure_does_not_record_requested_requirement(self):
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir) / "packages"
            runtime_dir = Path(tempdir) / "runtime"
            runtime_dir.mkdir()
            system_python, pip_runner = self.make_fake_python_runtime(runtime_dir)
            pip_log = Path(tempdir) / "pip.log"

            completed = self.run_script(
                root,
                "install-pip demo-package",
                {
                    "PERSIST_SYSTEM_PYTHON": str(system_python),
                    "FAKE_VENV_PYTHON_TEMPLATE": str(pip_runner),
                    "FAKE_INTERPRETER_MARKER": "cpython|3.13.1|cpython-313|x86_64",
                    "FAKE_PIP_LOG": str(pip_log),
                    "FAKE_PIP_EXIT": "9",
                },
            )

            self.assertNotEqual(completed.returncode, 0)
            self.assertFalse((root / "python" / "requirements.txt").exists())
            self.assertEqual(
                pip_log.read_text(encoding="utf-8").splitlines(),
                [
                    "-m pip install --upgrade -- pip",
                    "-m pip install -- demo-package",
                ],
            )

    def test_pip_manifest_failure_is_reported(self):
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir) / "packages"
            runtime_dir = Path(tempdir) / "runtime"
            runtime_dir.mkdir()
            system_python, pip_runner = self.make_fake_python_runtime(runtime_dir)
            pip_log = Path(tempdir) / "pip.log"
            failed_updater = Path(tempdir) / "failed-updater"
            self.make_executable(failed_updater, "#!/bin/sh\nexit 6\n")

            completed = self.run_script(
                root,
                "install-pip demo-package",
                {
                    "PERSIST_SYSTEM_PYTHON": str(system_python),
                    "PERSIST_MANIFEST_UPDATER": str(failed_updater),
                    "FAKE_VENV_PYTHON_TEMPLATE": str(pip_runner),
                    "FAKE_INTERPRETER_MARKER": "cpython|3.13.1|cpython-313|x86_64",
                    "FAKE_PIP_LOG": str(pip_log),
                },
            )

            self.assertNotEqual(completed.returncode, 0)
            self.assertFalse((root / "python" / "requirements.txt").exists())

    def test_pip_restore_rejects_leading_dash_before_replacing_venv(self):
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir) / "packages"
            python_root = root / "python"
            old_venv_bin = python_root / "venv" / "bin"
            old_venv_bin.mkdir(parents=True)
            old_python = old_venv_bin / "python"
            self.make_executable(old_python, "#!/bin/sh\nexit 88\n")
            (python_root / "interpreter-version").write_text("old-interpreter\n", encoding="utf-8")
            (python_root / "requirements.txt").write_text(
                "safe-package\n--index-url=attacker\n",
                encoding="utf-8",
            )
            runtime_dir = Path(tempdir) / "runtime"
            runtime_dir.mkdir()
            system_python, pip_runner = self.make_fake_python_runtime(runtime_dir)
            pip_log = Path(tempdir) / "pip.log"

            completed = self.run_script(
                root,
                "restore-pip",
                {
                    "PERSIST_SYSTEM_PYTHON": str(system_python),
                    "FAKE_VENV_PYTHON_TEMPLATE": str(pip_runner),
                    "FAKE_INTERPRETER_MARKER": "new-interpreter",
                    "FAKE_PIP_LOG": str(pip_log),
                },
            )

            self.assertNotEqual(completed.returncode, 0)
            self.assertEqual(old_python.read_text(encoding="utf-8"), "#!/bin/sh\nexit 88\n")
            self.assertFalse(pip_log.exists())

    def test_legacy_venv_is_inventoried_without_unnecessary_rebuild(self):
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir) / "packages"
            python_root = root / "python"
            old_venv_bin = python_root / "venv" / "bin"
            old_venv_bin.mkdir(parents=True)
            marker = "cpython|3.13.1|cpython-313|x86_64"
            old_python = old_venv_bin / "python"
            old_contents = f"""#!/bin/bash
if [ "${{1:-}}" = "-c" ]; then
    printf '%s\\n' '{marker}'
elif [ "$*" = "-m pip freeze" ]; then
    printf '%s\\n' 'beta==2.0' 'alpha==1.0'
else
    exit 64
fi
"""
            self.make_executable(old_python, old_contents)
            runtime_dir = Path(tempdir) / "runtime"
            runtime_dir.mkdir()
            system_python, pip_runner = self.make_fake_python_runtime(runtime_dir)
            pip_log = Path(tempdir) / "pip.log"

            completed = self.run_script(
                root,
                "restore-pip",
                {
                    "PERSIST_SYSTEM_PYTHON": str(system_python),
                    "FAKE_VENV_PYTHON_TEMPLATE": str(pip_runner),
                    "FAKE_INTERPRETER_MARKER": marker,
                    "FAKE_PIP_LOG": str(pip_log),
                },
            )

            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual(old_python.read_text(encoding="utf-8"), old_contents)
            self.assertEqual(
                (python_root / "requirements.txt").read_text(encoding="utf-8").splitlines(),
                ["alpha==1.0", "beta==2.0"],
            )
            self.assertEqual((python_root / "interpreter-version").read_text(encoding="utf-8"), f"{marker}\n")
            self.assertFalse(pip_log.exists())

    def test_interpreter_mismatch_rebuilds_venv_and_reinstalls_manifest(self):
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir) / "packages"
            python_root = root / "python"
            old_venv_bin = python_root / "venv" / "bin"
            old_venv_bin.mkdir(parents=True)
            old_python = old_venv_bin / "python"
            self.make_executable(old_python, "#!/bin/sh\nexit 88\n")
            (python_root / "interpreter-version").write_text(
                "cpython|3.12.0|cpython-312|x86_64\n",
                encoding="utf-8",
            )
            (python_root / "requirements.txt").write_text(
                "alpha==1.0\nbeta[extra]\n",
                encoding="utf-8",
            )
            runtime_dir = Path(tempdir) / "runtime"
            runtime_dir.mkdir()
            system_python, pip_runner = self.make_fake_python_runtime(runtime_dir)
            pip_log = Path(tempdir) / "pip.log"
            marker = "cpython|3.13.1|cpython-313|x86_64"
            env = {
                "PERSIST_SYSTEM_PYTHON": str(system_python),
                "FAKE_VENV_PYTHON_TEMPLATE": str(pip_runner),
                "FAKE_INTERPRETER_MARKER": marker,
                "FAKE_PIP_LOG": str(pip_log),
            }

            first = self.run_script(root, "restore-pip", env)
            self.assertEqual(first.returncode, 0, first.stderr)
            self.assertEqual((python_root / "interpreter-version").read_text(encoding="utf-8"), f"{marker}\n")
            calls_after_first = pip_log.read_text(encoding="utf-8").splitlines()
            self.assertEqual(
                calls_after_first,
                [f"-m pip install --requirement={python_root / 'requirements.txt'}"],
            )

            second = self.run_script(root, "restore-pip", env)
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assertEqual(pip_log.read_text(encoding="utf-8").splitlines(), calls_after_first)


if __name__ == "__main__":
    unittest.main()
