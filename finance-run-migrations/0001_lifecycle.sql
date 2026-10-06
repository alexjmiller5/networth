-- Apply only to a Networth-owned SQLite-compatible store through its supported adapter.
-- No runtime binding or migration runner is activated by this file.
CREATE TABLE finance_runs (
 run_id TEXT PRIMARY KEY NOT NULL,
 principal_id TEXT NOT NULL,
 domain_id TEXT NOT NULL,
 scope_json TEXT NOT NULL CHECK(json_valid(scope_json)),
 task_ids_json TEXT NOT NULL CHECK(json_valid(task_ids_json)),
 revision INTEGER NOT NULL CHECK(revision >= 1),
 transport TEXT NOT NULL CHECK(transport IN ('queued','claimed')),
 collection TEXT NOT NULL CHECK(collection IN ('not_started','cancelled')),
 cancellation TEXT NOT NULL CHECK(cancellation IN ('none','requested','acknowledged')),
 reservation TEXT NOT NULL CHECK(reservation IN ('held','released')),
 capture_closed INTEGER NOT NULL CHECK(capture_closed IN (0,1)),
 host_id TEXT,
 lease_generation TEXT UNIQUE,
 host_intent_id TEXT UNIQUE,
 CHECK((host_id IS NULL AND lease_generation IS NULL AND host_intent_id IS NULL AND transport='queued') OR
       (host_id IS NOT NULL AND lease_generation IS NOT NULL AND host_intent_id IS NOT NULL AND transport='claimed')),
 -- This foundation releases ONLY proven-unclaimed requests. Claimed quiescence
 -- and collection lifecycle require a later evidence-verifying implementation.
 CHECK((reservation='held' AND capture_closed=0 AND collection='not_started' AND cancellation IN ('none','requested')) OR
       (reservation='released' AND capture_closed=1 AND collection='cancelled' AND cancellation='acknowledged' AND host_id IS NULL))
);
CREATE UNIQUE INDEX finance_one_held_domain ON finance_runs(domain_id) WHERE reservation='held';
CREATE TABLE finance_launch_receipts (
 principal_id TEXT NOT NULL,
 request_id TEXT NOT NULL,
 request_digest TEXT NOT NULL,
 receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
 run_id TEXT NOT NULL REFERENCES finance_runs(run_id),
 PRIMARY KEY(principal_id,request_id)
);
CREATE TABLE finance_claim_receipts (
 host_id TEXT NOT NULL,
 request_id TEXT NOT NULL,
 principal_id TEXT NOT NULL,
 domain_id TEXT NOT NULL,
 request_digest TEXT NOT NULL,
 receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
 PRIMARY KEY(host_id,request_id)
);
CREATE TRIGGER finance_run_immutable BEFORE UPDATE ON finance_runs
 WHEN NEW.run_id IS NOT OLD.run_id OR NEW.principal_id IS NOT OLD.principal_id OR
 NEW.domain_id IS NOT OLD.domain_id OR NEW.scope_json IS NOT OLD.scope_json OR
 NEW.task_ids_json IS NOT OLD.task_ids_json OR NEW.revision != OLD.revision+1 OR
 (OLD.host_id IS NOT NULL AND (NEW.host_id IS NOT OLD.host_id OR
  NEW.lease_generation IS NOT OLD.lease_generation OR NEW.host_intent_id IS NOT OLD.host_intent_id)) OR
 (OLD.cancellation='requested' AND NEW.cancellation='none') OR
 (OLD.cancellation='acknowledged' AND NEW.cancellation!='acknowledged') OR
 (OLD.capture_closed=1 AND NEW.capture_closed!=1) OR
 (OLD.reservation='released' AND NEW.reservation!='released')
 BEGIN SELECT RAISE(ABORT,'Invalid run transition'); END;
CREATE TRIGGER finance_run_retained BEFORE DELETE ON finance_runs
 BEGIN SELECT RAISE(ABORT,'Run history is retained'); END;
CREATE TRIGGER finance_launch_receipt_immutable BEFORE UPDATE ON finance_launch_receipts
 BEGIN SELECT RAISE(ABORT,'Launch receipt is immutable'); END;
CREATE TRIGGER finance_launch_receipt_retained BEFORE DELETE ON finance_launch_receipts
 BEGIN SELECT RAISE(ABORT,'Launch receipt is retained'); END;
CREATE TRIGGER finance_claim_receipt_immutable BEFORE UPDATE ON finance_claim_receipts
 BEGIN SELECT RAISE(ABORT,'Claim receipt is immutable'); END;
CREATE TRIGGER finance_claim_receipt_retained BEFORE DELETE ON finance_claim_receipts
 BEGIN SELECT RAISE(ABORT,'Claim receipt is retained'); END;
