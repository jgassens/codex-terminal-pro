import json
import re
import subprocess
import unittest
from pathlib import Path


REPO = Path(__file__).resolve().parents[3]
ADDON = REPO / "codex-terminal"


class RepositoryContractTests(unittest.TestCase):
    def test_example_options_is_valid_json(self):
        payload = json.loads((REPO / "config" / "options.json").read_text(encoding="utf-8"))
        self.assertIsInstance(payload.get("auto_launch_codex"), bool)

    def test_release_version_is_consistent(self):
        config = (ADDON / "config.yaml").read_text(encoding="utf-8")
        dockerfile = (ADDON / "Dockerfile").read_text(encoding="utf-8")
        run_script = (ADDON / "run.sh").read_text(encoding="utf-8")
        version = re.search(r'^version:\s*"([^"]+)"', config, re.MULTILINE)
        self.assertIsNotNone(version)
        release = version.group(1)
        self.assertIn(f'io.hass.version="{release}"', dockerfile)
        self.assertIn(f"APP_VERSION:-{release}", run_script)

    def test_downloads_and_base_image_are_pinned(self):
        dockerfile = (ADDON / "Dockerfile").read_text(encoding="utf-8")
        self.assertNotIn("base:latest", dockerfile)
        self.assertNotIn("releases/latest", dockerfile)
        self.assertRegex(dockerfile.splitlines()[0], r"@sha256:[0-9a-f]{64}$")
        self.assertIn("HA_CLI_SHA256_AMD64", dockerfile)
        self.assertIn("GH_CLI_SHA256_ARM64", dockerfile)
        self.assertGreaterEqual(dockerfile.count("sha256sum -c -"), 2)

    def test_home_assistant_architecture_aliases_are_supported(self):
        dockerfile = (ADDON / "Dockerfile").read_text(encoding="utf-8")
        self.assertGreaterEqual(dockerfile.count("arm64|aarch64)"), 2)
        self.assertGreaterEqual(dockerfile.count("amd64|x86_64)"), 2)
        self.assertGreaterEqual(dockerfile.count("apk --print-arch"), 2)
        self.assertNotIn("/usr/bin/ha --version", dockerfile)

    def test_repository_has_no_unregistered_gitlinks(self):
        result = subprocess.run(
            ["git", "ls-files", "--stage"],
            cwd=REPO,
            text=True,
            capture_output=True,
            check=True,
        )
        gitlinks = [line for line in result.stdout.splitlines() if line.startswith("160000 ")]
        self.assertEqual(gitlinks, [], f"unregistered nested repositories: {gitlinks}")


if __name__ == "__main__":
    unittest.main()
