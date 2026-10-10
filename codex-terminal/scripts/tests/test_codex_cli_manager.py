from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

MANAGER = Path(__file__).resolve().parents[1] / "codex-cli-manager.py"


class CodexCliManagerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.root = self.base / "persistent"
        self.bundled = self.base / "bundled-codex"
        self.bundled.write_text(
            '#!/bin/sh\n'
            'case "$1" in\n'
            '  --version) echo "codex-cli 0.162.1";;\n'
            '  --help) echo "--no-daemon";;\n'
            '  app-server) echo "restart version";;\n'
            'esac\n', encoding="utf-8")
        self.bundled.chmod(0o755)
        self.npm = self.base / "fake-npm"
        self.latest_file = self.base / "latest"
        self.latest_file.write_text("0.163.0", encoding="utf-8")
        self.npm.write_text(
            f'#!{sys.executable}\n'
            'import json, os, pathlib, sys\n'
            'args = sys.argv[1:]\n'
            f'latest = pathlib.Path({str(self.latest_file)!r}).read_text().strip()\n'
            'if args[0] == "view":\n'
            '    print(json.dumps(latest))\n'
            'elif args[0] == "install":\n'
            '    prefix = pathlib.Path(args[args.index("--prefix") + 1])\n'
            '    version = args[args.index("--prefix") + 2].rsplit("@", 1)[1]\n'
            '    binary = prefix / "node_modules" / ".bin" / "codex"\n'
            '    binary.parent.mkdir(parents=True)\n'
            '    binary.write_text("#!/bin/sh\\ncase \\"$1\\" in\\n"\n'
            '        " --version) echo \\"codex-cli " + version + "\\";;\\n"\n'
            '        " --help) echo --no-daemon;;\\n"\n'
            '        " app-server) echo \\"restart version\\";;\\nesac\\n")\n'
            '    binary.chmod(0o755)\n',
            encoding="utf-8",
        )
        self.npm.chmod(0o755)
        self.env = {
            **os.environ,
            "CODEX_CLI_ROOT": str(self.root),
            "CODEX_CLI_BUNDLED_BIN": str(self.bundled),
            "CODEX_CLI_NPM_BIN": str(self.npm),
            "CODEX_HOME": str(self.base / "codex-home"),
            "PYTHONDONTWRITEBYTECODE": "1",
        }

    def manager(self, *args: str, env: dict | None = None) -> dict:
        result = subprocess.run(
            [sys.executable, str(MANAGER), *args],
            env=env or self.env, text=True, capture_output=True, timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_stage_next_launch_persistence_and_rollback(self) -> None:
        self.assertEqual(self.manager("status")["selected"], "0.162.1")
        checked = self.manager("check", "force")
        self.assertTrue(checked["success"])
        self.assertEqual(checked["ready"], "0.163.0")
        self.assertEqual(self.manager("status")["selected"], "0.162.1")
        selected = self.manager("select-local")
        self.assertEqual(selected["version"], "0.163.0")
        self.assertTrue(selected["standalone"])
        self.assertEqual(self.manager("status")["selected"], "0.163.0")
        self.assertEqual(self.manager("rollback")["ready"], "0.162.1")
        self.assertEqual(self.manager("select")["version"], "0.162.1")

    def test_pause_and_failed_stable_tag_keep_current_cli(self) -> None:
        self.manager("set-auto", "false")
        self.assertTrue(self.manager("check")["skipped"])
        self.latest_file.write_text("0.164.0-rc.1", encoding="utf-8")
        outcome = self.manager("check", "force")
        self.assertFalse(outcome["success"])
        self.assertIsNone(outcome["ready"])
        self.assertEqual(self.manager("select")["version"], "0.162.1")

    def test_release_paths_distinguish_supported_architectures(self) -> None:
        spec = importlib.util.spec_from_file_location("codex_cli_manager_test", MANAGER)
        assert spec and spec.loader
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.ROOT = self.root
        for arch in ("amd64", "aarch64"):
            module.ARCH = arch
            self.assertEqual(module.release_dir("0.163.0").name, f"0.163.0-{arch}")

    def test_busy_daemon_uses_standalone_without_restart(self) -> None:
        spec = importlib.util.spec_from_file_location("codex_cli_manager_daemon_test", MANAGER)
        assert spec and spec.loader
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        home = self.base / "codex-home"
        socket = home / "app-server-control" / "app-server-control.sock"
        socket.parent.mkdir(parents=True)
        socket.touch()
        with mock.patch.dict(os.environ, {"CODEX_HOME": str(home)}), \
                mock.patch.object(module, "daemon_version", return_value="0.160.0"), \
                mock.patch.object(module, "daemon_threads_idle", return_value=False), \
                mock.patch.object(module, "run") as restarted:
            standalone, version = module.standalone_for(self.bundled, "0.162.1")
        self.assertTrue(standalone)
        self.assertEqual(version, "0.160.0")
        restarted.assert_not_called()

    def test_idle_daemon_restarts_then_verifies_version(self) -> None:
        spec = importlib.util.spec_from_file_location("codex_cli_manager_restart_test", MANAGER)
        assert spec and spec.loader
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        home = self.base / "codex-home"
        socket = home / "app-server-control" / "app-server-control.sock"
        socket.parent.mkdir(parents=True)
        socket.touch()
        with mock.patch.dict(os.environ, {"CODEX_HOME": str(home)}), \
                mock.patch.object(module, "daemon_version", side_effect=["0.160.0", "0.162.1"]), \
                mock.patch.object(module, "daemon_threads_idle", return_value=True), \
                mock.patch.object(module, "run") as restarted:
            standalone, version = module.standalone_for(self.bundled, "0.162.1")
        self.assertFalse(standalone)
        self.assertEqual(version, "0.162.1")
        restarted.assert_called_once()

    def test_idle_probe_counts_a_cli_even_if_its_prompt_mentions_app_server(self) -> None:
        spec = importlib.util.spec_from_file_location("codex_cli_manager_process_test", MANAGER)
        assert spec and spec.loader
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        output = (
            "codex /usr/local/bin/codex app-server --listen unix:// --managed-daemon\n"
            "codex /usr/local/bin/codex exec inspect app-server logs\n"
        )
        with mock.patch.object(module, "run", return_value=mock.Mock(stdout=output)):
            self.assertTrue(module.other_cli_running())


if __name__ == "__main__":
    unittest.main()
