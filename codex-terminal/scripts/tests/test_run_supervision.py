import os
import subprocess
import unittest
from pathlib import Path


RUN_SCRIPT = Path(__file__).resolve().parents[2] / "run.sh"


class WebProcessSupervisionTests(unittest.TestCase):
    def test_planned_term_stops_and_reaps_children_without_false_failure(self):
        script = r'''
set -e
export CODEX_TERMINAL_RUN_LIBRARY_ONLY=true
source "$RUN_SCRIPT_UNDER_TEST"
function bashio::log.error() { printf 'ERROR:%s\n' "$*"; }
sleep 30 &
IMAGE_SERVICE_PID=$!
sleep 30 &
TTYD_PID=$!
sleep 30 &
HA_MONITOR_PID=$!
(sleep 0.1; kill -TERM $$) &
supervise_web_processes
'''
        completed = subprocess.run(
            ["bash", "-c", script],
            env={**os.environ, "RUN_SCRIPT_UNDER_TEST": str(RUN_SCRIPT)},
            text=True,
            capture_output=True,
            timeout=5,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertNotIn("exited; stopping", completed.stdout)
        self.assertNotIn("supervisor woke", completed.stdout)

    def test_monitor_exit_stops_other_required_children_and_fails(self):
        script = r'''
set -e
export CODEX_TERMINAL_RUN_LIBRARY_ONLY=true
source "$RUN_SCRIPT_UNDER_TEST"
function bashio::log.error() { printf 'ERROR:%s\n' "$*"; }
sleep 30 &
IMAGE_SERVICE_PID=$!
sleep 30 &
TTYD_PID=$!
bash -c 'exit 0' &
HA_MONITOR_PID=$!
set +e
supervise_web_processes
status=$?
set -e
printf 'STATUS:%s\n' "$status"
exit "$status"
'''
        completed = subprocess.run(
            ["bash", "-c", script],
            env={**os.environ, "RUN_SCRIPT_UNDER_TEST": str(RUN_SCRIPT)},
            text=True,
            capture_output=True,
            timeout=5,
            check=False,
        )
        self.assertEqual(completed.returncode, 1, completed.stderr)
        self.assertIn("HA monitor exited", completed.stdout)
        self.assertIn("STATUS:1", completed.stdout)


if __name__ == "__main__":
    unittest.main()
