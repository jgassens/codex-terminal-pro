#!/usr/bin/env python3
"""Focused exploit-regression tests for the Home Assistant guardrails."""

from __future__ import annotations

import json
import os
import runpy
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPTS_DIR = Path(__file__).resolve().parents[1]
SUPERVISOR_API = SCRIPTS_DIR / "supervisor-api.sh"
SUPERVISOR_BROKER = SCRIPTS_DIR / "supervisor-broker.sh"
HA_GUARD = SCRIPTS_DIR / "ha-guard.sh"
HA_WS = SCRIPTS_DIR / "ha-ws"


def write_executable(path: Path, contents: str) -> None:
    path.write_text(contents, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)


def instrument_script(source: Path, destination: Path, replacements: dict[str, str]) -> Path:
    contents = source.read_text(encoding="utf-8")
    for old, new in replacements.items():
        if old not in contents:
            raise AssertionError(f"test instrumentation anchor is missing: {old}")
        contents = contents.replace(old, new, 1)
    write_executable(destination, contents)
    return destination


class TemporaryGuardrailTest(unittest.TestCase):
    def setUp(self) -> None:
        self._temporary_directory = tempfile.TemporaryDirectory()
        self.temp = Path(self._temporary_directory.name)
        self.bin_dir = self.temp / "bin"
        self.bin_dir.mkdir()
        self.env = os.environ.copy()
        self.env["PATH"] = f"{self.bin_dir}{os.pathsep}{self.env.get('PATH', '')}"

    def tearDown(self) -> None:
        self._temporary_directory.cleanup()

    def run_command(self, arguments: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            arguments,
            check=False,
            capture_output=True,
            text=True,
            env=self.env,
            **kwargs,
        )


