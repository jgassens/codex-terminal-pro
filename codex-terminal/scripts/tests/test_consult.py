from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock


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
            self.assertIsInstance(spec["uid"], int, agent)
            self.assertIsInstance(spec["gid"], int, agent)
            self.assertRegex(spec["home_env"], r"^[A-Z][A-Z0-9_]*$")
            self.assertTrue(spec["default_home"].startswith("/data/."), agent)
            self.assertTrue(spec["credential_files"], agent)
            self.assertTrue(spec["auth_helper"].endswith("auth-helper"), agent)
            self.assertTrue(callable(spec["build_args"]), agent)

    def test_consultants_have_distinct_fixed_identities(self) -> None:
        identities = {(spec["uid"], spec["gid"]) for spec in consult.CONSULTANTS.values()}
        self.assertEqual(len(identities), len(consult.CONSULTANTS))
        self.assertEqual(
            (consult.CONSULTANTS["claude"]["uid"], consult.CONSULTANTS["claude"]["gid"]),
            (61001, 61001),
        )
        self.assertEqual(
            (consult.CONSULTANTS["kimi"]["uid"], consult.CONSULTANTS["kimi"]["gid"]),
            (61002, 61002),
        )

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
        self.assertIn("why is this failing?", kimi)
        # Kimi rejects --plan alongside --prompt; the uid drop is what makes
        # a consult read-only, so the flag is not needed.
        self.assertNotIn("--plan", kimi)


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

    def test_kimi_carries_effort_through_config_not_a_flag(self) -> None:
        # Kimi supports effort, but only as a model-table setting: inventing
        # a --effort flag would just make the CLI reject the call.
        spec = consult.CONSULTANTS["kimi"]
        self.assertTrue(spec["supports_effort"])
        self.assertTrue(callable(spec["effort_via_config"]))
        args = spec["build_args"]("q", "kimi-k2", "high")
        self.assertNotIn("--effort", args)
        self.assertNotIn("--plan", args)
        self.assertEqual(args[args.index("--model") + 1], "kimi-k2")

    def test_claude_carries_effort_on_the_command_line(self) -> None:
        spec = consult.CONSULTANTS["claude"]
        self.assertTrue(spec["supports_effort"])
        self.assertIsNone(spec["effort_via_config"])

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
            self.assertFalse(
                consult.copy_credential(link, root / "copied", os.geteuid(), os.getegid())
            )
            self.assertFalse((root / "copied").exists())

    def test_credential_copy_writes_owner_only(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "creds.json"
            source.write_text('{"token": "abc"}')
            destination = root / "out.json"
            consult.copy_credential(source, destination, os.geteuid(), os.getegid())
            self.assertEqual(destination.read_text(), '{"token": "abc"}')
            self.assertEqual(destination.stat().st_mode & 0o777, 0o600)

    def test_credential_copy_handles_short_reads_and_writes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "creds.json"
            destination = root / "out.json"
            expected = b'{"token":"partial-io-must-not-truncate"}'
            source.write_bytes(expected)
            real_read = os.read
            real_write = os.write

            def short_read(fd: int, size: int) -> bytes:
                return real_read(fd, min(size, 3))

            def short_write(fd: int, payload) -> int:
                return real_write(fd, payload[:2])

            with mock.patch.object(consult.os, "read", side_effect=short_read), \
                    mock.patch.object(consult.os, "write", side_effect=short_write):
                consult.copy_credential(
                    source, destination, os.geteuid(), os.getegid()
                )
            self.assertEqual(destination.read_bytes(), expected)

    def test_credential_copy_rejects_content_over_the_bound(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "creds.json"
            destination = root / "out.json"
            source.write_bytes(b"x" * (consult.MAX_CREDENTIAL_BYTES + 1))
            with self.assertRaisesRegex(consult.ConsultError, "larger than expected"):
                consult.copy_credential(
                    source, destination, os.geteuid(), os.getegid()
                )
            self.assertFalse(destination.exists())

    def test_missing_credential_is_not_an_error(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.assertFalse(
                consult.copy_credential(root / "absent", root / "out", 61001, 61001)
            )


class ConsultWorkspaceProjectionTests(unittest.TestCase):
    def test_projection_excludes_secret_stores_and_redacts_inline_values(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "config"
            target = root / "projection"
            (source / ".storage").mkdir(parents=True)
            (source / "automations").mkdir()
            (source / "configuration.yaml").write_text(
                "demo_token: github_pat_abcdefghijklmnopqrstuvwxyz123456\n"
                "ordinary: visible\n",
                encoding="utf-8",
            )
            (source / "secrets.yaml").write_text("password: actual-secret\n")
            (source / ".storage" / "auth").write_text("root-token")
            (source / "automations" / "safe.yaml").write_text("alias: Lamp\n")
            outside = root / "outside"
            outside.write_text("do-not-follow")
            (source / "linked.yaml").symlink_to(outside)

            result = consult.build_filtered_workspace(source, target)

            self.assertEqual(result["files"], 2)
            projected = (target / "configuration.yaml").read_text()
            self.assertIn("ordinary: visible", projected)
            self.assertNotIn("github_pat_", projected)
            self.assertIn("[redacted]", projected)
            self.assertFalse((target / "secrets.yaml").exists())
            self.assertFalse((target / ".storage").exists())
            self.assertFalse((target / "linked.yaml").exists())
            self.assertEqual((target / "automations" / "safe.yaml").read_text(), "alias: Lamp\n")
            self.assertEqual((target / "configuration.yaml").stat().st_mode & 0o777, 0o444)
            self.assertEqual((target / "automations").stat().st_mode & 0o777, 0o555)

    def test_projection_skips_binary_and_oversized_files(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "config"
            target = root / "projection"
            source.mkdir()
            (source / "binary.yaml").write_bytes(b"safe\x00secret")
            (source / "large.yaml").write_bytes(b"x" * (consult.MAX_WORKSPACE_FILE_BYTES + 1))

            result = consult.build_filtered_workspace(source, target)

            self.assertEqual(result, {"files": 0, "bytes": 0})

    def test_projection_skips_hardlinks_that_can_alias_a_blocked_secret(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "config"
            target = root / "projection"
            source.mkdir()
            secret = source / "secrets.yaml"
            secret.write_text("innocent_name: actual-secret\n", encoding="utf-8")
            os.link(secret, source / "safe-looking.yaml")

            result = consult.build_filtered_workspace(source, target)

            self.assertEqual(result, {"files": 0, "bytes": 0})
            self.assertFalse((target / "safe-looking.yaml").exists())

    def test_landlock_abi_masks_include_write_denials(self) -> None:
        abi_one = consult.landlock_handled_access(1)
        abi_three = consult.landlock_handled_access(3)
        self.assertTrue(abi_one & consult.LANDLOCK_ACCESS_FS_WRITE_FILE)
        self.assertFalse(abi_one & consult.LANDLOCK_ACCESS_FS_TRUNCATE)
        self.assertTrue(abi_three & consult.LANDLOCK_ACCESS_FS_TRUNCATE)


class ConsultSandboxBaseTests(unittest.TestCase):
    def test_sandbox_base_refuses_a_symlink(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "target"
            target.mkdir(mode=0o700)
            link = root / "consult"
            link.symlink_to(target)
            original_base = consult.SANDBOX_BASE
            consult.SANDBOX_BASE = str(link)
            try:
                with self.assertRaisesRegex(consult.ConsultError, "real root-owned"):
                    consult.ensure_sandbox_base()
            finally:
                consult.SANDBOX_BASE = original_base
            self.assertEqual(target.stat().st_mode & 0o777, 0o700)

    def test_sandbox_base_refuses_an_unprivileged_owner(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory) / "consult"
            base.mkdir(mode=0o711)
            base.chmod(0o711)
            if os.geteuid() == 0:
                os.chown(base, 65534, 65534)
            original_base = consult.SANDBOX_BASE
            consult.SANDBOX_BASE = str(base)
            try:
                with self.assertRaisesRegex(consult.ConsultError, "real root-owned"):
                    consult.ensure_sandbox_base()
            finally:
                consult.SANDBOX_BASE = original_base

    @unittest.skipUnless(os.geteuid() == 0, "root-owned sandbox creation requires root")
    def test_sandbox_base_creates_the_expected_root_owned_directory(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory) / "consult"
            original_base = consult.SANDBOX_BASE
            consult.SANDBOX_BASE = str(base)
            try:
                self.assertEqual(consult.ensure_sandbox_base(), base)
            finally:
                consult.SANDBOX_BASE = original_base
            info = base.lstat()
            self.assertEqual((info.st_uid, info.st_gid), (0, 0))
            self.assertEqual(info.st_mode & 0o777, 0o711)


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
            root = Path(directory)
            config_dir = root / "config"
            config_dir.mkdir()
            bin_dir = root / "bin"
            bin_dir.mkdir()
            invoked = root / "claude-invoked"
            fake_claude = bin_dir / "claude"
            fake_claude.write_text(
                "#!/bin/sh\nprintf 'invoked\\n' > \"$FAKE_CLAUDE_INVOKED\"\nexit 99\n",
                encoding="utf-8",
            )
            fake_claude.chmod(0o755)
            result = self.run_consult(
                "--agent", "claude", "does this look right?",
                env={
                    "CLAUDE_CONFIG_DIR": str(config_dir),
                    "FAKE_CLAUDE_INVOKED": str(invoked),
                    "PATH": f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}",
                },
            )
            self.assertEqual(result.returncode, 2)
            self.assertIn("not set up yet", result.stderr)
            self.assertIn("claude-auth-helper", result.stderr)
            self.assertFalse(invoked.exists(), "unsigned consultant must not be executed")

    def test_empty_question_is_rejected(self) -> None:
        result = self.run_consult("--agent", "claude", "   ")
        self.assertEqual(result.returncode, 2)
        self.assertIn("No question", result.stderr)

    def test_unknown_agent_is_rejected(self) -> None:
        result = self.run_consult("--agent", "gemini", "hello")
        self.assertNotEqual(result.returncode, 0)


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


class ConsultModelListingTests(unittest.TestCase):
    def test_claude_offers_its_documented_aliases(self) -> None:
        models = consult.CONSULTANTS["claude"]["list_models"](Path("/nonexistent"))
        for alias in ("opus", "sonnet", "haiku", "fable"):
            self.assertIn(alias, models)

    def test_kimi_lists_only_configured_models(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            (home / "config.toml").write_text(
                'default_model = "k2-turbo"\n\n[models.k2]\nprovider = "kimi"\n'
            )
            models = consult.CONSULTANTS["kimi"]["list_models"](home)
            self.assertEqual(models, ["k2", "k2-turbo"])

    def test_kimi_lists_nothing_before_sign_in_registers_models(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            (home / "config.toml").write_text("default_yolo = true\n")
            self.assertEqual(consult.CONSULTANTS["kimi"]["list_models"](home), [])
            self.assertEqual(consult.CONSULTANTS["kimi"]["list_models"](Path("/nonexistent")), [])


class KimiAuthHelperTests(unittest.TestCase):
    """The helper must recognise Kimi's real layout and the half-signed state."""

    HELPER = SCRIPTS / "kimi-auth-helper.sh"

    def source_helper(self, home: Path, snippet: str) -> str:
        script = (
            f'KIMI_CODE_HOME="{home}"\n'
            f'. "{self.HELPER}" >/dev/null 2>&1 || true\n'
            f'{snippet}\n'
        )
        result = subprocess.run(
            ["bash", "-c", script], capture_output=True, text=True, check=False,
            env={**os.environ, "KIMI_AUTH_HELPER_NO_MAIN": "1"},
        )
        return result.stdout.strip()

    def test_helper_targets_the_credentials_directory(self) -> None:
        text = self.HELPER.read_text(encoding="utf-8")
        # The single-file path was a guess and never existed.
        self.assertNotIn('AUTH_FILE="$KIMI_CODE_HOME/credentials.json"', text)
        self.assertIn('CRED_DIR="$KIMI_CODE_HOME/credentials"', text)

    def test_helper_tightens_the_credentials_directory_mode(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory) / "kimi"
            credentials = home / "credentials"
            credentials.mkdir(parents=True)
            credentials.chmod(0o777)

            self.source_helper(home, "ensure_kimi_home")

            self.assertEqual(credentials.stat().st_mode & 0o777, 0o700)

    def test_login_tightens_a_recreated_credentials_directory(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            home = root / "kimi"
            credentials = home / "credentials"
            credentials.mkdir(parents=True)
            (credentials / "stale.json").write_text("{}")
            fake_bin = root / "bin"
            fake_bin.mkdir()
            fake_kimi = fake_bin / "kimi"
            fake_kimi.write_text(
                "#!/bin/sh\n"
                'mkdir -p "$KIMI_CODE_HOME/credentials"\n'
                'chmod 0777 "$KIMI_CODE_HOME/credentials"\n'
                'printf "{}" > "$KIMI_CODE_HOME/credentials/new.json"\n'
                'chmod 0666 "$KIMI_CODE_HOME/credentials/new.json"\n',
                encoding="utf-8",
            )
            fake_kimi.chmod(0o755)
            env = {
                **os.environ,
                "KIMI_AUTH_HELPER_NO_MAIN": "1",
                "KIMI_CODE_HOME": str(home),
                "PATH": f"{fake_bin}{os.pathsep}{os.environ.get('PATH', '')}",
            }

            result = subprocess.run(
                ["bash", "-c", '. "$1"; device_login', "test", str(self.HELPER)],
                input="\n\n",
                capture_output=True,
                text=True,
                check=False,
                env=env,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(credentials.stat().st_mode & 0o777, 0o700)
            self.assertEqual((credentials / "new.json").stat().st_mode & 0o777, 0o600)
            self.assertTrue(list(home.glob("credentials.superseded-*")))

    def test_helper_offers_to_clear_a_half_finished_sign_in(self) -> None:
        text = self.HELPER.read_text(encoding="utf-8")
        self.assertIn("has_token && ! has_model", text)
        self.assertIn("superseded-", text)

    def test_model_detection_matches_configured_forms(self) -> None:
        text = self.HELPER.read_text(encoding="utf-8")
        for form in ("default_model", r"\[models", r"\[providers"):
            self.assertIn(form, text)


class ConsultPromptFramingTests(unittest.TestCase):
    """A consultant cannot see its own invocation unless told."""

    def test_model_and_effort_are_stated_to_the_consultant(self) -> None:
        framed = consult.framed_prompt(
            consult.CONSULTANTS["claude"], "why is this failing?", "opus", "high"
        )
        self.assertIn('the model "opus"', framed)
        self.assertIn('reasoning effort "high"', framed)
        self.assertIn("why is this failing?", framed)
        # The override must be called out, since the config says otherwise.
        self.assertIn("overrides any default", framed)

    def test_only_what_was_set_is_stated(self) -> None:
        # Model alone, with no effort chosen, must not imply an effort.
        framed = consult.framed_prompt(
            consult.CONSULTANTS["kimi"], "question", "kimi-code/k3", ""
        )
        self.assertIn('the model "kimi-code/k3"', framed)
        self.assertNotIn("reasoning effort", framed)

    def test_every_consult_warns_against_reading_credentials(self) -> None:
        for spec in consult.CONSULTANTS.values():
            framed = consult.framed_prompt(spec, "plain question", "", "")
            self.assertIn("Do not open, quote, or report secrets.yaml", framed)
            self.assertTrue(framed.endswith("plain question"))


class KimiEffortTests(unittest.TestCase):
    """Kimi's effort is a model-table setting, not a command-line flag."""

    K3 = (
        '\n[models."kimi-code/k3"]\n'
        'provider = "managed:kimi-code"\n'
        'model = "k3"\n'
        'max_context_size = 1048576\n'
        'capabilities = ["thinking", "tool_use"]\n'
        'display_name = "K3"\n'
        'support_efforts = ["low", "high", "max"]\n'
        'default_effort = "high"\n'
    )

    def home_with_k3(self, directory: str) -> Path:
        home = Path(directory)
        (home / "config.toml").write_text('default_model = "kimi-code/k3"\n' + self.K3)
        return home

    def test_effort_levels_come_from_the_chosen_model(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            home = self.home_with_k3(directory)
            self.assertEqual(
                consult.kimi_effort_levels(home, "kimi-code/k3"), ["low", "high", "max"]
            )
            # With no model named, the configured default answers.
            self.assertEqual(consult.kimi_effort_levels(home), ["low", "high", "max"])

    def test_no_models_yields_no_levels(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(consult.kimi_effort_levels(Path(directory)), [])

    def test_effort_alias_is_added_to_the_sandbox_only(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            sandbox = self.home_with_k3(directory)
            original = (sandbox / "config.toml").read_text()
            alias = consult.kimi_effort_alias(sandbox, "kimi-code/k3", "max")
            self.assertEqual(alias, "consult-max")
            import tomllib
            data = tomllib.loads((sandbox / "config.toml").read_text())
            entry = data["models"][alias]
            self.assertEqual(entry["default_effort"], "max")
            # The alias must otherwise mirror the model it came from.
            self.assertEqual(entry["provider"], "managed:kimi-code")
            self.assertEqual(entry["model"], "k3")
            self.assertEqual(entry["max_context_size"], 1048576)
            self.assertEqual(entry["capabilities"], ["thinking", "tool_use"])
            # The original entry is untouched.
            self.assertIn(original.strip(), (sandbox / "config.toml").read_text())

    def test_unsupported_effort_is_refused_with_the_real_options(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            sandbox = self.home_with_k3(directory)
            with self.assertRaises(consult.ConsultError) as caught:
                consult.kimi_effort_alias(sandbox, "kimi-code/k3", "medium")
            self.assertIn("low, high, max", str(caught.exception))

    def test_toml_values_round_trip(self) -> None:
        import tomllib
        rendered = "\n".join([
            "[t]",
            f"s = {consult.toml_value('a b')}",
            f"n = {consult.toml_value(42)}",
            f"b = {consult.toml_value(True)}",
            f"l = {consult.toml_value(['x', 'y'])}",
            f"q = {consult.toml_value('say \"hi\"')}",
        ])
        parsed = tomllib.loads(rendered)["t"]
        self.assertEqual(parsed, {"s": "a b", "n": 42, "b": True, "l": ["x", "y"], "q": 'say "hi"'})


if __name__ == "__main__":
    unittest.main()
