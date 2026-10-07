-- This operational store is owned by Networth. Applying it requires release review.
CREATE TABLE IF NOT EXISTS finance_runs (
  run_id TEXT PRIMARY KEY,
  principal TEXT NOT NULL,
  request_id TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  domain_id TEXT NOT NULL,
  snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),
  host_operation_intent INTEGER NOT NULL DEFAULT 0 CHECK(host_operation_intent IN (0,1)),
  UNIQUE(principal, request_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS finance_runs_browser_reservation
  ON finance_runs(domain_id) WHERE json_extract(snapshot, '$.reservation') = 'held';