class SupervisorApiTests(TemporaryGuardrailTest):
    def setUp(self) -> None:
        super().setUp()
        self.broker_capture = self.temp / "broker.json"
        self.broker_env_capture = self.temp / "broker-env.txt"
        self.curl_capture = self.temp / "curl.json"
        self.token_file = self.temp / "token"
        self.token_file.write_text("test-supervisor-token\n", encoding="utf-8")

        self.fake_broker = self.bin_dir / "supervisor-broker"
        write_executable(
            self.fake_broker,
            """#!/usr/bin/env python3
import json
import os
import sys
with open(os.environ["BROKER_CAPTURE"], "w", encoding="utf-8") as handle:
    json.dump(sys.argv[1:], handle)
with open(os.environ["BROKER_ENV_CAPTURE"], "w", encoding="utf-8") as handle:
    handle.write(os.environ.get("CODEX_TERMINAL_AGENT_EXECUTION", ""))
""",
        )
        write_executable(
            self.bin_dir / "curl",
            """#!/usr/bin/env python3
import json
import os
import sys
with open(os.environ["CURL_CAPTURE"], "w", encoding="utf-8") as handle:
    json.dump(sys.argv[1:], handle)
""",
        )

        self.script = instrument_script(
            SUPERVISOR_API,
            self.temp / "supervisor-api",
            {
                'BROKER="/data/packages/guard/bin/supervisor-broker"': f'BROKER="{self.fake_broker}"',
                'TOKEN_FILE="/data/.supervisor/token"': f'TOKEN_FILE="{self.token_file}"',
                'CURL_BIN="/usr/bin/curl"': f'CURL_BIN="{self.bin_dir / "curl"}"',
            },
        )
        self.env["BROKER_CAPTURE"] = str(self.broker_capture)
        self.env["BROKER_ENV_CAPTURE"] = str(self.broker_env_capture)
        self.env["CURL_CAPTURE"] = str(self.curl_capture)

    def test_codex_actor_marker_reaches_the_authorization_broker(self) -> None:
        self.env["CODEX_TERMINAL_AGENT_EXECUTION"] = "1"
        completed = self.run_command([str(self.script), "/core/info"])
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(self.broker_env_capture.read_text(encoding="utf-8"), "1")

    def test_legitimate_json_request_uses_one_fixed_supervisor_url(self) -> None:
        path = "/core/api/services/automation/reload"
        payload = '{"entity_id":"automation.kitchen"}'
        completed = self.run_command(
            [
                str(self.script),
                "-X",
                "post",
                path,
                "-H",
                "Content-Type: application/json",
                "-HAccept: application/json",
                "-d",
                payload,
                "--max-time=10",
            ]
        )

        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(json.loads(self.broker_capture.read_text()), ["rest", "POST", path])

        curl_args = json.loads(self.curl_capture.read_text())
        self.assertEqual(curl_args[0], "--disable")
        self.assertNotIn("--location", curl_args)
        self.assertIn("--globoff", curl_args)
        self.assertIn("--noproxy", curl_args)
        self.assertEqual(curl_args[curl_args.index("--connect-timeout") + 1], "10")
        self.assertEqual(curl_args[curl_args.index("--max-time") + 1], "10")
        self.assertIn("Authorization: Bearer test-supervisor-token", curl_args)
        self.assertIn("Content-Type: application/json", curl_args)
        self.assertIn("Accept: application/json", curl_args)
        self.assertIn(payload, curl_args)
        self.assertEqual(
            [argument for argument in curl_args if argument.startswith(("http://", "https://"))],
            [f"http://supervisor{path}"],
        )

    def test_default_timeouts_are_finite_and_caller_timeouts_are_bounded(self) -> None:
        completed = self.run_command([str(self.script), "/core/info"])
        self.assertEqual(completed.returncode, 0, completed.stderr)
        curl_args = json.loads(self.curl_capture.read_text())
        self.assertEqual(curl_args[curl_args.index("--connect-timeout") + 1], "10")
        self.assertEqual(curl_args[curl_args.index("--max-time") + 1], "60")

        invalid_options = (
            ("--connect-timeout", "0"),
            ("--connect-timeout", "0.0"),
            ("--connect-timeout", "60.1"),
            ("--max-time", "0"),
            ("--max-time", "300.1"),
        )
        for option, value in invalid_options:
            with self.subTest(option=option, value=value):
                self.curl_capture.unlink(missing_ok=True)
                self.broker_capture.unlink(missing_ok=True)
                rejected = self.run_command(
                    [str(self.script), "/core/info", option, value]
                )
                self.assertEqual(rejected.returncode, 2, rejected.stderr)
                self.assertIn("greater than zero", rejected.stderr)
                self.assertFalse(self.curl_capture.exists())
                self.assertFalse(self.broker_capture.exists())

    def test_caller_cannot_override_request_destination_or_curl_configuration(self) -> None:
        attacks = (
            ["/core/info", "--url", "http://attacker.invalid/collect"],
            ["/core/info", "http://attacker.invalid/collect"],
            ["/core/info", "--request", "DELETE"],
            ["/core/info", "--config", "/tmp/attacker.curlrc"],
            ["/core/info", "-K", "/tmp/attacker.curlrc"],
            ["/core/info", "-H", "Host: attacker.invalid"],
            ["/core/info", "-H", "Authorization: Bearer attacker"],
            ["/core/info", "-d", "@/data/.supervisor/token"],
        )

        for attack in attacks:
            with self.subTest(attack=attack):
                self.curl_capture.unlink(missing_ok=True)
                self.broker_capture.unlink(missing_ok=True)
                completed = self.run_command([str(self.script), *attack])
                self.assertEqual(completed.returncode, 2, completed.stderr)
                self.assertFalse(self.curl_capture.exists())
                self.assertFalse(self.broker_capture.exists())

    def test_full_url_cannot_replace_the_supervisor_path(self) -> None:
        completed = self.run_command([str(self.script), "https://attacker.invalid/collect"])
        self.assertEqual(completed.returncode, 2)
        self.assertIn("path beginning with /", completed.stderr)
        self.assertFalse(self.curl_capture.exists())

    def test_missing_authorization_broker_fails_closed(self) -> None:
        self.fake_broker.chmod(0o600)
        completed = self.run_command([str(self.script), "/core/info"])
        self.assertEqual(completed.returncode, 1)
        self.assertIn("authorization broker is missing", completed.stderr)
        self.assertFalse(self.curl_capture.exists())

    def test_ambiguous_or_normalizing_paths_are_rejected_before_broker_and_curl(self) -> None:
        attacks = (
            "/core/../host/reboot",
            "/core//host/reboot",
            "/core/%2e%2e/host/reboot",
            "/core/%2E%2E/host/reboot",
            "/core/%252e%252e/host/reboot",
            "/host/reboot/",
        )
        for path in attacks:
            with self.subTest(path=path):
                self.curl_capture.unlink(missing_ok=True)
                self.broker_capture.unlink(missing_ok=True)
                completed = self.run_command([str(self.script), "-X", "POST", path])
                self.assertEqual(completed.returncode, 2, completed.stderr)
                self.assertFalse(self.curl_capture.exists())
                self.assertFalse(self.broker_capture.exists())


