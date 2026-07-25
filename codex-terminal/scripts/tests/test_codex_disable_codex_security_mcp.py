from __future__ import annotations

import os
import subprocess
import tempfile
import tomllib
import unittest
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "codex-disable-codex-security-mcp"


class CodexSecurityMcpDisableTests(unittest.TestCase):
    def run_script(self, text: str) -> tuple[str, subprocess.CompletedProcess[str]]:
        with tempfile.TemporaryDirectory() as temp_dir:
            config = Path(temp_dir) / "config.toml"
            config.write_text(text, encoding="utf-8")
            result = subprocess.run(
                [str(SCRIPT), "--config", str(config)],
                env=dict(os.environ),
                text=True,
                capture_output=True,
                check=False,
            )
            return config.read_text(encoding="utf-8"), result

    def test_disables_transport_without_disabling_security_skills(self) -> None:
        original = (
            '[plugins."codex-security@openai-curated-remote"]\n'
            "enabled = true\n"
        )
        updated, result = self.run_script(original)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(
            '[plugins."codex-security@openai-curated-remote"]\nenabled = true',
            updated,
        )
        self.assertIn(
            '[plugins."codex-security@openai-curated-remote".mcp_servers."codex-security"]\n'
            "enabled = false",
            updated,
        )
        tomllib.loads(updated)

    def test_adds_override_even_when_remote_plugin_is_implicit(self) -> None:
        updated, result = self.run_script('[tui]\ntheme = "dark"\n')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(
            '[plugins."codex-security@openai-curated-remote".mcp_servers."codex-security"]',
            updated,
        )
        tomllib.loads(updated)

    def test_disables_existing_nested_transport_and_is_idempotent(self) -> None:
        original = (
            '[plugins."codex-security@openai-curated-remote".mcp_servers."codex-security"]\n'
            "enabled = true # old default\n"
        )
        first, first_result = self.run_script(original)
        second, second_result = self.run_script(first)
        self.assertEqual(first_result.returncode, 0, first_result.stderr)
        self.assertEqual(second_result.returncode, 0, second_result.stderr)
        self.assertEqual(first, second)
        self.assertIn("enabled = false # old default", first)

    def test_disables_dotted_nested_override_without_duplicate_table(self) -> None:
        original = (
            "plugins.'codex-security@openai-curated-remote'.mcp_servers."
            "'codex-security'.enabled = true\n"
            "[tui]\n"
            'theme = "dark"\n'
        )
        updated, result = self.run_script(original)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("'codex-security'.enabled = false", updated)
        self.assertEqual(updated.count("codex-security"), 2)
        tomllib.loads(updated)

    def test_invalid_input_is_never_replaced(self) -> None:
        original = '[plugins."codex-security@openai-curated-remote"\nenabled = true\n'
        updated, result = self.run_script(original)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(updated, original)


if __name__ == "__main__":
    unittest.main()
