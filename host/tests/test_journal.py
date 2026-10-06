import tempfile
import unittest
from pathlib import Path

from networth_host.journal import Conflict, Journal


class JournalTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "state.sqlite3"
        self.journal = Journal(self.path)
        self.addCleanup(self.journal.close)
        self.claim = {
            "run_id": "run-1",
            "host_id": "host-1",
            "domain_id": "browser-1",
            "lease_generation": "generation-1",
            "account_ids": ["account-a"],
            "tracking_task_ids": ["task-a"],
        }
        self.journal.bind(self.claim)

    def test_restart_preserves_unresolved_native_creation_and_blocks_fallback(self):
        self.journal.begin_operation("run-1", "tab_create", "op-1")
        second = Journal(self.path)
        self.addCleanup(second.close)
        with self.assertRaises(Conflict):
            second.begin_operation("run-1", "tab_create", "op-2")
        with self.assertRaises(Conflict):
            second.fallback("run-1", "out_of_credits")
        self.assertEqual(second.get("run-1")["provider"], "claude")

    def test_definitively_unavailable_before_side_effects_allows_one_codex_default(
        self,
    ):
        self.journal.fallback("run-1", "unavailable")
        self.assertEqual(self.journal.get("run-1")["provider"], "codex")
        with self.assertRaises(Conflict):
            self.journal.fallback("run-1", "out_of_credits")

    def test_timeout_is_not_provider_unavailability(self):
        with self.assertRaises(Conflict):
            self.journal.fallback("run-1", "timeout")
        self.assertEqual(self.journal.get("run-1")["provider"], "claude")

    def test_created_resources_require_explicit_prestart_quiescence(self):
        self.journal.begin_operation("run-1", "tab_create", "op-1")
        self.journal.resolve_operation("run-1", "op-1", "applied", {"tab_id": "tab-1"})
        with self.assertRaises(Conflict):
            self.journal.fallback("run-1", "out_of_credits")
        with self.assertRaises(Conflict):
            self.journal.confirm_prestart_quiescence("run-1", [], "proof-1")
        self.journal.confirm_prestart_quiescence("run-1", ["op-1"], "proof-1")
        self.journal.fallback("run-1", "out_of_credits")
        self.assertEqual(self.journal.get("run-1")["provider"], "codex")

    def test_possibly_delivered_collection_instruction_never_triggers_fallback(self):
        self.journal.begin_operation("run-1", "collection_prompt", "op-1")
        with self.assertRaises(Conflict):
            self.journal.confirm_prestart_quiescence("run-1", ["op-1"], "proof-1")
        with self.assertRaises(Conflict):
            self.journal.fallback("run-1", "out_of_credits")

    def test_domain_reservation_survives_cancel_and_rebind(self):
        other = self.claim | {"run_id": "run-2", "host_id": "host-2"}
        self.journal.cancel("run-1")
        with self.assertRaises(Conflict):
            self.journal.bind(other)
        with self.assertRaises(Conflict):
            self.journal.begin_operation("run-1", "tab_create", "op-1")
        self.journal.capture_closed("run-1")
        self.journal.bind(other)
        with self.assertRaises(Conflict):
            self.journal.begin_operation("run-1", "tab_create", "op-2")

    def test_repeated_claim_cannot_reset_cancel_or_change_scope_generation(self):
        self.journal.cancel("run-1")
        self.journal.bind(self.claim)
        self.assertTrue(self.journal.get("run-1")["cancel_requested"])
        for changes in (
            {"lease_generation": "generation-2"},
            {"account_ids": ["account-b"]},
        ):
            with self.assertRaises(Conflict):
                self.journal.bind(self.claim | changes)

    def test_active_unresolved_operation_cannot_be_closed_or_overwritten(self):
        self.journal.begin_operation("run-1", "tab_create", "op-1")
        with self.assertRaises(Conflict):
            self.journal.capture_closed("run-1")
        self.journal.resolve_operation("run-1", "op-1", "not_applied", {})
        self.journal.resolve_operation("run-1", "op-1", "not_applied", {})
        with self.assertRaises(Conflict):
            self.journal.resolve_operation(
                "run-1", "op-1", "applied", {"tab_id": "tab-2"}
            )

    def test_second_process_respects_existing_domain(self):
        second = Journal(self.path)
        self.addCleanup(second.close)
        with self.assertRaises(Conflict):
            second.bind(self.claim | {"run_id": "run-2"})

    def test_local_state_is_private(self):
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)


if __name__ == "__main__":
    unittest.main()
