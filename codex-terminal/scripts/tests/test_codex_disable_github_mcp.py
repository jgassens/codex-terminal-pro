from __future__ import annotations

import os
import subprocess
import tempfile
import tomllib
import unittest
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "codex-disable-github-mcp"


class GitHubMcpDisableTests(unittest.TestCase):
    def run_script(self, text: str, *, token: str = "") -> tuple[str, subprocess.CompletedProcess[str]]:
        with tempfile.TemporaryDirectory() as temp_dir:
            config = Path(temp_dir) / "config.toml"
            config.write_text(text, encoding="utf-8")
            env = dict(os.environ)
            env["GITHUB_PAT_TOKEN"] = token
            result = subprocess.run(
                [str(SCRIPT), "--config", str(config)],
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            return config.read_text(encoding="utf-8"), result

    def test_disables_plugin_transport_without_disabling_plugin(self) -> None:
        original = '[plugins."github@openai-curated"]\nenabled = true\n'
        updated, result = self.run_script(original)
        self.assertEqual(result.returncode, 0)
        self.assertIn('[plugins."github@openai-curated"]\nenabled = true', updated)
        self.assertIn('[plugins."github@openai-curated".mcp_servers.github]\nenabled = false', updated)

    def test_disables_existing_nested_transport_and_is_idempotent(self) -> None:
        original = (
            '[plugins."github@openai-curated".mcp_servers.github]\n'
            'enabled = true # old default\n'
        )
        first, _ = self.run_script(original)
        second, _ = self.run_script(first)
        self.assertEqual(first, second)
        self.assertIn("enabled = false # old default", first)

    def test_disables_matching_legacy_global_server(self) -> None:
        original = (
            "[mcp_servers.github]\n"
            'url = "https://api.githubcopilot.com/mcp/"\n'
            'bearer_token_env_var = "GITHUB_PAT_TOKEN"\n'
        )
        updated, _ = self.run_script(original)
        self.assertIn("[mcp_servers.github]\nenabled = false", updated)

    def test_leaves_unrelated_custom_server_named_github_untouched(self) -> None:
        original = '[mcp_servers.github]\ncommand = "my-private-github-proxy"\n'
        updated, _ = self.run_script(original)
        self.assertEqual(updated, original)

    def test_extraneous_pat_environment_cannot_enable_unsupported_transport(self) -> None:
        original = (
            '[plugins."github@openai-curated".mcp_servers.github]\n'
            "enabled = true\n"
        )
        updated, _ = self.run_script(original, token="test-token-never-logged")
        self.assertIn("enabled = false", updated)

    def test_disables_dotted_nested_override_without_duplicate_table(self) -> None:
        original = (
            '[plugins."github@openai-curated"]\n'
            'enabled = true\n'
            'mcp_servers.github.enabled = true\n'
        )
        updated, result = self.run_script(original)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("mcp_servers.github.enabled = false", updated)
        self.assertNotIn('[plugins."github@openai-curated".mcp_servers.github]', updated)
        tomllib.loads(updated)

    def test_disables_top_level_quoted_dotted_override_without_corrupting_toml(self) -> None:
        original = (
            'plugins.\'github@openai-curated\'.enabled = true\n'
            'plugins.\'github@openai-curated\'.mcp_servers.\'github\'.enabled = true\n'
            '[tui]\n'
            'theme = "dark"\n'
        )
        updated, result = self.run_script(original)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("mcp_servers.'github'.enabled = false", updated)
        tomllib.loads(updated)

    def test_same_legacy_url_with_different_auth_is_user_owned(self) -> None:
        original = (
            '[mcp_servers.github]\n'
            'url = "https://api.githubcopilot.com/mcp"\n'
            'bearer_token_env_var = "MY_GITHUB_TOKEN"\n'
        )
        updated, result = self.run_script(original)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(updated, original)

    def test_multiline_string_lookalikes_are_preserved_as_data(self) -> None:
        original = (
            'banner = """\n'
            '[mcp_servers.github]\n'
            'url = "https://api.githubcopilot.com/mcp"\n'
            'bearer_token_env_var = "GITHUB_PAT_TOKEN"\n'
            'enabled = true\n'
            '"""\n'
            "\n"
            '[plugins."github@openai-curated"]\n'
            "note = '''\n"
            "mcp_servers.github.enabled = true\n"
            "'''\n"
        )
        before = tomllib.loads(original)

        updated, result = self.run_script(original)

        self.assertEqual(result.returncode, 0, result.stderr)
        after = tomllib.loads(updated)
        self.assertEqual(after["banner"], before["banner"])
        plugin = after["plugins"]["github@openai-curated"]
        self.assertEqual(plugin["note"], before["plugins"]["github@openai-curated"]["note"])
        self.assertIs(plugin["mcp_servers"]["github"]["enabled"], False)

    def test_invalid_input_is_never_replaced(self) -> None:
        original = '[plugins."github@openai-curated"\nenabled = true\n'
        updated, result = self.run_script(original)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(updated, original)


if __name__ == "__main__":
    unittest.main()
