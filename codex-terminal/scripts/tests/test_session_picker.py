from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path


REPO = Path(__file__).resolve().parents[3]
PICKERS = (
    REPO / "codex-terminal" / "scripts" / "codex-session-picker.sh",
    REPO / "config" / "scripts" / "codex-session-picker.sh",
)


class SessionPickerTests(unittest.TestCase):
    def test_end_of_input_exits_instead_of_defaulting_forever(self) -> None:
        for picker in PICKERS:
            with self.subTest(picker=picker):
                source = picker.read_text(encoding="utf-8")
                self.assertTrue(source.rstrip().endswith('main "$@"'))
                library = source.rsplit('main "$@"', 1)[0]

                with tempfile.TemporaryDirectory() as directory:
                    library_path = Path(directory) / "picker-library.sh"
                    library_path.write_text(library, encoding="utf-8")
                    command = f'''
source "$PICKER_LIBRARY"
show_banner() {{ :; }}
show_menu() {{ :; }}
start_codex() {{ printf 'unexpected action\\n'; return 99; }}
main
'''
                    completed = subprocess.run(
                        ["bash", "-c", command],
                        env={"PICKER_LIBRARY": str(library_path)},
                        stdin=subprocess.DEVNULL,
                        check=False,
                        capture_output=True,
                        text=True,
                        timeout=2,
                    )

                self.assertEqual(completed.returncode, 0, completed.stderr)
                self.assertIn("Input closed. Exiting.", completed.stderr)
                self.assertNotIn("unexpected action", completed.stdout)

    def test_end_of_input_at_missing_auth_confirmation_returns_safely(self) -> None:
        for picker in PICKERS:
            with self.subTest(picker=picker):
                source = picker.read_text(encoding="utf-8")
                library = source.rsplit('main "$@"', 1)[0]

                with tempfile.TemporaryDirectory() as directory:
                    root = Path(directory)
                    library_path = root / "picker-library.sh"
                    library_path.write_text(library, encoding="utf-8")
                    completed = subprocess.run(
                        [
                            "bash",
                            "-c",
                            'cd() { :; }; source "$PICKER_LIBRARY"; pause() { :; }; start_codex',
                        ],
                        env={
                            "PICKER_LIBRARY": str(library_path),
                            "CODEX_HOME": str(root / "unsigned-codex-home"),
                        },
                        input="",
                        check=False,
                        capture_output=True,
                        text=True,
                        timeout=2,
                    )

                self.assertEqual(completed.returncode, 0, completed.stderr)
                self.assertIn("Returning to menu.", completed.stdout)


if __name__ == "__main__":
    unittest.main()
