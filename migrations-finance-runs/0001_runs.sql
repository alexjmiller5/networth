CREATE TABLE finance_runs (
 id TEXT PRIMARY KEY,
 request_id TEXT NOT NULL UNIQUE,
 account_ids TEXT NOT NULL CHECK(json_valid(account_ids)),
 status TEXT NOT NULL CHECK(status IN ('queued','claimed','running','done','failed','canceled')),
 cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1)),
 host_id TEXT,
 tab_id TEXT,
 pane_id TEXT,
 tab_label TEXT,
 agent_name TEXT,
 agent_kind TEXT,
 summary TEXT,
 created_at INTEGER NOT NULL,
 claimed_at INTEGER,
 started_at INTEGER,
 finished_at INTEGER,
 updated_at INTEGER NOT NULL
);
-- One active run at a time: every non-terminal row shares the constant key.
CREATE UNIQUE INDEX finance_one_active_run ON finance_runs((1))
 WHERE status IN ('queued','claimed','running');
CREATE INDEX finance_runs_created ON finance_runs(created_at DESC);
