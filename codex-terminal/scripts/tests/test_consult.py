from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


SCRIPTS = Path(__file__).resolve().parents[1]
CONSULT = SCRIPTS / "consult"


def load_consult():
    """Import the extensionless consult script as a module."""
    spec = importlib.util.spec_from_loader(
        "consult_module",
        importlib.machinery.SourceFileLoader("consult_module", str(CONSULT)),
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


consult = load_consult()


class ConsultantSpecTests(unittest.TestCase):
    def test_every_consultant_is_fully_specified(self) -> None:
        self.assertIn("claude", consult.CONSULTANTS)
        self.assertIn("kimi", consult.CONSULTANTS)
        for agent, spec in consult.CONSULTANTS.items():
            self.assertTrue(spec["label"].strip(), agent)
            self.assertTrue(spec["binary"].strip(), agent)
            self.assertRegex(spec["home_env"], r"^[A-Z][A-Z0-9_]*$")
            self.assertTrue(spec["default_home"].startswith("/data/."), agent)
            self.assertTrue(spec["credential_files"], agent)
            self.assertTrue(spec["auth_helper"].endswith("auth-helper"), agent)
            self.assertTrue(callable(spec["build_args"]), agent)

    def test_claude_copies_account_state_not_just_the_token(self) -> None:
        # A token with no account attached makes Claude report "Not logged in",
        # so the account file must travel with it into the sandbox home.
        files = consult.CONSULTANTS["claude"]["credential_files"]
        self.assertEqual(files[0], ".credentials.json")
        self.assertIn(".claude.json", files)

    def test_home_env_vars_are_distinct(self) -> None:
        home_envs = [spec["home_env"] for spec in consult.CONSULTANTS.values()]
        self.assertEqual(len(home_envs), len(set(home_envs)))

    def test_login_proof_is_the_token_not_a_config_file(self) -> None:
        # Kimi writes config.toml before any sign-in, so only the token in
        # credentials/ can prove a completed login.
        self.assertEqual(consult.CONSULTANTS["kimi"]["login_proof"], "credentials/*.json")
        self.assertIn("credentials", consult.CONSULTANTS["kimi"]["credential_dirs"])
        self.assertEqual(consult.CONSULTANTS["claude"]["login_proof"], ".credentials.json")

    def test_argument_builders_request_read_only_behaviour(self) -> None:
        claude = consult.CONSULTANTS["claude"]["build_args"]("why is this failing?", "", "")
        self.assertEqual(claude[0], "claude")
        self.assertIn("why is this failing?", claude)
        self.assertIn("--permission-mode", claude)
        self.assertIn("dontAsk", claude)
        self.assertIn("--allowedTools", claude)
        self.assertIn("--strict-mcp-config", claude)
        # --bare skips the stored state that carries the login, so a consult
        # using it always fails with "Not logged in".
        self.assertNotIn("--bare", claude)
        # No tool that could modify the config may be offered.
        allowed = claude[claude.index("--allowedTools") + 1]
        for tool in allowed.split(","):
            self.assertIn(tool, {"Read", "Glob", "Grep"})

        kimi = consult.CONSULTANTS["kimi"]["build_args"]("why is this failing?", "", "")
        self.assertEqual(kimi[0], "kimi")
        self.assertIn("--plan", kimi)
        self.assertIn("why is this failing?", kimi)


class ConsultModelSettingsTests(unittest.TestCase):
    def test_model_and_effort_reach_the_command_line(self) -> None:
        claude = consult.CONSULTANTS["claude"]["build_args"]("q", "opus", "high")
        self.assertEqual(claude[claude.index("--model") + 1], "opus")
        self.assertEqual(claude[claude.index("--effort") + 1], "high")

    def test_blank_settings_leave_the_cli_defaults_alone(self) -> None:
        for agent, spec in consult.CONSULTANTS.items():
            args = spec["build_args"]("q", "", "")
            self.assertNotIn("--model", args, agent)
            self.assertNotIn("--effort", args, agent)

    def test_kimi_has_no_effort_flag(self) -> None:
        # Kimi exposes no effort setting; asking for one must not invent a flag.
        self.assertFalse(consult.CONSULTANTS["kimi"]["supports_effort"])
        args = consult.CONSULTANTS["kimi"]["build_args"]("q", "kimi-k2", "high")
        self.assertNotIn("--effort", args)
        self.assertEqual(args[args.index("--model") + 1], "kimi-k2")

    def test_preferences_are_read_per_consultant(self) -> None:
        settings = {"consultants": {"claude": {"model": "sonnet", "effort": "max"}}}
        self.assertEqual(consult.consultant_preferences(settings, "claude"), ("sonnet", "max"))
        self.assertEqual(consult.consultant_preferences(settings, "kimi"), ("", ""))
        self.assertEqual(consult.consultant_preferences({}, "claude"), ("", ""))
        self.assertEqual(consult.consultant_preferences({"consultants": None}, "claude"), ("", ""))

    def test_unsupported_effort_is_rejected(self) -> None:
        with self.assertRaises(consult.ConsultError):
            consult.run_consult("claude", "q", 60, "", "turbo")


class ConsultEnvironmentTests(unittest.TestCase):
    def test_no_provider_credential_reaches_the_consultant(self) -> None:
        polluted = {
            "OPENAI_API_KEY": "sk-openai",
            "ANTHROPIC_API_KEY": "sk-ant",
            "CLAUDE_CODE_OAUTH_TOKEN": "oauth",
            "MOONSHOT_API_KEY": "sk-moon",
            "KIMI_API_KEY": "sk-kimi",
            "SUPERVISOR_TOKEN": "supervisor",
            "GITHUB_PAT_TOKEN": "ghp_x",
            "GH_TOKEN": "ghp_y",
            "TERM": "xterm-256color",
        }
        original = dict(os.environ)
        os.environ.update(polluted)
        try:
            for spec in consult.CONSULTANTS.values():
                env = consult.build_environment(spec, Path("/work/sandbox"))
                for blocked in consult.BLOCKED_ENV:
                    self.assertNotIn(blocked, env, f"{blocked} leaked to {spec['label']}")
                # The consultant's home must point at the throwaway copy so a
                # refreshed token cannot land in the real credential store.
                self.assertEqual(env[spec["home_env"]], "/work/sandbox")
                self.assertEqual(env["HOME"], "/work/sandbox")
                self.assertEqual(env["TMPDIR"], "/work/sandbox")
                self.assertEqual(env["TERM"], "xterm-256color")
        finally:
            os.environ.clear()
            os.environ.update(original)

    def test_claude_environment_disables_self_update(self) -> None:
        env = consult.build_environment(consult.CONSULTANTS["claude"], Path("/work/s"))
        self.assertEqual(env["DISABLE_AUTOUPDATER"], "1")
        self.assertEqual(env["USE_BUILTIN_RIPGREP"], "0")


class ConsultCredentialCopyTests(unittest.TestCase):
    def test_credential_copy_refuses_symlinks(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            secret = root / "real-secret"
            secret.write_text("token")
            link = root / "link"
            link.symlink_to(secret)
            # O_NOFOLLOW must refuse the symlink rather than follow it out.
            self.assertFalse(consult.copy_credential(link, root / "copied"))
            self.assertFalse((root / "copied").exists())

    def test_credential_copy_writes_owner_only(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "creds.json"
            source.write_text('{"token": "abc"}')
            destination = root / "out.json"
            if os.geteuid() != 0:
                # fchown to nobody needs root; the mode is still asserted.
                try:
                    consult.copy_credential(source, destination)
                except PermissionError:
                    self.skipTest("credential chown requires root")
            else:
                consult.copy_credential(source, destination)
            self.assertEqual(destination.read_text(), '{"token": "abc"}')
            self.assertEqual(destination.stat().st_mode & 0o777, 0o600)

    def test_missing_credential_is_not_an_error(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.assertFalse(consult.copy_credential(root / "absent", root / "out"))


class ConsultCliTests(unittest.TestCase):
    def run_consult(self, *args: str, env: dict | None = None) -> subprocess.CompletedProcess[str]:
        merged = dict(os.environ)
        if env:
            merged.update(env)
        return subprocess.run(
            ["python3", str(CONSULT), *args],
            capture_output=True,
            text=True,
            env=merged,
            check=False,
        )

    def test_list_json_reports_every_consultant(self) -> None:
        result = self.run_consult("--list", "--json")
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        ids = {entry["id"] for entry in payload["consultants"]}
        self.assertEqual(ids, set(consult.CONSULTANTS))
        for entry in payload["consultants"]:
            self.assertIn("installed", entry)
            self.assertIn("signedIn", entry)
            self.assertIn("authHelper", entry)

    def test_unsigned_consultant_explains_how_to_set_it_up(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            result = self.run_consult(
                "--agent", "claude", "does this look right?",
                env={"CLAUDE_CONFIG_DIR": directory},
            )
            self.assertEqual(result.returncode, 2)
            self.assertIn("not set up yet", result.stderr)
            self.assertIn("claude-auth-helper", result.stderr)

    def test_empty_question_is_rejected(self) -> None:
        result = self.run_consult("--agent", "claude", "   ")
        self.assertEqual(result.returncode, 2)
        self.assertIn("No question", result.stderr)

    def test_unknown_agent_is_rejected(self) -> None:
        result = self.run_consult("--agent", "gemini", "hello")
        self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()


class ConsultReadinessTests(unittest.TestCase):
    """A token is not the same as being able to answer."""

    def test_kimi_needs_a_model_not_just_a_token(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            (home / "config.toml").write_text("default_yolo = true\n")
            ready, note = consult.kimi_ready(home)
            self.assertFalse(ready)
            self.assertIn("no model is configured", note)

    def test_kimi_is_ready_once_a_model_exists(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            (home / "config.toml").write_text('default_model = "kimi-k2"\n')
            self.assertEqual(consult.kimi_ready(home), (True, ""))

    def test_kimi_is_ready_with_a_providers_table(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            (home / "config.toml").write_text('[providers.kimi]\nurl = "https://example.invalid"\n')
            ready, _ = consult.kimi_ready(home)
            self.assertTrue(ready)

    def test_missing_config_is_reported_not_crashed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            ready, note = consult.kimi_ready(Path(directory))
            self.assertFalse(ready)
            self.assertTrue(note)

    def test_claude_needs_no_extra_configuration(self) -> None:
        self.assertEqual(consult.always_ready(Path("/nonexistent")), (True, ""))
