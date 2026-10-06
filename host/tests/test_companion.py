import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from networth_host.companion import Companion
from networth_host.journal import Conflict, Journal
from networth_host.transport import TransportError
from networth_host.wire import ProtocolError, digest


def claim():
    return {
        "run_id": "r",
        "host_id": "h",
        "domain_id": "d",
        "lease_generation": "g",
        "revision": 10,
        "account_ids": ["a"],
        "tracking_task_ids": ["t"],
        "cancellation": "none",
        "capture_closed": False,
    }


def control():
    unavailable = {"state": "unavailable", "reason": "not implemented"}
    return claim() | {
        "transport": "claimed",
        "collection": "not_started",
        "review": "not_started",
        "reservation": "held",
        "eligibility": {"state": "eligible", "checked_at": "2026-01-01T00:00:00Z"},
        "readiness": {
            key: unavailable
            for key in (
                "native_identity",
                "user_reachability",
                "collector_context",
                "source_controls",
            )
        },
        "start_instruction_id": None,
        "next_sequence": 7,
    }


class Service:
    """In-memory remote boundary; journal, protocol and companion stay real."""

    def __init__(self):
        self.polls = []
        self.events = []
        self.snapshot = control()
        self.lose_poll = False
        self.lose_event = False
        self.corrupt_ack = False

    def claim(self, request):
        self.polls.append(request)
        if self.lose_poll:
            self.lose_poll = False
            raise TransportError("lost claim acknowledgment")
        return {"claim": claim()}

    def control(self, run_id):
        return self.snapshot

    def event(self, run_id, event):
        self.events.append(event)
        if self.lose_event:
            self.lose_event = False
            raise TransportError("lost rejection acknowledgment")
        return {
            "event_id": event["event_id"],
            "sequence": event["sequence"],
            "consumed_sequence": event["sequence"],
            "lease_generation": event["lease_generation"],
            "decision_digest": "0" * 64 if self.corrupt_ack else digest(event),
            "revision": 11,
            "outcome": "rejected_not_applied",
            "reason": "revision_conflict",
        }


class CompanionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.journal = Journal(Path(self.tmp.name) / "state.sqlite3")
        self.addCleanup(self.journal.close)
        self.service = Service()
        self.client = Companion(self.journal, self.service, "h")

    def test_lost_claim_uses_exact_request_then_existing_run_prevents_new_claim(self):
        self.service.lose_poll = True
        with self.assertRaises(TransportError):
            self.client.poll_once()
        self.client.poll_once()
        self.assertEqual(self.service.polls[0], self.service.polls[1])
        self.client.poll_once()
        self.assertEqual(len(self.service.polls), 2)
        self.assertEqual(self.journal.get("r")["provider"], "claude")

    def test_cancel_race_lost_rejection_ack_replays_seq7_before_seq8(self):
        self.client.poll_once()
        original = self.client.queue_event("r", "review_observed", {"state": "pending"})
        self.assertEqual(original["sequence"], 7)
        self.service.snapshot |= {"revision": 11, "cancellation": "requested"}
        self.service.lose_event = True
        with self.assertRaises(TransportError):
            self.client.flush_event("r")
        with self.assertRaises(Conflict):
            self.client.queue_event("r", "review_observed", {"state": "pending"})
        self.client.flush_event("r")
        self.assertEqual(self.service.events, [original, original])
        self.service.snapshot["next_sequence"] = 8
        next_event = self.client.queue_event("r", "review_observed", {"state": "pending"})
        self.assertEqual((next_event["sequence"], next_event["expected_revision"]), (8, 11))
        self.assertTrue(self.journal.get("r")["cancel_requested"])

    def test_mismatched_ack_keeps_original_pending(self):
        self.client.poll_once()
        event = self.client.queue_event("r", "review_observed", {"state": "pending"})
        self.service.corrupt_ack = True
        with self.assertRaises(ProtocolError):
            self.client.flush_event("r")
        self.assertEqual(self.journal.pending("r/events"), event)

    def test_foreign_claim_is_not_recorded_and_poll_remains_unresolved(self):
        self.client.host_id = "another-host"
        with self.assertRaises(ProtocolError):
            self.client.poll_once()
        with self.assertRaises(Conflict):
            self.journal.get("r")
        self.assertEqual(self.journal.poll_request(25), self.service.polls[0])

    def test_scope_drift_and_lease_replacement_rejected_before_reporting(self):
        self.client.poll_once()
        for mutation in ({"account_ids": ["b"]}, {"lease_generation": "g2"}):
            self.service.snapshot = control() | mutation
            with self.assertRaises(ProtocolError):
                self.client.queue_event("r", "review_observed", {"state": "pending"})
        self.assertEqual(self.service.events, [])

    def test_current_runtime_never_claims_source_readiness_or_creates_native_session(
        self,
    ):
        self.client.poll_once()
        event = self.client.report_unavailable("r")
        self.assertEqual(event["payload"]["transport"], "unavailable")
        self.assertIsNone(event["payload"]["conversation"])
        self.assertTrue(
            all(x["state"] == "unavailable" for x in event["payload"]["readiness"].values())
        )
        self.assertEqual(self.journal.get("r")["operations"], [])
        self.assertFalse(self.journal.get("r")["instruction_attempted"])

    def test_unselected_account_event_rejected_before_durable_outbox(self):
        self.client.poll_once()
        with self.assertRaises(ProtocolError):
            self.client.queue_event("r", "account_observed", {"account_id": "b"})
        self.assertIsNone(self.journal.pending("r/events"))

    def test_stale_control_cannot_reuse_sequence_consumed_by_second_connection(self):
        self.client.poll_once()
        other_journal = Journal(Path(self.tmp.name) / "state.sqlite3")
        self.addCleanup(other_journal.close)
        other = Companion(other_journal, self.service, "h")
        raced = False

        def delayed_control(run_id):
            nonlocal raced
            snapshot = dict(self.service.snapshot)
            if not raced:
                raced = True
                other.queue_event("r", "review_observed", {"state": "pending"})
                other.flush_event("r")
                self.service.snapshot |= {"next_sequence": 8, "revision": 11}
            return snapshot

        with patch.object(self.service, "control", side_effect=delayed_control):
            with self.assertRaises(Conflict):
                self.client.queue_event("r", "review_observed", {"state": "completed"})
        self.assertIsNone(self.journal.pending("r/events"))
        event = self.client.queue_event("r", "review_observed", {"state": "completed"})
        self.assertEqual(event["sequence"], 8)
        self.client.flush_event("r")
        self.assertIsNone(other_journal.pending("r/events"))

    def test_noncanonical_event_never_poison_pending_slot(self):
        self.client.poll_once()
        with self.assertRaises(ProtocolError):
            self.client.queue_event("r", "review_observed", {"value": 0.5})
        self.assertIsNone(self.journal.pending("r/events"))
        event = self.client.queue_event("r", "review_observed", {"state": "pending"})
        self.assertEqual(event["sequence"], 7)
        self.client.flush_event("r")
        self.assertIsNone(self.journal.pending("r/events"))
