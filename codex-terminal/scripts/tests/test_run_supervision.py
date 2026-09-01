import os
import subprocess
import tempfile
import unittest
from pathlib import Path


RUN_SCRIPT = Path(__file__).resolve().parents[2] / "run.sh"


class WebProcessSupervisionTests(unittest.TestCase):
    def test_web_readiness_waits_for_the_combined_health_check(self):
        script = r'''
set -e
export CODEX_TERMINAL_RUN_LIBRARY_ONLY=true
source "$RUN_SCRIPT_UNDER_TEST"
function bashio::log.info() { :; }
function bashio::log.error() { printf 'ERROR:%s\n' "$*"; }
attempts=0
curl() {
    attempts=$((attempts + 1))
    [ "$attempts" -ge 3 ]
}
sleep() { :; }
/bin/sleep 30 &
IMAGE_SERVICE_PID=$!
/bin/sleep 30 &
TTYD_PID=$!
wait_for_web_readiness
printf 'ATTEMPTS:%s\n' "$attempts"
kill "$IMAGE_SERVICE_PID" "$TTYD_PID"
wait "$IMAGE_SERVICE_PID" "$TTYD_PID" 2>/dev/null || true
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
        self.assertIn("ATTEMPTS:3", completed.stdout)

    def test_image_service_log_is_bounded_during_the_run(self):
        with tempfile.TemporaryDirectory() as directory:
            log_file = Path(directory) / "image-service.log"
            script = r'''
set -e
export CODEX_TERMINAL_RUN_LIBRARY_ONLY=true
source "$RUN_SCRIPT_UNDER_TEST"
for line in first-123456789 second-123456789 third-123456789; do
    append_bounded_log_line "$LOG_FILE_UNDER_TEST" 32 "$line"
done
'''
            completed = subprocess.run(
                ["bash", "-c", script],
                env={
                    **os.environ,
                    "RUN_SCRIPT_UNDER_TEST": str(RUN_SCRIPT),
                    "LOG_FILE_UNDER_TEST": str(log_file),
                },
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertLessEqual(log_file.stat().st_size, 32)
            self.assertLessEqual(Path(f"{log_file}.1").stat().st_size, 32)
            self.assertIn("third-123456789", log_file.read_text())

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
