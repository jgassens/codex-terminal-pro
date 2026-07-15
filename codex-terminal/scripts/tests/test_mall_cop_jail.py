from __future__ import annotations

import importlib.util
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "codex-terminal-mall-cop-jail.py"
SPEC = importlib.util.spec_from_file_location("mall_cop_jail", SCRIPT)
assert SPEC and SPEC.loader
JAIL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(JAIL)


class MallCopJailTests(unittest.TestCase):
    def make_jail(self, root: Path) -> tuple[Path, str]:
        jail_root = root / "jail"
        command = jail_root / "bin" / "codex"
        work = jail_root / "work" / "run-test123"
        command.parent.mkdir(parents=True)
        work.mkdir(parents=True)
        command.write_bytes(b"not executed in unit tests")
        command.chmod(0o555)
        work.chmod(0o700)
        return jail_root, "/work/run-test123"

    def configured(self, jail_root: Path):
        return mock.patch.multiple(
            JAIL,
            DEFAULT_JAIL_ROOT=jail_root,
            JAIL_OWNER_UID=os.geteuid(),
            UNPRIVILEGED_UID=os.geteuid(),
            UNPRIVILEGED_GID=os.getegid(),
        )

    def test_validation_accepts_only_the_fixed_binary_and_private_run_directory(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            jail_root, cwd = self.make_jail(Path(directory))
            with self.configured(jail_root):
                JAIL.validate_jail(jail_root, cwd, ["/bin/codex", "--version"])
                with self.assertRaisesRegex(JAIL.JailError, "only the bundled Codex"):
                    JAIL.validate_jail(jail_root, cwd, ["/bin/sh"])
                with self.assertRaisesRegex(JAIL.JailError, "outside the per-run"):
                    JAIL.validate_jail(jail_root, "/config", ["/bin/codex"])

    def test_validation_rejects_writable_jail_or_work_paths(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            jail_root, cwd = self.make_jail(Path(directory))
            with self.configured(jail_root):
                jail_root.chmod(0o777)
                with self.assertRaisesRegex(JAIL.JailError, "not group/world writable"):
                    JAIL.validate_jail(jail_root, cwd, ["/bin/codex"])
                jail_root.chmod(0o755)
                (jail_root / cwd.lstrip("/")).chmod(0o755)
                with self.assertRaisesRegex(JAIL.JailError, "mode 0700"):
                    JAIL.validate_jail(jail_root, cwd, ["/bin/codex"])

    def test_launcher_chroots_then_drops_groups_gid_uid_before_exec(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            jail_root, cwd = self.make_jail(Path(directory))
            events: list[str] = []

            def record(name: str):
                return lambda *args, **kwargs: events.append(name)

            with self.configured(jail_root), \
                mock.patch.object(JAIL.os, "geteuid", return_value=0), \
                mock.patch.object(JAIL.os, "chroot", side_effect=record("chroot")), \
                mock.patch.object(JAIL.os, "chdir", side_effect=record("chdir")), \
                mock.patch.object(JAIL.os, "setgroups", side_effect=record("setgroups")), \
                mock.patch.object(JAIL.os, "setgid", side_effect=record("setgid")), \
                mock.patch.object(JAIL.os, "setuid", side_effect=record("setuid")), \
                mock.patch.object(JAIL, "set_no_new_privileges", side_effect=record("nnp")), \
                mock.patch.object(JAIL.os, "execve", side_effect=RuntimeError("exec reached")):
                with self.assertRaisesRegex(RuntimeError, "exec reached"):
                    JAIL.enter_and_exec(jail_root, cwd, ["/bin/codex", "--version"])

            self.assertEqual(
                events,
                ["chroot", "chdir", "setgroups", "setgid", "setuid", "nnp"],
            )


if __name__ == "__main__":
    unittest.main()
