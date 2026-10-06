import json
import unittest
from pathlib import Path

from networth_host.wire import (
    ProtocolError,
    canonical_request,
    digest,
    event_decision,
    parse_json,
)


class WireTests(unittest.TestCase):
    def test_pinned_typescript_contract_golden_vectors(self):
        vectors = json.loads(Path(__file__).with_name("run-contract.golden.json").read_text())
        for vector in vectors:
            with self.subTest(name=vector["name"]):
                self.assertEqual(canonical_request(vector["request"]), vector["canonical"])
                self.assertEqual(digest(vector["request"]), vector["sha256"])

    def test_max_safe_integer_and_unicode_match_canonical_owner_vector(self):
        request = {
            "instruction_id": "instruction-β",
            "expected_revision": 9007199254740991,
            "lease_generation": "lease-α",
        }
        self.assertEqual(
            canonical_request(request),
            '{"expected_revision":9007199254740991,"instruction_id":"instruction-β","lease_generation":"lease-α"}',
        )
        self.assertEqual(
            digest(request),
            "da61c4860de5807e04fa93cf112bb11563308e410176189afc9ad5f4d8a9e62a",
        )

    def test_invalid_numeric_or_unicode_values_fail_before_send(self):
        for value in (
            1.0,
            -0.0,
            float("nan"),
            9007199254740992,
            "\ud800",
            {1: "value"},
        ):
            with self.subTest(value=repr(value)), self.assertRaises(ProtocolError):
                canonical_request(value)

    def test_wire_decode_rejects_duplicates_float_negative_zero_and_invalid_utf8(self):
        for raw in (
            b'{"x":1,"x":2}',
            b'{"x":-0}',
            b'{"x":1.0}',
            b'{"x":NaN}',
            b'"\xff"',
        ):
            with self.subTest(raw=raw), self.assertRaises(ProtocolError):
                parse_json(raw)

    def test_rejected_slot_ack_consumes_exact_original_sequence(self):
        event = {
            "event_id": "e7",
            "sequence": 7,
            "expected_revision": 10,
            "lease_generation": "g",
            "kind": "review_observed",
            "payload": {"state": "pending"},
        }
        ack = {
            "event_id": "e7",
            "lease_generation": "g",
            "sequence": 7,
            "consumed_sequence": 7,
            "decision_digest": digest(event),
            "revision": 11,
            "outcome": "rejected_not_applied",
            "reason": "revision_conflict",
        }
        self.assertEqual(event_decision(event, ack), ack)
        for changes in (
            {"event_id": "e8"},
            {"consumed_sequence": 6},
            {"lease_generation": "other"},
            {"decision_digest": "0" * 64},
            {"sequence": True},
            {"reason": None},
            {"outcome": "pending"},
            {"revision": -1},
        ):
            with self.subTest(changes=changes), self.assertRaises(ProtocolError):
                event_decision(event, ack | changes)

    def test_applied_ack_cannot_carry_a_rejection_reason(self):
        event = {"event_id": "e1", "sequence": 1, "lease_generation": "g"}
        ack = {
            "event_id": "e1",
            "sequence": 1,
            "consumed_sequence": 1,
            "lease_generation": "g",
            "revision": 2,
            "decision_digest": digest(event),
            "outcome": "applied",
            "reason": "revision_conflict",
        }
        with self.assertRaises(ProtocolError):
            event_decision(event, ack)
