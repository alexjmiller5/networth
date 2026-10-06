import tempfile
import unittest
from pathlib import Path

from networth_host.journal import Conflict, Journal


class OutboxTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "state.sqlite3"
        self.journal = Journal(self.path)
        self.addCleanup(self.journal.close)

    def test_restart_replays_exact_payload_until_definitive_ack(self):
        payload = {"event_id": "e7", "sequence": 7, "expected_revision": 10}
        self.journal.retain("run-1/events", "e7", payload)
        second = Journal(self.path)
        self.addCleanup(second.close)
        self.assertEqual(second.pending("run-1/events"), payload)
        with self.assertRaises(Conflict):
            second.retain("run-1/events", "e8", {"event_id": "e8", "sequence": 8})
        with self.assertRaises(Conflict):
            second.retain("run-1/events", "e7", payload | {"expected_revision": 11})

    def test_definitive_rejection_unblocks_next_event_and_late_ack_is_idempotent(self):
        self.journal.retain("run-1/events", "e7", {"sequence": 7, "expected_revision": 10})
        decision = {
            "outcome": "rejected_not_applied",
            "consumed_sequence": 7,
            "revision": 11,
        }
        self.journal.acknowledge("run-1/events", "e7", decision)
        self.journal.retain("run-1/events", "e8", {"sequence": 8, "expected_revision": 11})
        self.journal.acknowledge("run-1/events", "e7", decision)
        self.assertEqual(
            self.journal.pending("run-1/events"),
            {"sequence": 8, "expected_revision": 11},
        )
        with self.assertRaises(Conflict):
            self.journal.acknowledge("run-1/events", "e7", {"outcome": "applied"})

    def test_cross_run_ack_cannot_clear_pending(self):
        self.journal.retain("run-1/events", "e1", {"sequence": 1})
        with self.assertRaises(Conflict):
            self.journal.acknowledge("run-2/events", "e1", {"outcome": "applied"})
        self.assertEqual(self.journal.pending("run-1/events"), {"sequence": 1})

    def test_pending_poll_is_stable_across_wait_changes_and_restart(self):
        first = self.journal.poll_request(25)
        second = Journal(self.path)
        self.addCleanup(second.close)
        self.assertEqual(second.poll_request(10), first)
        second.complete_poll(first["request_id"])
        next_poll = second.poll_request(10)
        self.assertNotEqual(next_poll["request_id"], first["request_id"])
        self.assertEqual(next_poll["wait_seconds"], 10)
        with self.assertRaises(Conflict):
            second.complete_poll(first["request_id"])

    def test_late_message_cannot_be_requeued_for_delivery(self):
        self.journal.retain("run-1/events", "e1", {"sequence": 1})
        self.journal.acknowledge("run-1/events", "e1", {"outcome": "applied"})
        self.journal.retain("run-1/events", "e1", {"sequence": 1})
        self.assertIsNone(self.journal.pending("run-1/events"))
