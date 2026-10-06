# Refundable principal implementation plan

**Goal:** Calculate owned refundable assets and remove only linked principal from activity.

**Architecture:** A pure reader consumes normalized assets, events and owned signed allocations. It neither stores data nor changes the raw ledger. Runtime catalog mapping and atomic publication remain separate owner contracts.

**Spec:** Funding increases a noncash asset; refunds and evidenced forfeitures decrease it. A principal link may cover part of an allocation. All amounts are integer minor units in an explicit currency. No FX, inferred shares, synthetic balancing entries or whole-parent exclusion.

## Review focus

- Mixed receipts preserve all unlinked income and expense amounts.
- Partial refunds cannot consume more principal than previously funded.
- The same allocation cannot be overallocated across assets.
- Same-day events are evaluated together, independently of input order.
- Forfeiture requires evidence but no fabricated financial allocation.

## Task

- [x] Write failing tests in `src/lib/finance/refundable-principal.spec.ts` for mixed flows, historical balances, partial refunds, forfeits, currency/sign mismatches, duplicate identities, overallocations and invalid dates/minor amounts.
- [x] Implement `refundablePrincipal(assets, events, allocations, asOf)` in `src/lib/finance/refundable-principal.ts`, returning per-asset balances and residual signed activity per allocation.
- [x] Run the full suite, static/format/build checks and targeted financial mutations; obtain fresh review.
- [x] Commit/push a source-only branch and draft PR. Runtime writer, catalog fields and chart integration remain explicitly inactive.

Validation: 208 tests passed, five financial mutations caught, static analysis and formatting passed, production build passed. Fresh review found no correctness blockers; cumulative precision and historical-view activity regression cases were added. No runtime state, chart integration, resources or deployment changed.
