import os
import subprocess
import tempfile
import unittest
from pathlib import Path


SCRIPTS = Path(__file__).resolve().parents[1]
SSH_BRIDGE = SCRIPTS / "codex-terminal-ssh-bridge.sh"
MAILBOX_HELPER = SCRIPTS / "codex-terminal-ssh-mailbox.py"


class MailboxSafetyTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        # macOS exposes /var as a symlink to /private/var.  The mailbox helper
        # intentionally rejects symlinked path components, so use the physical
        # path that the production /config mount also provides.
        self.root = Path(self.tempdir.name).resolve()
        self.bridge = self.root / "bridge"
        self.requests = self.bridge / "requests"
        self.requests.mkdir(parents=True, mode=0o700)
        self.outside = self.root / "outside"
        self.outside.mkdir()
        self.env = os.environ.copy()
        self.env.update(
            {
                "CODEX_TERMINAL_SSH_BRIDGE_LIBRARY_ONLY": "true",
                "CODEX_TERMINAL_SSH_BRIDGE_DIR": str(self.bridge),
                "CODEX_TERMINAL_SSH_MAILBOX_HELPER": str(MAILBOX_HELPER),
                "CODEX_TERMINAL_SSH_BRIDGE_LOG": str(self.root / "bridge.log"),
            }
        )

    def request(self, name: str = "request.abcdef") -> Path:
        request = self.requests / name
        request.mkdir(mode=0o700)
        (request / "stdin").write_bytes(b"")
        (request / "ready").touch()
        return request

    def process(self, request: Path) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                "bash",
                "-c",
                '. "$1"; process_request "$2"',
                "test",
                str(SSH_BRIDGE),
                str(request),
            ],
            env=self.env,
            text=True,
            capture_output=True,
            check=False,
        )

    def assert_generic_rejection(self, request: Path):
        result = self.process(request)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            (request / "stderr").read_text(),
            "Unsafe SSH mailbox request rejected.\n",
        )
        self.assertEqual((request / "exit_code").read_text(), "2\n")
        self.assertTrue((request / "done").is_file())

    def test_shared_mailbox_allows_status_only(self):
        request = self.request()
        (request / "command").write_text("status\n")

        result = self.process(request)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((request / "exit_code").read_text(), "0\n")
        self.assertIn("Bridge: running", (request / "response").read_text())
        self.assertEqual((request / "stderr").read_text(), "")

    def test_shared_mailbox_rejects_prompt_and_readback_commands(self):
        for index, command in enumerate(("send", "capture", "transcript", "logs", "ask-file")):
            with self.subTest(command=command):
                request = self.request(f"request.blocked{index}")
                (request / "command").write_text(f"{command}\n")

                result = self.process(request)

                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual((request / "exit_code").read_text(), "2\n")
                self.assertIn("permits status only", (request / "stderr").read_text())
                self.assertEqual((request / "response").read_text(), "")

    def test_command_symlink_is_rejected_without_disclosing_target(self):
        secret = self.outside / "auth.json"
        secret.write_text("AUTH_JSON_SECRET_SENTINEL")
        request = self.request()
        (request / "command").symlink_to(secret)

        self.assert_generic_rejection(request)
        self.assertNotIn("AUTH_JSON_SECRET_SENTINEL", (request / "stderr").read_text())
        self.assertEqual(secret.read_text(), "AUTH_JSON_SECRET_SENTINEL")

    def test_stdin_symlink_is_rejected_before_tmux_can_read_it(self):
        secret = self.outside / "auth.json"
        secret.write_text("AUTH_JSON_SECRET_SENTINEL")
        request = self.request()
        (request / "command").write_text("send\n")
        (request / "stdin").unlink()
        (request / "stdin").symlink_to(secret)

        self.assert_generic_rejection(request)
        self.assertNotIn("AUTH_JSON_SECRET_SENTINEL", (request / "stderr").read_text())

    def test_argument_symlink_is_rejected_before_command_dispatch(self):
        secret = self.outside / "auth.json"
        secret.write_text("200")
        request = self.request()
        (request / "command").write_text("capture\n")
        (request / "arg1").symlink_to(secret)

        self.assert_generic_rejection(request)

    def test_output_symlinks_are_replaced_without_touching_targets(self):
        request = self.request()
        (request / "command").write_text("unsupported\n")
        targets = {}
        for name in ("response", "stderr", "exit_code"):
            target = self.outside / name
            target.write_text(f"outside-{name}")
            (request / name).symlink_to(target)
            targets[name] = target

        result = self.process(request)

        self.assertEqual(result.returncode, 0, result.stderr)
        for name, target in targets.items():
            with self.subTest(name=name):
                self.assertEqual(target.read_text(), f"outside-{name}")
                self.assertTrue((request / name).is_file())
                self.assertFalse((request / name).is_symlink())
        self.assertEqual((request / "exit_code").read_text(), "2\n")
        self.assertIn("permits status only", (request / "stderr").read_text())

    def test_done_symlink_is_replaced_without_touching_target(self):
        request = self.request()
        (request / "command").write_text("status\n")
        target = self.outside / "done-target"
        target.write_text("keep-me")
        (request / "done").symlink_to(target)

        self.assert_generic_rejection(request)
        self.assertEqual(target.read_text(), "keep-me")
        self.assertFalse((request / "done").is_symlink())

    def test_request_directory_symlink_is_never_followed(self):
        target = self.outside / "request-target"
        target.mkdir(mode=0o700)
        (target / "command").write_text("status\n")
        (target / "stdin").write_bytes(b"")
        (target / "ready").touch()
        request = self.requests / "request.symlink"
        request.symlink_to(target, target_is_directory=True)

        result = self.process(request)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((target / "done").exists())
        self.assertFalse((target / "response").exists())

    def test_cleanup_does_not_follow_request_directory_symlink(self):
        target = self.outside / "request-target"
        target.mkdir()
        marker = target / "keep-me"
        marker.write_text("safe")
        (self.requests / "request.symlink").symlink_to(target, target_is_directory=True)

        result = subprocess.run(
            [
                "python3",
                str(MAILBOX_HELPER),
                "cleanup",
                str(self.requests),
                "9999999999",
                "0",
                "0",
            ],
            text=True,
            capture_output=True,
            check=False,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(marker.read_text(), "safe")


if __name__ == "__main__":
    unittest.main()