class HaGuardTests(TemporaryGuardrailTest):
    def setUp(self) -> None:
        super().setUp()
        self.real_capture = self.temp / "real-ha.json"
        self.broker_capture = self.temp / "broker-ha.json"
        self.broker_env_capture = self.temp / "broker-ha-env.txt"
        self.token_file = self.temp / "supervisor-token"
        self.token_file.write_text("trusted-supervisor-token\n", encoding="utf-8")
        self.fake_broker = self.bin_dir / "supervisor-broker"
        self.fake_real = self.bin_dir / "ha-real"
        write_executable(
            self.fake_broker,
            """#!/usr/bin/env python3
import json
import os
import sys
with open(os.environ["BROKER_CAPTURE"], "w", encoding="utf-8") as handle:
    json.dump(sys.argv[1:], handle)
with open(os.environ["BROKER_ENV_CAPTURE"], "w", encoding="utf-8") as handle:
    handle.write(os.environ.get("CODEX_TERMINAL_AGENT_EXECUTION", ""))
""",
        )
        write_executable(
            self.fake_real,
            """#!/usr/bin/env python3
import json
import os
import sys
with open(os.environ["REAL_HA_CAPTURE"], "w", encoding="utf-8") as handle:
    json.dump({
        "argv": sys.argv[1:],
        "endpoint_env": os.environ.get("SUPERVISOR_ENDPOINT"),
        "config_env": os.environ.get("SUPERVISOR_CONFIG"),
        "log_env": os.environ.get("SUPERVISOR_LOG_LEVEL"),
        "token": os.environ.get("SUPERVISOR_TOKEN"),
    }, handle)
""",
        )
        self.script = instrument_script(
            HA_GUARD,
            self.temp / "ha",
            {
                'BROKER="/data/packages/guard/bin/supervisor-broker"': f'BROKER="{self.fake_broker}"',
                'REAL_HA="/usr/libexec/codex-terminal/ha-real"': f'REAL_HA="{self.fake_real}"',
                'TOKEN_FILE="/data/.supervisor/token"': f'TOKEN_FILE="{self.token_file}"',
            },
        )
        self.env.update(
            {
                "BROKER_CAPTURE": str(self.broker_capture),
                "BROKER_ENV_CAPTURE": str(self.broker_env_capture),
                "REAL_HA_CAPTURE": str(self.real_capture),
            }
        )

    def test_codex_actor_marker_reaches_the_authorization_broker(self) -> None:
        self.env["CODEX_TERMINAL_AGENT_EXECUTION"] = "1"
        completed = self.run_command([str(self.script), "core", "info"])
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(self.broker_env_capture.read_text(encoding="utf-8"), "1")

    def test_caller_cli_destination_config_token_and_debug_overrides_are_rejected(self) -> None:
        attacks = (
            ["--endpoint", "http://attacker.invalid", "core", "info"],
            ["--endpoint=http://attacker.invalid", "core", "info"],
            ["--config", "/tmp/attacker.yaml", "core", "info"],
            ["--config=/tmp/attacker.yaml", "core", "info"],
            ["--api-token", "stolen", "core", "info"],
            ["--api-token=stolen", "core", "info"],
            ["--log-level", "debug", "core", "info"],
            ["--log-level=debug", "core", "info"],
        )
        for attack in attacks:
            with self.subTest(attack=attack):
                self.real_capture.unlink(missing_ok=True)
                self.broker_capture.unlink(missing_ok=True)
                completed = self.run_command([str(self.script), *attack])
                self.assertEqual(completed.returncode, 2, completed.stderr)
                self.assertFalse(self.real_capture.exists())
                self.assertFalse(self.broker_capture.exists())

    def test_environment_and_home_config_cannot_redirect_or_enable_token_logging(self) -> None:
        home = self.temp / "home"
        home.mkdir()
        (home / ".homeassistant.yaml").write_text(
            "endpoint: http://attacker.invalid\nlog-level: debug\napi-token: attacker\n",
            encoding="utf-8",
        )
        self.env.update(
            {
                "HOME": str(home),
                "SUPERVISOR_ENDPOINT": "http://attacker.invalid",
                "SUPERVISOR_CONFIG": str(home / ".homeassistant.yaml"),
                "SUPERVISOR_LOG_LEVEL": "debug",
                "SUPERVISOR_API_TOKEN": "attacker",
                "SUPERVISOR_TOKEN": "caller-token",
            }
        )

        completed = self.run_command([str(self.script), "core", "info"])

        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(json.loads(self.broker_capture.read_text()), ["ha", "core", "info"])
        capture = json.loads(self.real_capture.read_text())
        self.assertEqual(
            capture["argv"],
            ["--endpoint", "supervisor", "--config", "/dev/null", "--log-level", "warn", "core", "info"],
        )
        self.assertIsNone(capture["endpoint_env"])
        self.assertIsNone(capture["config_env"])
        self.assertIsNone(capture["log_env"])
        self.assertEqual(capture["token"], "trusted-supervisor-token")

    def test_missing_authorization_broker_never_invokes_real_cli(self) -> None:
        self.fake_broker.chmod(0o600)
        completed = self.run_command([str(self.script), "core", "info"])
        self.assertEqual(completed.returncode, 1)
        self.assertIn("authorization broker is missing", completed.stderr)
        self.assertFalse(self.real_capture.exists())

    def test_missing_managed_token_never_invokes_broker_or_real_cli(self) -> None:
        self.token_file.unlink()
        self.env["SUPERVISOR_TOKEN"] = "caller-token"
        completed = self.run_command([str(self.script), "core", "info"])
        self.assertEqual(completed.returncode, 1)
        self.assertIn("managed Supervisor token is unavailable", completed.stderr)
        self.assertFalse(self.broker_capture.exists())
        self.assertFalse(self.real_capture.exists())

