import contextlib
import io
import json
import runpy
import sys
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "codex-shell-dispatch"
DISPATCH = runpy.run_path(str(SCRIPT))


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return io.BytesIO(json.dumps(self.payload).encode("utf-8"))

    def __exit__(self, _exc_type, _exc, _traceback):
        return False


class ShellDispatchStatusTests(unittest.TestCase):
    def run_main(self, payload):
        stdout = io.StringIO()
        stderr = io.StringIO()
        with (
            mock.patch.object(sys, "argv", [str(SCRIPT), "sleep", "999"]),
            mock.patch("urllib.request.urlopen", return_value=FakeResponse(payload)),
            contextlib.redirect_stdout(stdout),
            contextlib.redirect_stderr(stderr),
        ):
            code = DISPATCH["main"]()
        return code, stdout.getvalue(), stderr.getvalue()

    def test_terminated_timeout_returns_standard_timeout_status(self):
        code, stdout, stderr = self.run_main({
            "success": True,
            "output": "partial output",
            "timedOut": True,
            "terminated": True,
        })
        self.assertEqual(code, 124)
        self.assertIn("partial output", stdout)
        self.assertIn("timed out and was stopped", stderr)
        self.assertNotIn("still running", stderr)

    def test_uncertain_timeout_is_an_error(self):
        code, _stdout, stderr = self.run_main({
            "success": True,
            "timedOut": True,
            "terminated": False,
        })
        self.assertEqual(code, 1)
        self.assertIn("state is uncertain", stderr)

    def test_multiple_arguments_preserve_shell_boundaries(self):
        command = DISPATCH["normalize_command"](
            ["supervisor-api", "-d", '{"name":"a b"}', "/core/test"]
        )
        self.assertEqual(
            command,
            "supervisor-api -d '{\"name\":\"a b\"}' /core/test",
        )

    def test_one_argument_remains_intentional_raw_shell_text(self):
        self.assertEqual(
            DISPATCH["normalize_command"]([",, printf '%s' raw"]),
            "printf '%s' raw",
        )


if __name__ == "__main__":
    unittest.main()
