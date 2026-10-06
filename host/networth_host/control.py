"""Pre-write validation seam for run-aware source helpers.

Allowed accounts and control are supplied by the authenticated host binding,
never by a collector's --run-id or a caller-provided allowlist. Installed helpers
must call this before the entire batch, then fence each actual write primitive.
Preflight alone does not make later unguarded SQL safe against concurrent edits.
"""


class ScopeError(ValueError):
    pass


def validate_control(expected, control):
    for key in ("run_id", "host_id", "lease_generation"):
        if not expected.get(key) or control.get(key) != expected[key]:
            raise ScopeError("control identity changed")
    actual = control.get("account_ids")
    if not isinstance(actual, list) or actual != expected["account_ids"]:
        raise ScopeError("control scope changed")
    if (
        control.get("cancel_requested") is not False
        or control.get("capture_closed") is not False
        or control.get("scope_eligible") is not True
    ):
        raise ScopeError("collection control does not permit another operation")


def preflight_batch(allowed_accounts, incoming, existing):
    """Return immutable id/account write bindings only after checking ALL rows.

    The existing lookup must include tombstones and stored account_id, and be scoped
    to the same source/table as the write. Each later conditional mutation retains
    this binding; a failed/unknown primitive is reconciled before another attempt.
    """
    bindings = []
    seen = set()
    for row in incoming:
        row_id, account_id = row.get("id"), row.get("account_id")
        if not isinstance(row_id, str) or not row_id or row_id in seen:
            raise ScopeError("invalid or duplicate source identity")
        if not isinstance(account_id, str) or account_id not in allowed_accounts:
            raise ScopeError("incoming row is outside the frozen account scope")
        old = existing.get(row_id)
        if old is not None and (
            old.get("id") != row_id or old.get("account_id") != account_id
        ):
            raise ScopeError("stored target belongs to another or unknown account")
        seen.add(row_id)
        bindings.append((row_id, account_id))
    return tuple(bindings)
