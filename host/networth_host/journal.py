"""Private local recovery evidence, never a replacement for service authority.

Only the host adapter calls mutation methods. Collector input cannot certify its
own quiescence, change provider, or release the server's physical-domain lease.
"""

import json
import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path


class Conflict(ValueError):
    """An operation would discard recovery evidence or exceed a bound run."""


def canonical(value):
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )


class Journal:
    def __init__(self, path: Path):
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        os.close(fd)
        os.chmod(path, 0o600)
        self.db = sqlite3.connect(path, isolation_level=None, timeout=5)
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("""CREATE TABLE IF NOT EXISTS runs (
            id TEXT PRIMARY KEY, domain TEXT NOT NULL, closed INTEGER NOT NULL,
            state TEXT NOT NULL)""")
        self.db.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS active_domain ON runs(domain) WHERE closed=0"
        )

    def close(self):
        self.db.close()

    @contextmanager
    def transaction(self):
        self.db.execute("BEGIN IMMEDIATE")
        try:
            yield
            self.db.execute("COMMIT")
        except BaseException:
            self.db.execute("ROLLBACK")
            raise

    def get(self, run_id):
        row = self.db.execute("SELECT state FROM runs WHERE id=?", (run_id,)).fetchone()
        if row is None:
            raise Conflict("unknown run")
        return json.loads(row[0])

    def _save(self, state):
        self.db.execute(
            "UPDATE runs SET state=?, closed=? WHERE id=?",
            (canonical(state), int(state["capture_closed"]), state["claim"]["run_id"]),
        )

    def bind(self, claim):
        fields = {
            "run_id",
            "host_id",
            "domain_id",
            "lease_generation",
            "account_ids",
            "tracking_task_ids",
        }
        if set(claim) != fields:
            raise Conflict("unexpected claim fields")
        for key in fields - {"account_ids", "tracking_task_ids"}:
            if not isinstance(claim[key], str) or not claim[key].strip():
                raise Conflict("missing claim identity")
        for key in ("account_ids", "tracking_task_ids"):
            ids = claim[key]
            if not isinstance(ids, list) or not all(
                isinstance(i, str) and i.strip() for i in ids
            ):
                raise Conflict("invalid scope")
            if len(set(ids)) != len(ids) or (key == "account_ids" and not ids):
                raise Conflict("invalid scope")
        claim = claim | {
            "account_ids": sorted(claim["account_ids"]),
            "tracking_task_ids": sorted(claim["tracking_task_ids"]),
        }
        with self.transaction():
            old = self.db.execute(
                "SELECT state FROM runs WHERE id=?", (claim["run_id"],)
            ).fetchone()
            if old:
                if json.loads(old[0])["claim"] != claim:
                    raise Conflict("claim scope or generation changed")
                return
            state = {
                "claim": claim,
                "provider": "claude",
                "cancel_requested": False,
                "capture_closed": False,
                "operations": [],
                "quiescence": None,
                "instruction_attempted": False,
            }
            try:
                self.db.execute(
                    "INSERT INTO runs VALUES (?,?,0,?)",
                    (claim["run_id"], claim["domain_id"], canonical(state)),
                )
            except sqlite3.IntegrityError as exc:
                raise Conflict("domain already reserved") from exc

    @staticmethod
    def _open(state):
        if state["cancel_requested"] or state["capture_closed"]:
            raise Conflict("capture stopped")

    def begin_operation(self, run_id, kind, operation_id):
        if (
            kind not in {"tab_create", "agent_start", "collection_prompt"}
            or not operation_id
        ):
            raise Conflict("invalid operation")
        with self.transaction():
            state = self.get(run_id)
            self._open(state)
            if any(
                o["decision"] is None or o["id"] == operation_id
                for o in state["operations"]
            ):
                raise Conflict("operation requires reconciliation")
            if state["instruction_attempted"]:
                raise Conflict("collection instruction already attempted")
            if any(
                o["kind"] == kind and o["provider"] == state["provider"]
                for o in state["operations"]
            ):
                raise Conflict("native operation already attempted")
            state["operations"].append(
                {
                    "id": operation_id,
                    "kind": kind,
                    "provider": state["provider"],
                    "decision": None,
                }
            )
            if kind == "collection_prompt":
                state["instruction_attempted"] = True
            state["quiescence"] = None
            self._save(state)

    def resolve_operation(self, run_id, operation_id, outcome, receipt):
        if outcome not in {"applied", "not_applied"} or not isinstance(receipt, dict):
            raise Conflict("unknown outcomes must remain unresolved")
        with self.transaction():
            state = self.get(run_id)
            op = next((o for o in state["operations"] if o["id"] == operation_id), None)
            if op is None:
                raise Conflict("unknown operation")
            decision = {"outcome": outcome, "receipt": receipt}
            if op["decision"] is not None and op["decision"] != decision:
                raise Conflict("operation receipt changed")
            op["decision"] = decision
            self._save(state)

    def confirm_prestart_quiescence(self, run_id, operation_ids, proof_id):
        with self.transaction():
            state = self.get(run_id)
            if state["instruction_attempted"] or any(
                o["decision"] is None for o in state["operations"]
            ):
                raise Conflict("start or native operation may have happened")
            if not proof_id or sorted(operation_ids) != sorted(
                o["id"] for o in state["operations"]
            ):
                raise Conflict("quiescence must cover every native operation")
            state["quiescence"] = {"operation_ids": operation_ids, "proof_id": proof_id}
            self._save(state)

    def fallback(self, run_id, reason):
        with self.transaction():
            state = self.get(run_id)
            self._open(state)
            if (
                reason not in {"unavailable", "out_of_credits"}
                or state["provider"] != "claude"
            ):
                raise Conflict("provider fallback not allowed")
            if state["instruction_attempted"] or any(
                o["decision"] is None for o in state["operations"]
            ):
                raise Conflict("ambiguous launch must be reconciled")
            applied = any(
                o["decision"]["outcome"] == "applied" for o in state["operations"]
            )
            if applied and state["quiescence"] is None:
                raise Conflict("partial session must be quiescent first")
            state["provider"] = "codex"
            state["fallback_reason"] = reason
            self._save(state)

    def cancel(self, run_id):
        with self.transaction():
            state = self.get(run_id)
            state["cancel_requested"] = True
            self._save(state)

    def capture_closed(self, run_id):
        """Mirror a verified service release; never release a server lease locally."""
        with self.transaction():
            state = self.get(run_id)
            if any(o["decision"] is None for o in state["operations"]):
                raise Conflict("unresolved operation")
            state["capture_closed"] = True
            self._save(state)
