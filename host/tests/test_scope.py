import unittest

from networth_host.control import ScopeError, preflight_batch, validate_control


class ScopeTests(unittest.TestCase):
    def test_incoming_unselected_sibling_rejects_whole_batch(self):
        batch = [{"id": "raw-a", "account_id": "a"}, {"id": "raw-b", "account_id": "b"}]
        with self.assertRaises(ScopeError):
            preflight_batch({"a"}, batch, {})

    def test_same_id_stored_under_unselected_account_rejects(self):
        with self.assertRaises(ScopeError):
            preflight_batch(
                {"a"},
                [{"id": "raw-1", "account_id": "a"}],
                {"raw-1": {"id": "raw-1", "account_id": "b"}},
            )

    def test_same_id_cannot_move_between_two_selected_accounts(self):
        with self.assertRaises(ScopeError):
            preflight_batch(
                {"a", "b"},
                [{"id": "raw-1", "account_id": "a"}],
                {"raw-1": {"id": "raw-1", "account_id": "b"}},
            )

    def test_missing_stored_account_binding_is_not_safe_to_update(self):
        with self.assertRaises(ScopeError):
            preflight_batch(
                {"a"}, [{"id": "raw-1", "account_id": "a"}], {"raw-1": {"id": "raw-1"}}
            )

    def test_duplicate_source_ids_reject_before_first_mutation(self):
        row = {"id": "raw-1", "account_id": "a"}
        with self.assertRaises(ScopeError):
            preflight_batch({"a"}, [row, row], {})

    def test_valid_batch_retains_input_order_and_exact_target_binding(self):
        batch = [{"id": "raw-2", "account_id": "b"}, {"id": "raw-1", "account_id": "a"}]
        self.assertEqual(
            preflight_batch({"a", "b"}, batch, {"raw-1": batch[1]}),
            (("raw-2", "b"), ("raw-1", "a")),
        )

    def test_control_rejects_cancel_closed_scope_drift_or_old_lease(self):
        expected = {
            "run_id": "r",
            "host_id": "h",
            "lease_generation": "g",
            "account_ids": ["a"],
        }
        good = expected | {
            "cancel_requested": False,
            "capture_closed": False,
            "scope_eligible": True,
        }
        validate_control(expected, good)
        for changes in (
            {"cancel_requested": True},
            {"capture_closed": True},
            {"lease_generation": "old"},
            {"account_ids": ["a", "b"]},
            {"scope_eligible": False},
            {"host_id": "foreign"},
        ):
            with self.subTest(changes=changes), self.assertRaises(ScopeError):
                validate_control(expected, good | changes)

    def test_missing_or_malformed_control_cannot_be_treated_as_continue(self):
        expected = {
            "run_id": "r",
            "host_id": "h",
            "lease_generation": "g",
            "account_ids": ["a"],
        }
        for control in ({}, expected, expected | {"cancel_requested": "false"}):
            with self.subTest(control=control), self.assertRaises(ScopeError):
                validate_control(expected, control)
