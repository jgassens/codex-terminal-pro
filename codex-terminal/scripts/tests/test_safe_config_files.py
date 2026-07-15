from __future__ import annotations

import os
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path


SCRIPTS = Path(__file__).resolve().parents[1]
RUN_SCRIPT = SCRIPTS.parent / "run.sh"
CONFIG_FILES = SCRIPTS / "codex-terminal-config-files.py"


class SafeConfigFileTests(unittest.TestCase):
    def run_helper(
        self, root: Path, *arguments: str
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [str(CONFIG_FILES), *arguments],
            env={**os.environ, "CODEX_TERMINAL_CONFIG_ROOT": str(root)},
            text=True,
            capture_output=True,
            check=False,
        )

    def test_publish_replaces_symlink_without_touching_external_target(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory).resolve()
            root = base / "config"
            root.mkdir()
            external = base / "outside.txt"
            external.write_text("do not overwrite\n", encoding="utf-8")
            (root / "CODEX_TERMINAL_PRO.md").symlink_to(external)
            source = base / "briefing.md"
            source.write_text("safe briefing\n", encoding="utf-8")

            result = self.run_helper(
                root,
                "publish",
                str(source),
                "CODEX_TERMINAL_PRO.md",
                "0644",
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(external.read_text(encoding="utf-8"), "do not overwrite\n")
            published = root / "CODEX_TERMINAL_PRO.md"
            self.assertFalse(published.is_symlink())
            self.assertEqual(published.read_text(encoding="utf-8"), "safe briefing\n")
            self.assertEqual(stat.S_IMODE(published.stat().st_mode), 0o644)

    def test_snapshot_rejects_symlink_and_leaves_destination_unchanged(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory).resolve()
            root = base / "config"
            root.mkdir()
            external = base / "outside.txt"
            external.write_text("outside\n", encoding="utf-8")
            (root / "AGENTS.md").symlink_to(external)
            destination = base / "snapshot"
            destination.write_text("unchanged\n", encoding="utf-8")

            result = self.run_helper(root, "snapshot", "AGENTS.md", str(destination))

            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(destination.read_text(encoding="utf-8"), "unchanged\n")
            self.assertEqual(external.read_text(encoding="utf-8"), "outside\n")

    def test_snapshot_will_not_follow_a_destination_symlink(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory).resolve()
            root = base / "config"
            root.mkdir()
            (root / "AGENTS.md").write_text("safe input\n", encoding="utf-8")
            external = base / "outside.txt"
            external.write_text("outside\n", encoding="utf-8")
            destination = base / "snapshot"
            destination.symlink_to(external)

            result = self.run_helper(root, "snapshot", "AGENTS.md", str(destination))

            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(external.read_text(encoding="utf-8"), "outside\n")

    def test_run_wrapper_safely_publishes_executable_over_symlink(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory).resolve()
            root = base / "config"
            root.mkdir()
            external = base / "outside.txt"
            external.write_text("outside\n", encoding="utf-8")
            target = root / "codex-terminal-pro-attach"
            target.symlink_to(external)
            source = base / "attach"
            source.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")

            script = r'''
set -e
export CODEX_TERMINAL_RUN_LIBRARY_ONLY=true
source "$RUN_SCRIPT_UNDER_TEST"
safe_publish_config_file "$SOURCE" "codex-terminal-pro-attach" "0755"
'''
            result = subprocess.run(
                ["bash", "-c", script],
                env={
                    **os.environ,
                    "RUN_SCRIPT_UNDER_TEST": str(RUN_SCRIPT),
                    "CODEX_TERMINAL_CONFIG_FILE_HELPER": str(CONFIG_FILES),
                    "CODEX_TERMINAL_CONFIG_ROOT": str(root),
                    "SOURCE": str(source),
                },
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(external.read_text(encoding="utf-8"), "outside\n")
            self.assertFalse(target.is_symlink())
            self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o755)

    def test_agents_update_replaces_unsafe_symlink_with_managed_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory).resolve()
            root = base / "config"
            root.mkdir()
            external = base / "outside.txt"
            external.write_text("outside must survive\n", encoding="utf-8")
            target = root / "AGENTS.md"
            target.symlink_to(external)
            fallback = base / "trusted-agents.md"
            fallback.write_text("# Safe fallback\n", encoding="utf-8")

            script = r'''
set -e
export CODEX_TERMINAL_RUN_LIBRARY_ONLY=true
source "$RUN_SCRIPT_UNDER_TEST"
function bashio::log.warning() { :; }
write_codex_terminal_agents_block "AGENTS.md" "$FALLBACK"
'''
            result = subprocess.run(
                ["bash", "-c", script],
                env={
                    **os.environ,
                    "RUN_SCRIPT_UNDER_TEST": str(RUN_SCRIPT),
                    "CODEX_TERMINAL_CONFIG_FILE_HELPER": str(CONFIG_FILES),
                    "CODEX_TERMINAL_CONFIG_ROOT": str(root),
                    "FALLBACK": str(fallback),
                },
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(external.read_text(encoding="utf-8"), "outside must survive\n")
            self.assertFalse(target.is_symlink())
            updated = target.read_text(encoding="utf-8")
            self.assertIn("# Safe fallback", updated)
            self.assertIn("BEGIN CODEX TERMINAL PRO MANAGED GUIDANCE", updated)

    def test_legitimate_regular_file_round_trip_is_preserved(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory).resolve()
            root = base / "config"
            root.mkdir()
            existing = root / "AGENTS.md"
            existing.write_text("# Human guidance\n", encoding="utf-8")
            snapshot = base / "snapshot"
            snapshot.write_text("placeholder\n", encoding="utf-8")

            read_result = self.run_helper(root, "snapshot", "AGENTS.md", str(snapshot))
            self.assertEqual(read_result.returncode, 0, read_result.stderr)
            self.assertEqual(snapshot.read_text(encoding="utf-8"), "# Human guidance\n")

            replacement = base / "replacement"
            replacement.write_text("# Updated guidance\n", encoding="utf-8")
            write_result = self.run_helper(
                root, "publish", str(replacement), "AGENTS.md", "0644"
            )
            self.assertEqual(write_result.returncode, 0, write_result.stderr)
            self.assertEqual(existing.read_text(encoding="utf-8"), "# Updated guidance\n")

    def test_config_root_symlink_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory).resolve()
            real_root = base / "real-config"
            real_root.mkdir()
            linked_root = base / "config"
            linked_root.symlink_to(real_root, target_is_directory=True)
            source = base / "briefing"
            source.write_text("briefing\n", encoding="utf-8")

            result = self.run_helper(
                linked_root,
                "publish",
                str(source),
                "CODEX_TERMINAL_PRO.md",
                "0644",
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((real_root / "CODEX_TERMINAL_PRO.md").exists())


if __name__ == "__main__":
    unittest.main()
