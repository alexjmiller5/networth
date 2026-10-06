"""Durable outbound protocol driver. Native capture is deliberately unavailable.

No collector endpoint or capability is exposed by this module. It is the host
boundary, not a same-UID sandbox or authority supplied by a model's run ID.
"""

import uuid

from .journal import Conflict
from .wire import CLAIM_KEYS, ProtocolError, claim_binding, event_decision, safe_integer


class Companion:
    def __init__(self, journal, transport, host_id):
        self.journal, self.transport, self.host_id = journal, transport, host_id

    def poll_once(self, wait_seconds=25):
        active = self.journal.active()
        if active:
            # Do not claim again just because reports stopped or a lease expired.
            return self.control(active[0]["claim"]["run_id"])
        request = self.journal.poll_request(wait_seconds)
        response = self.transport.claim(request)
        if not isinstance(response, dict) or set(response) != {"claim"}:
            raise ProtocolError("invalid claim response")
        claim = response["claim"]
        if claim is not None:
            binding = claim_binding(claim, self.host_id)
            self.journal.bind(binding)
            self._lifecycle(claim)
        # Claim receipt persists first. A crash before clearing the poll is safe:
        # the active journal wins on restart, and no new native operation occurs.
        self.journal.complete_poll(request["request_id"])
        return claim

    def _lifecycle(self, control):
        if control["cancellation"] != "none":
            self.journal.cancel(control["run_id"])
        if control["capture_closed"]:
            self.journal.capture_closed(control["run_id"])

    def control(self, run_id):
        expected = self.journal.get(run_id)["claim"]
        control = self.transport.control(run_id)
        if not isinstance(control, dict) or not CLAIM_KEYS <= control.keys():
            raise ProtocolError("invalid control")
        binding = claim_binding({key: control[key] for key in CLAIM_KEYS}, self.host_id)
        for key in ("account_ids", "tracking_task_ids"):
            binding[key] = sorted(binding[key])
        if binding != expected:
            raise ProtocolError("control scope or lease changed")
        safe_integer(control.get("next_sequence"), 1)
        self._lifecycle(control)
        return control

    def queue_event(self, run_id, kind, payload):
        channel = run_id + "/events"
        if self.journal.pending(channel) is not None:
            raise Conflict("resolve original event before a new observation")
        current = self.control(run_id)
        if kind not in {
            "run_observed",
            "account_observed",
            "capture_finished",
            "capture_released",
            "review_observed",
        }:
            raise ProtocolError("unknown event kind")
        if kind == "account_observed" and payload.get("account_id") not in current["account_ids"]:
            raise ProtocolError("account event outside frozen scope")
        event = {
            "event_id": str(uuid.uuid4()),
            "sequence": current["next_sequence"],
            "expected_revision": current["revision"],
            "lease_generation": current["lease_generation"],
            "kind": kind,
            "payload": payload,
        }
        self.journal.retain(channel, event["event_id"], event)
        return event

    def flush_event(self, run_id):
        channel = run_id + "/events"
        event = self.journal.pending(channel)
        if event is None:
            return None
        decision = event_decision(event, self.transport.event(run_id, event))
        self.journal.acknowledge(channel, event["event_id"], decision)
        return decision

    def report_unavailable(self, run_id):
        reasons = {
            "native_identity": "native launch identity adapter not verified",
            "user_reachability": "no supported client-open acknowledgment",
            "collector_context": "authoritative local invocation binding unavailable",
            "source_controls": "installed source helpers are not yet controlled",
        }
        return self.queue_event(
            run_id,
            "run_observed",
            {
                "transport": "unavailable",
                "conversation": None,
                "readiness": {
                    key: {"state": "unavailable", "reason": reason}
                    for key, reason in reasons.items()
                },
            },
        )
