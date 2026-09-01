import contextlib
import io
import json
import os
import runpy
import sys
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "codex-shell-dispatch"
DISPATCH = runpy.run_path(str(SCRIPT))


class FakeResponse:
    def __init__(self, payload):
        self.status = 200
        self.stream = io.BytesIO(json.dumps(payload).encode("utf-8"))

    def read(self, size=-1):
        return self.stream.read(size)


class FakeConnection:
    def __init__(self, payload, requests, socket_path, timeout=60):
        self.payload = payload
        self.requests = requests
        self.socket_path = socket_path
        self.timeout = timeout

    def request(self, method, path, body, headers):
        self.requests.append((method, path, body, headers))

    def getresponse(self):
        return FakeResponse(self.payload)

    def close(self):
        pass


class ShellDispatchStatusTests(unittest.TestCase):
    def run_main(self, payload):
        stdout = io.StringIO()
        stderr = io.StringIO()
        requests = []
        with (
            mock.patch.object(sys, "argv", [str(SCRIPT), "sleep", "999"]),
            mock.patch.dict(
                os.environ,
                {"SHELL_DISPATCH_SOCKET_PATH": "/private/root-only/dispatch.sock"},
            ),
            mock.patch.dict(
                DISPATCH["main"].__globals__,
                {
                    "validate_socket": mock.Mock(),
                    "UnixHTTPConnection": lambda socket_path, timeout=60: FakeConnection(
                        payload, requests, socket_path, timeout
                    ),
                },
            ),
            contextlib.redirect_stdout(stdout),
            contextlib.redirect_stderr(stderr),
        ):
            code = DISPATCH["main"]()
        return code, stdout.getvalue(), stderr.getvalue(), requests

    def test_terminated_timeout_returns_standard_timeout_status(self):
        code, stdout, stderr, requests = self.run_main({
            "success": True,
            "output": "partial output",
            "timedOut": True,
            "terminated": True,
        })
        self.assertEqual(code, 124)
        self.assertIn("partial output", stdout)
        self.assertIn("timed out and was stopped", stderr)
        self.assertNotIn("still running", stderr)
        self.assertEqual(requests[0][0:2], ("POST", "/terminal-shell-command"))

    def test_uncertain_timeout_is_an_error(self):
        code, _stdout, stderr, _requests = self.run_main({
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
