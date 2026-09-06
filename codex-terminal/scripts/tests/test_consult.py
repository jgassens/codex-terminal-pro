from __future__ import annotations

import importlib.util
import contextlib
import io
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
            self.assertIsInstance(spec["default_model"], str, agent)
            self.assertIsInstance(spec["default_effort"], str, agent)

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
    def resolved_preferences(
        self, agent: str, settings: dict, *flags: str
    ) -> tuple[str, str]:
        with mock.patch.object(consult, "load_settings", return_value=settings), \
                mock.patch.object(consult, "run_consult", return_value=0) as run:
            self.assertEqual(consult.main(["--agent", agent, *flags, "question"]), 0)
        return run.call_args.args[-2:]

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

    def test_blank_codex_preferences_apply_addon_defaults(self) -> None:
        with tempfile.TemporaryDirectory() as directory, mock.patch.dict(
            os.environ, {"CODEX_HOME": directory}
        ):
            model, effort = self.resolved_preferences("codex", {})
        argv = consult.codex_args("question", model, effort)
        self.assertEqual(argv[argv.index("--model") + 1], "gpt-5.6-sol")
        self.assertIn('model_reasoning_effort="max"', argv)

    def test_explicit_codex_preferences_override_addon_defaults(self) -> None:
        with tempfile.TemporaryDirectory() as directory, mock.patch.dict(
            os.environ, {"CODEX_HOME": directory}
        ):
            resolved = self.resolved_preferences(
                "codex", {}, "--model", "gpt-custom", "--effort", "low"
            )
        self.assertEqual(resolved, ("gpt-custom", "low"))

    def test_saved_codex_preferences_override_addon_defaults(self) -> None:
        settings = {
            "consultants": {"codex": {"model": "gpt-saved", "effort": "high"}}
        }
        with tempfile.TemporaryDirectory() as directory, mock.patch.dict(
            os.environ, {"CODEX_HOME": directory}
        ):
            resolved = self.resolved_preferences("codex", settings)
        self.assertEqual(resolved, ("gpt-saved", "high"))

    def test_blank_claude_and_kimi_preferences_stay_blank(self) -> None:
        self.assertEqual(self.resolved_preferences("claude", {}), ("", ""))
        self.assertEqual(self.resolved_preferences("kimi", {}), ("", ""))

    def test_codex_default_is_skipped_when_catalog_does_not_offer_it(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            (home / "models_cache.json").write_text(json.dumps({
                "models": [{
                    "slug": "gpt-account-model",
                    "visibility": "list",
                    "priority": 1,
                    "supported_reasoning_levels": [{"effort": "high"}],
                }]
            }))
            with mock.patch.dict(os.environ, {"CODEX_HOME": directory}):
                resolved = self.resolved_preferences("codex", {})
        self.assertEqual(resolved, ("", ""))

    def test_skipped_codex_default_is_explained_on_stderr(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            (home / "models_cache.json").write_text(json.dumps({
                "models": [
                    {"slug": "gpt-5.6-sol", "visibility": "hide", "priority": 1},
                    {"slug": "gpt-other", "visibility": "list", "priority": 2},
                ]
            }))
            stderr = io.StringIO()
            with mock.patch.dict(os.environ, {"CODEX_HOME": directory}), \
                    contextlib.redirect_stderr(stderr):
                resolved = self.resolved_preferences("codex", {})
        self.assertEqual(resolved, ("", ""))
        self.assertIn("does not list gpt-5.6-sol", stderr.getvalue())

    def test_effort_default_belongs_to_the_default_model_only(self) -> None:
        # A model the user chose keeps the CLI's own effort: forcing max onto
        # gpt-5.5, which stops at xhigh, would make the consult fail.
        settings = {"consultants": {"codex": {"model": "gpt-5.5", "effort": ""}}}
        with tempfile.TemporaryDirectory() as directory, mock.patch.dict(
            os.environ, {"CODEX_HOME": directory}
        ):
            self.assertEqual(self.resolved_preferences("codex", settings), ("gpt-5.5", ""))
            sol = {"consultants": {"codex": {"model": "gpt-5.6-sol", "effort": ""}}}
            self.assertEqual(self.resolved_preferences("codex", sol), ("gpt-5.6-sol", "max"))

    def test_effort_default_is_skipped_when_the_catalog_lacks_it(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            (home / "models_cache.json").write_text(json.dumps({
                "models": [{
                    "slug": "gpt-5.6-sol",
                    "visibility": "list",
                    "priority": 1,
                    "supported_reasoning_levels": [{"effort": "low"}, {"effort": "high"}],
                }]
            }))
            with mock.patch.dict(os.environ, {"CODEX_HOME": directory}):
                resolved = self.resolved_preferences("codex", {})
        self.assertEqual(resolved, ("gpt-5.6-sol", ""))

    def test_codex_fallback_levels_include_every_catalog_level(self) -> None:
        # Without a cache the fallback list must not reject a level the real
        # catalog offers; ultra is the newest.
        with tempfile.TemporaryDirectory() as directory:
            levels = consult.codex_efforts(Path(directory), "gpt-5.6-terra")
        self.assertIn("ultra", levels)
        self.assertIn("max", levels)

    def test_codex_cache_symlinks_and_oversize_files_are_ignored(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            real = home / "elsewhere.json"
            real.write_text(json.dumps({"models": [{"slug": "gpt-linked", "visibility": "list"}]}))
            (home / "models_cache.json").symlink_to(real)
            self.assertEqual(consult.codex_models(home), [])
            (home / "models_cache.json").unlink()
            (home / "models_cache.json").write_text(json.dumps({"models": [{"slug": "gpt-big", "visibility": "list"}]}))
            with mock.patch.object(consult, "CODEX_MODEL_CACHE_MAX_BYTES", 8):
                self.assertEqual(consult.codex_models(home), [])
            self.assertEqual(consult.codex_models(home), ["gpt-big"])

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
            self.assertIn("defaultModel", entry)
            self.assertIn("defaultEffort", entry)
            self.assertIsInstance(entry["defaultModel"], str)
            self.assertIsInstance(entry["defaultEffort"], str)

    def test_list_json_reports_codex_catalog_and_defaults(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            home = root / "codex-home"
            home.mkdir()
            (home / "models_cache.json").write_text(json.dumps({"models": [
                {
                    "slug": "gpt-other",
                    "visibility": "list",
                    "priority": 2,
                    "supported_reasoning_levels": [{"effort": "medium"}],
                },
                {
                    "slug": "gpt-5.6-sol",
                    "visibility": "list",
                    "priority": 1,
                    "supported_reasoning_levels": [
                        {"effort": "low"}, {"effort": "max"}
                    ],
                },
            ]}))
            bin_dir = root / "bin"
            bin_dir.mkdir()
            fake_codex = bin_dir / "codex"
            fake_codex.write_text("#!/bin/sh\nexit 0\n")
            fake_codex.chmod(0o755)

            result = self.run_consult("--list", "--json", env={
                "CODEX_HOME": str(home),
                "PATH": f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}",
            })

        self.assertEqual(result.returncode, 0, result.stderr)
        records = {item["id"]: item for item in json.loads(result.stdout)["consultants"]}
        codex_record = records["codex"]
        self.assertEqual(codex_record["defaultModel"], "gpt-5.6-sol")
        self.assertEqual(codex_record["defaultEffort"], "max")
        self.assertTrue(codex_record["effortDependsOnModel"])
        self.assertEqual(codex_record["models"], ["gpt-5.6-sol", "gpt-other"])
        self.assertEqual(
            codex_record["effortLevelsByModel"],
            {
                "": ["low", "max"],
                "gpt-5.6-sol": ["low", "max"],
                "gpt-other": ["medium"],
            },
        )
        for agent in ("claude", "kimi"):
            self.assertEqual(records[agent]["defaultModel"], "")
            self.assertEqual(records[agent]["defaultEffort"], "")

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

    def test_codex_lists_visible_models_by_priority(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            (home / "models_cache.json").write_text(json.dumps({"models": [
                {"slug": "gpt-tied-first", "visibility": "list", "priority": 2},
                {"slug": "gpt-hidden", "visibility": "hide", "priority": 0},
                {"slug": "gpt-first", "visibility": "list", "priority": 1},
                {"slug": "gpt-tied-second", "visibility": "list", "priority": 2},
                {"slug": "gpt-unknown", "visibility": "list"},
                {"slug": "bad model", "visibility": "list", "priority": 0},
                {"slug": 42, "visibility": "list", "priority": 0},
            ]}))
            self.assertEqual(consult.codex_models(home), [
                "gpt-first", "gpt-tied-first", "gpt-tied-second", "gpt-unknown"
            ])

    def test_codex_model_listing_tolerates_missing_and_corrupt_caches(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            self.assertEqual(consult.codex_models(home), [])
            (home / "models_cache.json").write_text("not json")
            self.assertEqual(consult.codex_models(home), [])

    def test_codex_efforts_use_the_cache_and_fall_back_for_custom_models(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            (home / "models_cache.json").write_text(json.dumps({"models": [{
                "slug": "gpt-5.6-sol",
                "visibility": "list",
                "priority": 1,
                "supported_reasoning_levels": [
                    {"effort": "low", "description": "Quick"},
                    {"effort": "max", "description": "Deep"},
                    {"description": "malformed"},
                ],
            }]}))
            self.assertEqual(consult.codex_efforts(home), ["low", "max"])
            self.assertEqual(
                consult.codex_efforts(home, "gpt-5.6-sol"), ["low", "max"]
            )
            self.assertEqual(
                consult.codex_efforts(home, "gpt-custom"),
                ["low", "medium", "high", "xhigh", "max", "ultra"],
            )


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


class CredentialStateTests(unittest.TestCase):
    """A credential file is only proof of a login when it still holds a token."""

    CLAUDE_LIVE = {"claudeAiOauth": {"accessToken": "sk-ant-oat01-" + "A" * 60,
                                     "refreshToken": "B" * 64, "expiresAt": 1790000000000}}
    # Exactly what a signed-out Claude Code leaves behind: the record and its
    # metadata survive, the tokens are emptied.
    CLAUDE_WIPED = {"claudeAiOauth": {"accessToken": "", "refreshToken": "",
                                      "expiresAt": 0, "subscriptionType": "max"}}
    KIMI_LIVE = {"access_token": "C" * 704, "refresh_token": "D" * 705,
                 "expires_at": 1788282878, "token_type": "Bearer"}

    def test_token_detection_covers_both_vendor_shapes(self) -> None:
        self.assertTrue(consult.payload_carries_token(self.CLAUDE_LIVE))
        self.assertTrue(consult.payload_carries_token(self.KIMI_LIVE))
        self.assertFalse(consult.payload_carries_token(self.CLAUDE_WIPED))
        self.assertFalse(consult.payload_carries_token({"access_token": "", "refresh_token": ""}))
        self.assertFalse(consult.payload_carries_token({"device_id": "E" * 40}))

    def _claude_spec(self, home: Path) -> dict:
        spec = dict(consult.CONSULTANTS["claude"])
        spec["default_home"] = str(home)
        return spec

    def test_emptied_credential_reads_as_signed_out(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            home = Path(raw)
            (home / ".credentials.json").write_text(json.dumps(self.CLAUDE_WIPED))
            spec = self._claude_spec(home)
            with mock.patch.dict(os.environ, {"CLAUDE_CONFIG_DIR": str(home)}):
                signed_in, note = consult.credential_state(spec)
            self.assertFalse(signed_in)
            self.assertIn("sign in again", note)

    def test_live_credential_reads_as_signed_in(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            home = Path(raw)
            (home / ".credentials.json").write_text(json.dumps(self.CLAUDE_LIVE))
            spec = self._claude_spec(home)
            with mock.patch.dict(os.environ, {"CLAUDE_CONFIG_DIR": str(home)}):
                signed_in, note = consult.credential_state(spec)
            self.assertTrue(signed_in)
            self.assertEqual(note, "")

    def test_missing_credential_has_no_note(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            home = Path(raw)
            spec = self._claude_spec(home)
            with mock.patch.dict(os.environ, {"CLAUDE_CONFIG_DIR": str(home)}):
                signed_in, note = consult.credential_state(spec)
            self.assertFalse(signed_in)
            self.assertEqual(note, "")


class RefreshedCredentialTests(unittest.TestCase):
    """A token refreshed inside the sandbox has to survive its deletion."""

    def _claude_spec(self) -> dict:
        return dict(consult.CONSULTANTS["claude"])

    def test_refreshed_token_is_carried_back(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            home, agent_home = root / "home", root / "sandbox"
            home.mkdir()
            agent_home.mkdir()
            old = {"claudeAiOauth": {"accessToken": "A" * 40, "refreshToken": "B" * 40}}
            new = {"claudeAiOauth": {"accessToken": "C" * 40, "refreshToken": "D" * 40}}
            (home / ".credentials.json").write_text(json.dumps(old))
            (agent_home / ".credentials.json").write_text(json.dumps(new))

            consult.preserve_refreshed_credentials(self._claude_spec(), home, agent_home)

            self.assertEqual(json.loads((home / ".credentials.json").read_text()), new)
            self.assertEqual((home / ".credentials.json").stat().st_mode & 0o777, 0o600)

    def test_a_wiped_sandbox_copy_never_overwrites_a_live_token(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            home, agent_home = root / "home", root / "sandbox"
            home.mkdir()
            agent_home.mkdir()
            live = {"claudeAiOauth": {"accessToken": "A" * 40, "refreshToken": "B" * 40}}
            (home / ".credentials.json").write_text(json.dumps(live))
            (agent_home / ".credentials.json").write_text(
                json.dumps({"claudeAiOauth": {"accessToken": "", "refreshToken": ""}})
            )

            consult.preserve_refreshed_credentials(self._claude_spec(), home, agent_home)

            self.assertEqual(json.loads((home / ".credentials.json").read_text()), live)

    def test_unparsable_sandbox_copy_is_ignored(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            home, agent_home = root / "home", root / "sandbox"
            home.mkdir()
            agent_home.mkdir()
            live = {"claudeAiOauth": {"accessToken": "A" * 40, "refreshToken": "B" * 40}}
            (home / ".credentials.json").write_text(json.dumps(live))
            (agent_home / ".credentials.json").write_text("not json at all")

            consult.preserve_refreshed_credentials(self._claude_spec(), home, agent_home)

            self.assertEqual(json.loads((home / ".credentials.json").read_text()), live)


class CodexConsultantTests(unittest.TestCase):
    """Codex is consulted through the same isolation as the others."""

    def test_codex_args_turn_off_every_extra_capability(self) -> None:
        args = consult.codex_args("what is this?", "gpt-5.6-sol", "max")
        self.assertEqual(args[:2], ["codex", "exec"])
        self.assertEqual(args[-1], "what is this?")
        for flag in ("--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check"):
            self.assertIn(flag, args)
        self.assertEqual(args[args.index("--sandbox") + 1], "read-only")
        disabled = [args[i + 1] for i, item in enumerate(args) if item == "--disable"]
        self.assertEqual(disabled, list(consult.CODEX_DISABLED_FEATURES))
        self.assertIn('web_search="disabled"', args)
        self.assertIn("mcp_servers={}", args)
        self.assertEqual(args[args.index("--model") + 1], "gpt-5.6-sol")
        self.assertIn('model_reasoning_effort="max"', args)

    def test_codex_spec_asks_for_an_answer_file_and_never_writes_back(self) -> None:
        spec = consult.CONSULTANTS["codex"]
        self.assertEqual(spec["answer_file"], "last-message.md")
        self.assertFalse(spec["preserve_refreshed"])
        self.assertEqual(spec["login_proof"], "auth.json")
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            home, agent_home = root / "home", root / "sandbox"
            home.mkdir()
            agent_home.mkdir()
            live = {"tokens": {"access_token": "A" * 40, "refresh_token": "B" * 40}}
            planted = {"tokens": {"access_token": "X" * 40, "refresh_token": "Y" * 40}}
            (home / "auth.json").write_text(json.dumps(live))
            (agent_home / "auth.json").write_text(json.dumps(planted))
            consult.preserve_refreshed_credentials(spec, home, agent_home)
            self.assertEqual(json.loads((home / "auth.json").read_text()), live)

    def test_answer_file_is_read_and_stripped(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            path = Path(raw) / "last-message.md"
            path.write_text("\n## Bottom line\nAll quiet.\n\n")
            self.assertEqual(consult.read_sandbox_answer(path), "## Bottom line\nAll quiet.")
            self.assertEqual(consult.read_sandbox_answer(Path(raw) / "missing.md"), "")


class ParallelConsultTests(unittest.TestCase):
    """Several consultants asked at once, fastest answer surfaced first."""

    def test_agent_list_is_ordered_deduped_and_validated(self) -> None:
        self.assertEqual(consult.parse_agent_list("kimi, claude,kimi"), ["kimi", "claude"])
        self.assertEqual(consult.parse_agent_list("claude"), ["claude"])
        with self.assertRaises(consult.ConsultError):
            consult.parse_agent_list("kimi,gemini")
        with self.assertRaises(consult.ConsultError):
            consult.parse_agent_list("   ")

    def test_block_uses_stdout_on_success_and_stderr_on_failure(self) -> None:
        ok = consult.format_consult_block("Kimi Code", 12, 0, "the answer", "tier note")
        self.assertIn("=== Kimi Code · 12s ===", ok)
        self.assertIn("the answer", ok)
        self.assertNotIn("tier note", ok)
        bad = consult.format_consult_block("Claude Code", 300, 2, "", "consult: timed out")
        self.assertIn("· no answer ===", bad)
        self.assertIn("consult: timed out", bad)

    def _run(self, agents, builder):
        import contextlib, io
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = consult.run_parallel_consults(agents, "q", 30, command_builder=builder)
        return rc, buf.getvalue()

    def test_faster_consultant_prints_first(self) -> None:
        def builder(agent, prompt, timeout):
            delay = {"kimi": "0.1", "claude": "0.6"}[agent]
            return ["sh", "-c", f'sleep {delay}; printf "%s-done" {agent}']
        rc, out = self._run(["claude", "kimi"], builder)
        self.assertEqual(rc, 0)
        # Kimi is faster, so its block appears before Claude's regardless of
        # the order they were requested in.
        self.assertLess(out.index("Kimi Code"), out.index("Claude Code"))
        self.assertIn("kimi-done", out)
        self.assertIn("claude-done", out)

    def test_one_failure_does_not_sink_the_other(self) -> None:
        def builder(agent, prompt, timeout):
            if agent == "claude":
                return ["sh", "-c", "sleep 0.1; echo broke >&2; exit 2"]
            return ["sh", "-c", 'sleep 0.2; printf PONG']
        rc, out = self._run(["claude", "kimi"], builder)
        self.assertEqual(rc, 0)  # kimi answered
        self.assertIn("Claude Code · 0s · no answer", out.replace("1s", "0s"))
        self.assertIn("broke", out)
        self.assertIn("PONG", out)

    def test_all_failing_returns_nonzero(self) -> None:
        def builder(agent, prompt, timeout):
            return ["sh", "-c", "echo nope >&2; exit 2"]
        rc, out = self._run(["kimi", "claude"], builder)
        self.assertEqual(rc, 2)


class LandlockFallbackTests(unittest.TestCase):
    """A kernel without Landlock degrades to uid-drop, it does not refuse."""

    def test_absent_landlock_degrades_instead_of_raising(self) -> None:
        for code in (consult.errno.ENOSYS, consult.errno.EPERM, consult.errno.EOPNOTSUPP):
            with mock.patch.object(consult, "_landlock_syscall", side_effect=OSError(code, "x")):
                self.assertFalse(consult.apply_landlock(Path("/config"), Path("/tmp")))
                self.assertEqual(consult.landlock_supported(), (False, code))

    def test_low_abi_degrades(self) -> None:
        with mock.patch.object(consult, "_landlock_syscall", return_value=0):
            self.assertFalse(consult.apply_landlock(Path("/config"), Path("/tmp")))
            self.assertEqual(consult.landlock_supported(), (False, 0))

    def test_present_but_broken_landlock_still_fails_closed(self) -> None:
        # An unexpected errno from the probe is a real problem on a kernel that
        # claims Landlock, so it must not be mistaken for graceful absence.
        with mock.patch.object(consult, "_landlock_syscall", side_effect=OSError(consult.errno.EFAULT, "bad")):
            with self.assertRaises(OSError):
                consult.apply_landlock(Path("/config"), Path("/tmp"))


class SandboxLogTests(unittest.TestCase):
    def test_log_tail_is_read_out_of_the_sandbox(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            agent_home = Path(raw)
            (agent_home / "logs").mkdir()
            (agent_home / "logs" / "kimi-code.log").write_text(
                "first line\n\nsecond line\nthe authorization grant is invalid\n"
            )
            tail = consult.read_sandbox_log_tail(agent_home)
            self.assertIn("the authorization grant is invalid", tail)
            self.assertNotIn("\n\n", tail)

    def test_missing_log_directory_is_not_an_error(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            self.assertEqual(consult.read_sandbox_log_tail(Path(raw)), "")


if __name__ == "__main__":
    unittest.main()
