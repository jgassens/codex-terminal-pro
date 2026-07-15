from __future__ import annotations

import importlib.machinery
import importlib.util
import json
import tempfile
import threading
import time
import types
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).parents[1] / "ha-monitor"
LOADER = importlib.machinery.SourceFileLoader("ha_monitor_under_test", str(SCRIPT))
SPEC = importlib.util.spec_from_loader(LOADER.name, LOADER)
assert SPEC is not None
MODULE = importlib.util.module_from_spec(SPEC)
LOADER.exec_module(MODULE)


class MonitorLogCursorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.args = types.SimpleNamespace(issue_ttl_seconds=3600, max_issues=20, log_lines=500)

    def issue(self, line: str) -> dict:
        summary = MODULE.summarize_log_issues(line, 500, 20)
        self.assertEqual(len(summary["issues"]), 1)
        return summary["issues"][0]

    def test_unchanged_tail_line_does_not_become_persistent(self) -> None:
        line = "2026-07-14 10:00:00 WARNING [demo] device timed out"
        first = MODULE.merge_issue_state({}, [self.issue(line)], self.args, "2026-07-14T10:00:01+00:00")
        second = MODULE.merge_issue_state(
            {"issue_state": first},
            [self.issue(line)],
            self.args,
            "2026-07-14T10:05:01+00:00",
        )
        self.assertEqual(second[0]["runs_seen"], 1)
        self.assertEqual(second[0]["occurrences"], 1)
        self.assertEqual(second[0]["current_count"], 1)

    def test_new_timestamped_event_counts_as_a_real_recurrence(self) -> None:
        first_line = "2026-07-14 10:00:00 WARNING [demo] device timed out"
        second_line = "2026-07-14 10:05:00 WARNING [demo] device timed out"
        first = MODULE.merge_issue_state({}, [self.issue(first_line)], self.args, "2026-07-14T10:00:01+00:00")
        combined = self.issue(f"{first_line}\n{second_line}")
        second = MODULE.merge_issue_state(
            {"issue_state": first},
            [combined],
            self.args,
            "2026-07-14T10:05:01+00:00",
        )
        self.assertEqual(second[0]["runs_seen"], 2)
        self.assertEqual(second[0]["occurrences"], 2)


class MonitorAtomicWriteTests(unittest.TestCase):
    def test_concurrent_writers_publish_one_complete_json_document(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            path = Path(tempdir) / "monitor.json"
            payloads = [
                {"writer": index, "blob": str(index) * 10000}
                for index in range(12)
            ]
            with ThreadPoolExecutor(max_workers=6) as executor:
                list(executor.map(lambda payload: MODULE.write_json_atomic(path, payload), payloads))

            published = json.loads(path.read_text(encoding="utf-8"))
            self.assertIn(published, payloads)
            self.assertEqual(list(Path(tempdir).glob(".monitor.json.tmp.*")), [])

    def test_saved_outputs_redact_fine_grained_github_tokens_and_jwts(self) -> None:
        github_token = "github_pat_11AA_bbCCddEEffGGhhIIjjKKllMMnnOOppQQ"
        jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJtb25pdG9yIn0.signature_value"
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            args = types.SimpleNamespace(
                state_file=root / "monitor.json",
                dispatch_file=root / "dispatch.json",
                history_file=root / "history.jsonl",
                task_dir=root / "tasks.d",
                history_limit=10,
            )
            summary = {
                "generated_at": "2026-07-15T12:00:00Z",
                "status": "warning",
                "checks": {"logs": {"sample": f"token={github_token} jwt={jwt}"}},
                "current_issues": [],
                "persistent_issues": [],
                "delta": {},
                "triage": {},
                "dispatch": {"text": f"review {github_token} and {jwt}"},
            }

            MODULE.save_summary(args, summary)

            published = "\n".join(
                path.read_text(encoding="utf-8")
                for path in (args.state_file, args.dispatch_file, args.history_file)
            )
            self.assertNotIn(github_token, published)
            self.assertNotIn(jwt, published)
            self.assertIn("[redacted-github-token]", published)
            self.assertIn("[redacted-jwt]", published)

    def test_monitor_cycle_serializes_prior_state_read_through_publication(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            args = types.SimpleNamespace(
                state_file=root / "monitor.json",
                dispatch_file=root / "dispatch.json",
                history_file=root / "history.jsonl",
                task_dir=root / "tasks.d",
                history_limit=10,
            )
            first_build_started = threading.Event()
            build_count = 0
            build_count_lock = threading.Lock()

            def build_from_prior_state(_args: types.SimpleNamespace) -> dict:
                nonlocal build_count
                previous = MODULE.load_state(_args.state_file)
                with build_count_lock:
                    build_count += 1
                    call_number = build_count
                if call_number == 1:
                    first_build_started.set()
                    time.sleep(0.15)
                counter = int(previous.get("counter") or 0) + 1
                return {
                    "generated_at": f"2026-07-15T12:00:0{counter}Z",
                    "status": "clean",
                    "counter": counter,
                    "current_issues": [],
                    "persistent_issues": [],
                    "delta": {},
                    "triage": {},
                    "dispatch": {},
                }

            with mock.patch.object(MODULE, "build_summary", side_effect=build_from_prior_state):
                with ThreadPoolExecutor(max_workers=2) as executor:
                    first = executor.submit(MODULE.collect_and_save_summary, args)
                    self.assertTrue(first_build_started.wait(timeout=1))
                    second = executor.submit(MODULE.collect_and_save_summary, args)
                    results = [first.result(timeout=2), second.result(timeout=2)]

            self.assertEqual([result["counter"] for result in results], [1, 2])
            self.assertEqual(MODULE.load_state(args.state_file)["counter"], 2)


if __name__ == "__main__":
    unittest.main()