class SupervisorBrokerTests(TemporaryGuardrailTest):
    def setUp(self) -> None:
        super().setUp()
        self.conf_file = self.temp / "broker.conf"
        self.confirm_dir = self.temp / "confirm"
        self.audit_log = self.temp / "broker.log"
        self.conf_file.write_text(
            'SUPERVISOR_BROKER_COMMA_DISPATCH_ENABLED="false"\n',
            encoding="utf-8",
        )
        self.script = instrument_script(
            SUPERVISOR_BROKER,
            self.temp / "supervisor-broker",
            {
                'CONF_FILE="/data/.supervisor/broker.conf"': f'CONF_FILE="{self.conf_file}"',
                'CONFIRM_DIR="/data/.supervisor/confirm"': f'CONFIRM_DIR="{self.confirm_dir}"',
                'AUDIT_LOG="/data/logs/supervisor-broker.log"': f'AUDIT_LOG="{self.audit_log}"',
            },
        )
        write_executable(
            self.bin_dir / "date",
            """#!/bin/sh
case "${1:-}" in
    -Iseconds) printf '%s\n' '2026-07-14T12:00:00-05:00' ;;
    *) exec /bin/date "$@" ;;
esac
""",
        )
        write_executable(
            self.bin_dir / "sha256sum",
            """#!/usr/bin/env python3
import hashlib
import sys
print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest(), " -")
""",
        )

    def run_in_tmux_pty(
        self,
        arguments: list[str],
        *,
        lane: str = "raw",
        pane_matches: bool = True,
        pane_pid: int | None = None,
        stdin_is_tty: bool = True,
        stdout_is_tty: bool = True,
        extra_env: dict[str, str] | None = None,
    ) -> subprocess.CompletedProcess[str]:
        master_fd, slave_fd = os.openpty()
        expected_pane_id = {"primary": "%0", "raw": "%7", "other": "%9"}[lane]
        displayed_primary_pane_id = "%8" if lane == "primary" and not pane_matches else "%0"
        displayed_raw_pane_id = "%8" if lane == "raw" and not pane_matches else "%7"
        expected_pane_pid = pane_pid if pane_pid is not None else os.getpid()
        write_executable(
            self.bin_dir / "tmux",
            """#!/bin/sh
target=""
while [ "$#" -gt 0 ]; do
    if [ "$1" = "-t" ]; then
        target="${2:-}"
        break
    fi
    shift
done
case "$target" in
    codex-terminal:0.0) printf '%s|%s\n' "${EXPECTED_PRIMARY_PANE_ID}" "${EXPECTED_PANE_PID}" ;;
    codex-terminal:raw-shell.0) printf '%s|%s\n' "${EXPECTED_RAW_PANE_ID}" "${EXPECTED_PANE_PID}" ;;
    *) exit 1 ;;
esac
""",
        )
        env = {
            **self.env,
            "CODEX_TERMINAL_HUMAN_SHELL": "1",
            "TMUX_PANE": expected_pane_id,
            "EXPECTED_PRIMARY_PANE_ID": displayed_primary_pane_id,
            "EXPECTED_RAW_PANE_ID": displayed_raw_pane_id,
            "EXPECTED_PANE_PID": str(expected_pane_pid),
            **(extra_env or {}),
        }
        try:
            # Queue a wrong confirmation answer. A verified human pane never
            # consumes it; a provenance mismatch reaches the old challenge and
            # fails promptly instead of hanging the test.
            os.write(master_fd, b"no\n")
            stdin_options = {"stdin": slave_fd} if stdin_is_tty else {"input": "no\n"}
            return subprocess.run(
                [str(self.script), *arguments],
                check=False,
                stdout=slave_fd if stdout_is_tty else subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                env=env,
                timeout=5,
                **stdin_options,
            )
        finally:
            os.close(master_fd)
            os.close(slave_fd)

    def test_safe_get_remains_noninteractive(self) -> None:
        completed = self.run_command([str(self.script), "rest", "GET", "/core/api/states"])
        self.assertEqual(completed.returncode, 0, completed.stderr)

    def test_service_and_state_writes_require_confirmation(self) -> None:
        writes = (
            "/core/api/services/light/turn_on",
            "/core/api/services/homeassistant/restart",
            "/core/api/states/sensor.demo",
        )
        for path in writes:
            with self.subTest(path=path):
                completed = self.run_command([str(self.script), "rest", "POST", path])
                self.assertEqual(completed.returncode, 1)
                self.assertIn("Refusing non-interactive", completed.stderr)

    def test_high_risk_path_with_query_still_requires_high_risk_confirmation(self) -> None:
        completed = self.run_command(
            [str(self.script), "rest", "POST", "/host/reboot?source=integration-test"]
        )
        self.assertEqual(completed.returncode, 1)
        self.assertIn("high-risk", completed.stderr)

    def test_ambiguous_rest_paths_fail_closed_as_high_risk(self) -> None:
        for path in (
            "/core/../host/reboot",
            "/core//host/reboot",
            "/core/%2e%2e/host/reboot",
        ):
            with self.subTest(path=path):
                completed = self.run_command([str(self.script), "rest", "POST", path])
                self.assertEqual(completed.returncode, 1)
                self.assertIn("high-risk", completed.stderr)

    def test_prompt_text_in_tmux_cannot_spoof_authorization(self) -> None:
        path = "/core/api/services/automation/reload"
        self.conf_file.write_text(
            '',
            encoding="utf-8",
        )
        write_executable(
            self.bin_dir / "tmux",
            f"""#!/bin/sh
printf '%s\n' '> ,, supervisor-api -X POST {path}'
""",
        )

        completed = self.run_command([str(self.script), "rest", "POST", path])
        self.assertEqual(completed.returncode, 1, completed.stderr)
        self.assertIn("Refusing non-interactive", completed.stderr)

    def test_spoofed_human_shell_environment_does_not_bypass_high_risk_confirmation(self) -> None:
        self.env["CODEX_TERMINAL_HUMAN_SHELL"] = "1"
        completed = self.run_command([str(self.script), "rest", "POST", "/host/reboot"])
        self.assertEqual(completed.returncode, 1, completed.stderr)
        self.assertIn("high-risk", completed.stderr)

    def test_verified_human_tmux_pane_skips_duplicate_management_confirmation(self) -> None:
        for arguments in (
            ["ha", "core", "restart"],
            ["ha", "apps", "update", "demo"],
            ["rest", "POST", "/host/reboot"],
        ):
            with self.subTest(arguments=arguments):
                completed = self.run_in_tmux_pty(arguments)
                self.assertEqual(completed.returncode, 0, completed.stderr)
                self.assertNotIn("Type exactly", completed.stderr)

        audit = self.audit_log.read_text(encoding="utf-8")
        self.assertEqual(audit.count("reason=human-terminal"), 3)

    def test_human_marker_with_wrong_tmux_pane_id_does_not_bypass(self) -> None:
        completed = self.run_in_tmux_pty(
            ["ha", "apps", "update", "demo"],
            pane_matches=False,
        )
        self.assertEqual(completed.returncode, 1, completed.stderr)
        self.assertIn("Confirmation did not match", completed.stderr)

    def test_human_marker_from_another_process_session_does_not_bypass(self) -> None:
        detached = subprocess.Popen(
            ["sleep", "5"],
            start_new_session=True,
        )
        try:
            completed = self.run_in_tmux_pty(
                ["ha", "apps", "update", "demo"],
                pane_pid=detached.pid,
            )
        finally:
            detached.kill()
            detached.wait(timeout=5)
        self.assertEqual(completed.returncode, 1, completed.stderr)
        self.assertIn("Confirmation did not match", completed.stderr)

    def test_human_marker_from_an_unregistered_tmux_pane_does_not_bypass(self) -> None:
        completed = self.run_in_tmux_pty(
            ["ha", "apps", "update", "demo"],
            lane="other",
        )
        self.assertEqual(completed.returncode, 1, completed.stderr)
        self.assertIn("Confirmation did not match", completed.stderr)

    def test_verified_human_pane_survives_stdout_redirection(self) -> None:
        completed = self.run_in_tmux_pty(
            ["ha", "apps", "update", "demo"],
            stdout_is_tty=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertNotIn("Type exactly", completed.stderr)

    def test_verified_human_pane_survives_stdin_pipeline(self) -> None:
        completed = self.run_in_tmux_pty(
            ["ha", "apps", "update", "demo"],
            stdin_is_tty=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertNotIn("Type exactly", completed.stderr)

    def test_verified_human_pane_survives_all_standard_streams_redirected(self) -> None:
        completed = self.run_in_tmux_pty(
            ["ha", "core", "restart"],
            stdin_is_tty=False,
            stdout_is_tty=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertNotIn("Refusing non-interactive", completed.stderr)
        self.assertNotIn("Type exactly", completed.stderr)

    def test_session_picker_primary_pane_is_a_registered_human_lane(self) -> None:
        completed = self.run_in_tmux_pty(
            ["ha", "core", "restart"],
            lane="primary",
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertNotIn("Type exactly", completed.stderr)

    def test_codex_child_delegates_to_native_approval_policy_without_second_prompt(self) -> None:
        self.env["CODEX_TERMINAL_AGENT_EXECUTION"] = "1"
        for arguments in (
            ["ha", "apps", "update", "demo"],
            ["rest", "POST", "/host/reboot"],
        ):
            with self.subTest(arguments=arguments):
                completed = self.run_command([str(self.script), *arguments])
                self.assertEqual(completed.returncode, 0, completed.stderr)
                self.assertNotIn("Refusing non-interactive", completed.stderr)

        audit = self.audit_log.read_text(encoding="utf-8")
        self.assertEqual(audit.count("reason=codex-approval-policy"), 2)

    def test_codex_identity_wins_if_a_child_also_inherits_the_human_marker(self) -> None:
        completed = self.run_in_tmux_pty(
            ["ha", "apps", "update", "demo"],
            extra_env={"CODEX_TERMINAL_AGENT_EXECUTION": "1"},
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        audit = self.audit_log.read_text(encoding="utf-8")
        self.assertIn("reason=codex-approval-policy", audit)
        self.assertNotIn("reason=human-terminal", audit)

    def test_destructive_cli_aliases_and_nested_store_commands_are_tier_two(self) -> None:
        commands = (
            ("app", "install", "demo"),
            ("ad", "i", "demo"),
            ("addon", "uninstall", "demo"),
            ("apps", "del", "demo"),
            ("add-on", "install", "demo"),
            ("add-ons", "uninstall", "demo"),
            ("store", "apps", "install", "demo"),
            ("store", "addons", "uninst", "demo"),
            ("os", "boot-slot", "B"),
            ("hassos", "boot", "B"),
            ("ho", "rb"),
            ("host", "sh"),
            ("hassos", "data", "move", "/dev/sdb"),
            ("os", "down"),
            ("super", "up"),
            ("shop", "apps", "install", "demo"),
            ("stor", "app", "i", "demo"),
            ("snapshot", "restore", "backup-id"),
            ("sn", "rm", "backup-id"),
        )
        for arguments in commands:
            with self.subTest(arguments=arguments):
                completed = self.run_command([str(self.script), "ha", *arguments])
                self.assertEqual(completed.returncode, 1, completed.stderr)
                self.assertIn("high-risk", completed.stderr)

    def test_read_only_cli_aliases_do_not_prompt(self) -> None:
        commands = (
            ("info",),
            ("available-updates",),
            ("core", "lg"),
            ("apps", "status"),
            ("os", "inf"),
            ("core", "validate"),
        )
        for arguments in commands:
            with self.subTest(arguments=arguments):
                completed = self.run_command([str(self.script), "ha", *arguments])
                self.assertEqual(completed.returncode, 0, completed.stderr)

    def test_host_update_alias_remains_management_tier_not_reboot_tier(self) -> None:
        completed = self.run_command([str(self.script), "ha", "host", "update"])
        self.assertEqual(completed.returncode, 1)
        self.assertIn("management operation", completed.stderr)
        self.assertNotIn("high-risk", completed.stderr)


class HaWebSocketTests(TemporaryGuardrailTest):
    def setUp(self) -> None:
        super().setUp()
        self.capture = self.temp / "ha-ws-request.json"
        self.env["SUPERVISOR_TOKEN"] = "test-supervisor-token"
        self.env["HA_WS_TEST_CAPTURE"] = str(self.capture)
        self.env["PYTHONPATH"] = str(self.temp)
        (self.temp / "aiohttp.py").write_text(
            """import json
import os


class FakeWebSocket:
    def __init__(self):
        self.responses = [
            {"type": "auth_required"},
            {"type": "auth_ok"},
        ]

    async def __aenter__(self):
        return self

    async def __aexit__(self, _exc_type, _exc, _traceback):
        return False

    async def send_json(self, payload):
        if "id" not in payload:
            return
        with open(os.environ["HA_WS_TEST_CAPTURE"], "w", encoding="utf-8") as handle:
            json.dump(payload, handle)
        if payload["type"] == "ping":
            self.responses.append({"id": 1, "type": "pong"})
        else:
            self.responses.append({"id": 1, "success": True, "result": {"ok": True}})

    async def receive_json(self):
        return self.responses.pop(0)


class ClientSession:
    async def __aenter__(self):
        return self

    async def __aexit__(self, _exc_type, _exc, _traceback):
        return False

    def ws_connect(self, _url, heartbeat=30):
        return FakeWebSocket()
""",
            encoding="utf-8",
        )

    def run_ha_ws(self, *arguments: str) -> subprocess.CompletedProcess[str]:
        return self.run_command([sys.executable, str(HA_WS), *arguments])

    def test_raw_payload_cannot_override_request_identity(self) -> None:
        for payload in ('{"type":"call_service"}', '{"id":99}'):
            with self.subTest(payload=payload):
                self.capture.unlink(missing_ok=True)
                completed = self.run_ha_ws("raw", "ping", payload)
                self.assertEqual(completed.returncode, 1)
                self.assertIn("reserved request key", completed.stderr)
                self.assertFalse(self.capture.exists())

    def test_raw_payload_rejects_keys_not_defined_for_that_command(self) -> None:
        completed = self.run_ha_ws("raw", "get_states", '{"target":{}}')
        self.assertEqual(completed.returncode, 1)
        self.assertIn("not allowed for get_states", completed.stderr)
        self.assertFalse(self.capture.exists())

    def test_raw_type_must_be_read_only(self) -> None:
        completed = self.run_ha_ws("raw", "call_service", "{}")
        self.assertEqual(completed.returncode, 1)
        self.assertIn("read-only allowlist", completed.stderr)
        self.assertFalse(self.capture.exists())

    def test_legitimate_target_query_preserves_server_owned_id_and_type(self) -> None:
        payload = {
            "target": {"entity_id": ["light.kitchen"]},
            "expand_group": True,
        }
        completed = self.run_ha_ws(
            "raw",
            "extract_from_target",
            json.dumps(payload),
            "--json",
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(
            json.loads(self.capture.read_text()),
            {"id": 1, "type": "extract_from_target", **payload},
        )

    def test_low_level_request_builder_rejects_reserved_keys(self) -> None:
        namespace = runpy.run_path(str(HA_WS))
        with self.assertRaisesRegex(RuntimeError, "reserved request key"):
            namespace["build_ws_request"]("get_states", {"type": "call_service"})


if __name__ == "__main__":
    unittest.main()
