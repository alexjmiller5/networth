"""Python consumer of src/lib/finance/run-contract.ts, not a second API owner."""

import hashlib
import json


class ProtocolError(ValueError):
    pass


def canonical_request(value):
    def validate(item):
        if item is None or type(item) is bool:
            return
        if type(item) is int:
            if abs(item) > 9007199254740991:
                raise ProtocolError("unsafe integer")
            return
        if isinstance(item, str):
            try:
                item.encode("utf-8")
            except UnicodeError:
                raise ProtocolError("invalid Unicode") from None
            return
        if isinstance(item, list):
            for child in item:
                validate(child)
            return
        if isinstance(item, dict):
            for key, child in item.items():
                if not isinstance(key, str):
                    raise ProtocolError("invalid object key")
                validate(key)
                validate(child)
            return
        raise ProtocolError("noncanonical JSON value")

    validate(value)
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )


def digest(value):
    return hashlib.sha256(canonical_request(value).encode("utf-8")).hexdigest()


def parse_json(raw):
    def pairs(values):
        result = {}
        for key, value in values:
            if key in result:
                raise ProtocolError("duplicate JSON key")
            result[key] = value
        return result

    def integer(value):
        if value == "-0":
            raise ProtocolError("negative zero")
        return int(value)

    def forbidden(value):
        raise ProtocolError("noninteger number")

    try:
        value = json.loads(
            raw,
            object_pairs_hook=pairs,
            parse_int=integer,
            parse_float=forbidden,
            parse_constant=forbidden,
        )
        canonical_request(value)
        return value
    except (ValueError, UnicodeError, RecursionError):
        raise ProtocolError("invalid wire JSON") from None


def safe_integer(value, minimum=0):
    if type(value) is not int or not minimum <= value <= 9007199254740991:
        raise ProtocolError("invalid integer")
    return value


def identifier(value):
    if (
        not isinstance(value, str)
        or not value.strip()
        or len(value.encode("utf-8")) > 256
        or any(ord(c) < 32 or ord(c) == 127 for c in value)
    ):
        raise ProtocolError("invalid identity")
    return value


CLAIM_KEYS = {
    "run_id",
    "host_id",
    "domain_id",
    "lease_generation",
    "revision",
    "account_ids",
    "tracking_task_ids",
    "cancellation",
    "capture_closed",
}
BINDING_KEYS = CLAIM_KEYS - {"revision", "cancellation", "capture_closed"}


def claim_binding(claim, host_id):
    if not isinstance(claim, dict) or set(claim) != CLAIM_KEYS or claim["host_id"] != host_id:
        raise ProtocolError("invalid or foreign host claim")
    for key in ("run_id", "host_id", "domain_id", "lease_generation"):
        identifier(claim[key])
    safe_integer(claim["revision"])
    for key in ("account_ids", "tracking_task_ids"):
        ids = claim[key]
        if not isinstance(ids, list) or not 1 <= len(ids) <= 256:
            raise ProtocolError("invalid scope")
        for item in ids:
            identifier(item)
        if len(set(ids)) != len(ids):
            raise ProtocolError("duplicate scope identity")
    if (
        claim["cancellation"] not in {"none", "requested", "acknowledged"}
        or type(claim["capture_closed"]) is not bool
    ):
        raise ProtocolError("invalid claim lifecycle")
    return {key: claim[key] for key in BINDING_KEYS}


def event_decision(event, decision):
    required = {
        "event_id",
        "lease_generation",
        "sequence",
        "consumed_sequence",
        "decision_digest",
        "revision",
        "outcome",
        "reason",
    }
    if not isinstance(decision, dict) or set(decision) != required:
        raise ProtocolError("invalid event acknowledgment")
    safe_integer(decision["sequence"], 1)
    safe_integer(decision["consumed_sequence"], 1)
    safe_integer(decision["revision"])
    if (
        decision["event_id"] != event["event_id"]
        or decision["lease_generation"] != event["lease_generation"]
        or decision["sequence"] != event["sequence"]
        or decision["consumed_sequence"] != event["sequence"]
        or decision["decision_digest"] != digest(event)
    ):
        raise ProtocolError("acknowledgment does not match pending event")
    if decision["outcome"] == "applied" and decision["reason"] is None:
        return decision
    if decision["outcome"] == "rejected_not_applied" and decision["reason"] in {
        "revision_conflict",
        "invalid_transition",
        "scope_mismatch",
        "invalid_evidence",
        "capture_closed",
        "cancel_requested",
    }:
        return decision
    raise ProtocolError("not a definitive event decision")
