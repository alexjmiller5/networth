# Finance run persistence

The source-only `FinanceRuns` repository stores launch requests and physical browser
reservations in a Networth-owned D1 database. The migration is isolated in
`migrations/finance-runs/`; no binding or production route activates this store.

Request identity is scoped to the authenticated principal. An exact request retry
returns the existing run before consulting the current account registry or browser
configuration. Scope arrays are byte-sorted and frozen. Different payloads under
one request ID conflict. The physical browser domain has one global active
reservation, including across principals; conflicts disclose only `domain_busy`.

The cancellation and reservation-claim statements serialize in SQLite. Canceling
an unclaimed run closes capture and releases the reservation without claiming a
collector ran. A claim first commits its host-operation intent and immutable lease
identity. Cancellation of a claimed run stays requested and retains ownership;
remote silence or lease expiry does not release it. There is no method to reopen
capture or discard an ambiguous reservation.

This is a persistence slice, not the advertised claims endpoint. Callers must
verify their principal/host identity and configured physical domain. The site still
needs authenticated routes and host enrollment, durable claim retry receipts,
start/event decisions, eligibility/evidence validation and host quiescence receipts.
Native session identity, client-open acknowledgment, collector-context binding
and mandatory source checkpoints remain prerequisites before collection.

The repository tests execute its production SQL against real SQLite, including
restart, concurrent duplicate requests, cross-principal reservations, and both
cancel/claim orderings. Run them with `bun run test -- src/lib/server/finance-runs.spec.ts`.
