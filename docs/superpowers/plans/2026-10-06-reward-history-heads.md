# Reward history head selection implementation plan

> **For agentic workers:** Use superpowers:executing-plans with TDD and a fresh final review.

**Goal:** Select event and valuation heads without double-counting source revisions or hiding conflicts.

**Architecture:** Two pure readers consume complete immutable row sets. A small private chain walker diagnoses identity and predecessor failures per logical group. Public results retain original rows, chain history, a nullable head and explicit diagnostics; valuation results separately identify whether the head binds the current event observation.

**Tech Stack:** TypeScript and Vitest; no added dependencies.

**Spec:** Accepted Rewards runtime contract R2. This plan records only the generic consumer rules; private source evidence stays outside git.

## Constraints

- Event scope is the byte-exact tuple `(component_id, event_key)`. Never match by amount, date, provider name or snapshot differences.
- Each scope has one immutable linear chain. Duplicate IDs, forks, cycles, disconnected roots, missing or cross-scope predecessors fail affected groups closed.
- Reversals remain separate logical events; pending-to-posted versions select one head.
- All valuation bases and exact event revisions share one chain per logical redemption. No basis priority resolves a fork.
- A valid valuation head is current only when its exact `event_id` equals the selected event head. Older valuations remain historical and never rebase automatically.
- These readers check identity/chain membership, not complete row schemas, amounts, rates, authority or publication. Callers supply complete catalog-validated immutable rows. No routes, UI, runtime writes or activation.

## Review focus

- Duplicate IDs crossing groups must not make arbitrary lookup order select a winner.
- Missing event references and cross-scope valuation links must not preserve a falsely current predecessor.
- Invalid event history must prevent a valuation from becoming current.
- Input permutations, delimiter-containing IDs and timestamps must not change chain selection.
- A historical valuation remains visible after an event correction; a replacement must continue the original chain.

## Tasks

- [x] Write failing event tests in `src/lib/finance/reward-history.spec.ts`; implement `selectRewardEventHeads(events)` in `reward-history.ts`. Assert one posted head, separate reversal/sibling identities, preserved history and all structural diagnostics.
- [x] Write failing valuation tests; implement `selectRedemptionValuationHeads(events, valuations)`. Assert cross-basis/cross-version continuity, historical exact binding, conflicting/missing membership and affected-group isolation.
- [x] Run focused and full tests, structural mutations, Svelte check, formatting and production build. Obtain fresh read-only review.
Integration: commit/push `feat/reward-history-heads` and open a source-only draft PR stacked on date viewport.

## Verification ledger

- Accepted contract read in full and content hash verified before implementation.

- Baseline: 190 tests passed. Event selection: 12 failing cases became green; valuation selection: 12 more failures became green (25 focused tests total). Full suite: 215 passed.
- Ruling: a cross-scope predecessor closes both implicated groups because the extra successor makes the prior head ambiguous. Missing/ambiguous event references remain visible under a null scope.

- Final verification: all 215 tests passed; Svelte check reported zero errors/warnings; formatting and production build passed. Ten focused mutations were caught: scope identity, fork, cycle, duplicate identity, missing predecessor, multiple roots, cross-scope predecessor, exact event binding, invalid event history and redemption kind.
- Fresh independent review found no blockers. No runtime/UI integration, financial data writes or deployment occurred. Existing AGENTS.md rules remain sufficient; function comments document complete-row-set and catalog-validation prerequisites.
