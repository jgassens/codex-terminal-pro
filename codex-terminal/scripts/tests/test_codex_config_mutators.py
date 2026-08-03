from __future__ import annotations

import os
import subprocess
import tempfile
import tomllib
import unittest
from pathlib import Path


SCRIPTS = Path(__file__).resolve().parents[1]
HEYGEN = SCRIPTS / "codex-disable-heygen-plugin"
CONFIG_SET = SCRIPTS / "codex-config-set"
CONFIG_TUI = SCRIPTS / "codex-config-tui"
RUN_SCRIPT = SCRIPTS.parent / "run.sh"


class CodexConfigMutatorTests(unittest.TestCase):
    def run_heygen(self, original: str) -> tuple[str, subprocess.CompletedProcess[str]]:
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "config.toml"
            config.write_text(original, encoding="utf-8")
            result = subprocess.run(
                [str(HEYGEN), "--config", str(config)],
                text=True,
                capture_output=True,
                check=False,
            )
            return config.read_text(encoding="utf-8"), result

    def test_heygen_dotted_key_is_replaced_without_duplicate_table(self) -> None:
        original = 'plugins."heygen@openai-curated".enabled = true\n[tui]\ntheme = "dark"\n'
        updated, result = self.run_heygen(original)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('plugins."heygen@openai-curated".enabled = false', updated)
        tomllib.loads(updated)

    def test_heygen_invalid_toml_is_left_byte_for_byte_unchanged(self) -> None:
        original = '[plugins."heygen@openai-curated"\nenabled = true\n'
        updated, result = self.run_heygen(original)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(updated, original)

    def test_top_level_setter_inserts_before_existing_table(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "config.toml"
            config.write_text('[tui]\ntheme = "dark"\n', encoding="utf-8")
            result = subprocess.run(
                [str(CONFIG_SET), str(config), "cli_auth_credentials_store", '"file"'],
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            updated = config.read_text(encoding="utf-8")
            self.assertTrue(updated.startswith('cli_auth_credentials_store = "file"\n'))
            self.assertEqual(tomllib.loads(updated)["cli_auth_credentials_store"], "file")

    def test_invalid_toml_is_unchanged_by_top_level_and_tui_mutators(self) -> None:
        original = '[tui\ntheme = "dark"\n'
        for script, arguments in (
            (CONFIG_SET, ("cli_auth_credentials_store", '"file"')),
            (CONFIG_TUI, ()),
        ):
            with self.subTest(script=script.name), tempfile.TemporaryDirectory() as directory:
                config = Path(directory) / "config.toml"
                config.write_text(original, encoding="utf-8")

                result = subprocess.run(
                    [str(script), str(config), *arguments],
                    text=True,
                    capture_output=True,
                    check=False,
                )

                self.assertEqual(result.returncode, 2)
                self.assertEqual(config.read_text(encoding="utf-8"), original)
                self.assertIn("left unchanged", result.stderr)

    def test_run_startup_helpers_leave_invalid_config_unchanged_and_continue(self) -> None:
        original = '[tui\ntheme = "dark"\n'
        with tempfile.TemporaryDirectory() as directory:
            codex_home = Path(directory) / "codex-home"
            codex_home.mkdir()
            config = codex_home / "config.toml"
            config.write_text(original, encoding="utf-8")
            command = r'''
function bashio::log.info() { :; }
function bashio::log.warning() { printf '%s\n' "$1" >&2; }
export CODEX_TERMINAL_RUN_LIBRARY_ONLY=true
. "$RUN_SCRIPT"
ensure_codex_file_credentials
ensure_codex_update_prompt_disabled
ensure_codex_tui_defaults
'''

            result = subprocess.run(
                ["bash", "-c", command],
                env={
                    **os.environ,
                    "CODEX_HOME": str(codex_home),
                    "CODEX_CONFIG_SET_BIN": str(CONFIG_SET),
                    "CODEX_CONFIG_TUI_BIN": str(CONFIG_TUI),
                    "RUN_SCRIPT": str(RUN_SCRIPT),
                },
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(config.read_text(encoding="utf-8"), original)
            self.assertEqual(result.stderr.count("left unchanged"), 6)

    def run_execution_defaults(self, codex_home: Path, option_value: str) -> subprocess.CompletedProcess[str]:
        command = r'''
function bashio::log.info() { :; }
function bashio::log.warning() { printf '%s\n' "$1" >&2; }
function bashio::config() { printf '%s\n' "$CODEX_FULL_ACCESS_OPTION"; }
export CODEX_TERMINAL_RUN_LIBRARY_ONLY=true
. "$RUN_SCRIPT"
ensure_codex_execution_defaults
'''
        return subprocess.run(
            ["bash", "-c", command],
            env={
                **os.environ,
                "CODEX_HOME": str(codex_home),
                "CODEX_CONFIG_SET_BIN": str(CONFIG_SET),
                "RUN_SCRIPT": str(RUN_SCRIPT),
                "CODEX_FULL_ACCESS_OPTION": option_value,
            },
            text=True,
            capture_output=True,
            check=False,
        )

    def test_execution_defaults_enforce_full_access_without_touching_tables(self) -> None:
        original = (
            'model = "gpt-5.3-codex"\n'
            'approval_policy = "on-request"\n'
            "\n"
            "[profiles.safe]\n"
            'approval_policy = "untrusted"\n'
            'sandbox_mode = "read-only"\n'
        )
        with tempfile.TemporaryDirectory() as directory:
            codex_home = Path(directory) / "codex-home"
            codex_home.mkdir()
            config = codex_home / "config.toml"
            config.write_text(original, encoding="utf-8")

            result = self.run_execution_defaults(codex_home, "true")

            self.assertEqual(result.returncode, 0, result.stderr)
            parsed = tomllib.loads(config.read_text(encoding="utf-8"))
            self.assertEqual(parsed["approval_policy"], "never")
            self.assertEqual(parsed["sandbox_mode"], "danger-full-access")
            self.assertEqual(parsed["model"], "gpt-5.3-codex")
            self.assertEqual(
                parsed["profiles"]["safe"],
                {"approval_policy": "untrusted", "sandbox_mode": "read-only"},
            )

    def test_execution_defaults_create_missing_config(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            codex_home = Path(directory) / "codex-home"
            codex_home.mkdir()

            result = self.run_execution_defaults(codex_home, "true")

            self.assertEqual(result.returncode, 0, result.stderr)
            parsed = tomllib.loads((codex_home / "config.toml").read_text(encoding="utf-8"))
            self.assertEqual(parsed["approval_policy"], "never")
            self.assertEqual(parsed["sandbox_mode"], "danger-full-access")

    def test_execution_defaults_opt_out_leaves_config_alone(self) -> None:
        original = 'approval_policy = "untrusted"\nsandbox_mode = "read-only"\n'
        with tempfile.TemporaryDirectory() as directory:
            codex_home = Path(directory) / "codex-home"
            codex_home.mkdir()
            config = codex_home / "config.toml"
            config.write_text(original, encoding="utf-8")

            result = self.run_execution_defaults(codex_home, "false")

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(config.read_text(encoding="utf-8"), original)

    def test_mutators_never_follow_config_or_lock_symlinks(self) -> None:
        for linked_name in ("config.toml", ".codex-terminal-config.lock"):
            with self.subTest(linked_name=linked_name), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                config_home = root / "codex-home"
                config_home.mkdir()
                external = root / "outside"
                original = '[tui]\ntheme = "dark"\n'
                external.write_text(original, encoding="utf-8")
                (config_home / linked_name).symlink_to(external)
                config = config_home / "config.toml"
                if linked_name != "config.toml":
                    config.write_text(original, encoding="utf-8")

                result = subprocess.run(
                    [str(CONFIG_SET), str(config), "check_for_update_on_startup", "false"],
                    text=True,
                    capture_output=True,
                    check=False,
                )

                self.assertEqual(result.returncode, 2)
                self.assertEqual(external.read_text(encoding="utf-8"), original)
                if linked_name == "config.toml":
                    self.assertTrue(config.is_symlink())


if __name__ == "__main__":
    unittest.main()
