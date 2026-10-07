# Finance run lifecycle foundation

`src/lib/server/finance-run-store.ts` implements a bounded durable launch, claim,
read and cancellation lifecycle. It consumes the canonical finance run wire
request parsers and digest functions. It is not a launch service or an activated
API. No route, authentication layer, binding, host enrollment, native instruction,
or deployment is supplied.

## Storage seam

`RunStorage.transaction(callback)` must execute the synchronous callback under a
real serialized write transaction and commit every statement together, or roll
back every statement on any exception. `RunSql.get` and `run` must use that same
connection/transaction. Bindings are parameters, never interpolated SQL. Returning
a Promise from the callback or running each statement independently is not a
valid implementation. The synchronous service policy resolvers execute within
that transaction; they must return a current, trusted registry snapshot and must
not start network or native work.

The supplied SQL is isolated in `finance-run-migrations/0001_lifecycle.sql`.
It is not part of an existing runtime migration path. Applying it requires an
approved Networth-owned store and a supported adapter/migration runner.
Tests use real, file-backed `node:sqlite` with `BEGIN IMMEDIATE`, `COMMIT`,
`ROLLBACK`, a busy timeout, and `synchronous=FULL`. They also use independent
worker connections to the same file and an abrupt worker exit before commit.
This demonstrates SQLite behavior. It does not demonstrate a D1 transaction
adapter, deployed durability, native launch, or network authentication. D1's
prepare/batch API must not be cast to this callback interface. A deployment
adapter must prove the same transaction boundaries before use.

## Implemented decisions

- A trusted caller supplies an authenticated principal separately from launch
  JSON. Structural validation and the original request digest precede storage
  lookup. The `(principal, request_id)` receipt is resolved before mutable
  registry eligibility. Identical replay returns the original receipt even after
  claim/cancel or registry drift; changed payload conflicts.
- Only a new request resolves eligible account/source identities. The exact
  requested account set and tracking task IDs are frozen; missing, duplicate, or
  substituted resolved accounts reject the request. Absent service policy is
  unavailable. The domain is service configuration, never browser input.
- A partial unique database index reserves the physical domain globally across
  principals. Foreign-principal collisions disclose only `domain_busy`. A launch
  receipt and its reservation are committed in the same transaction.
- Claim callers must already be authenticated as enrolled hosts. The current
  service-owned host resolver checks enabled status, principal, and domain on
  every call, including replay. Rebinding cannot expose an earlier principal's
  receipt. `(host, request_id)` persists both successful and null claims. Replaying
  an empty poll cannot acquire a later run; a new poll requires a new request ID.
  `wait_seconds` is validated/digested, but waiting/long polling is not implemented
  in this store.
- A claim commits one immutable host, opaque lease generation, and host-operation
  intent together with its exact original receipt before any future native action
  could be attempted. There is no lease expiry takeover or rebinding operation.
  Receipt replay is recovery information, never authorization to repeat a native
  operation or continue after cancellation.
- Cancel serializes with claim. A provably unclaimed run acknowledges
  `server_unclaimed`, closes capture and releases the reservation atomically.
  Claimed cancellation remains `requested` with reservation held. There is no
  claimed-release method. SQL constraints/triggers protect immutable identity,
  binding, sticky cancellation/closure, and retained receipts.
- Reads/cancellation require the owning principal and conceal foreign-run
  existence. Storage exceptions remain internal; a future route must return
  generic errors without SQL, identifiers, or provider evidence.

## Explicitly unimplemented

Start authorization, readiness proof verification, instruction IDs/delivery,
sequenced event decisions and rejected-slot receipts, conversation receipts,
account progress, review state, source checkpoints, quiescence verification,
claimed reservation release, host revocation/reconciliation, authentication,
enrollment, long polling, and native actions are not implemented. There is no
start or event API to which a client can submit a readiness boolean. Future
readiness must use service-owned authoritative proof verification, unavailable by
default, and revalidate frozen eligibility before authorizing any finance access.
The lifecycle schema deliberately cannot represent running collection or release
a claimed reservation; extending it requires the remaining evidence/state rules.

Operational policy remains outbound host polling without a public host listener;
native Claude defaults first, Codex defaults only after a definitively unavailable
or exhausted-credit outcome. This foundation does not select or launch a provider.
The host journal still owns native-operation intent/recovery and at-most-one
attempted instruction delivery. No test here establishes end-to-end launch
readiness or authorizes deployment/enrollment.

Validation: `bun run test src/lib/server/finance-run-store.spec.js`, followed by
the project test/static/build checks. Tests use synthetic IDs and remove their
private temporary database files, including worker connections, after completion.
