# Finance run wire contract implementation plan

**Goal:** Pin the shared host/site messages without activating routes or collection.

**Architecture:** One dependency-free TypeScript module defines JSON DTOs and pure boundary helpers. The host owns its journal and native lifecycle; the site owns authenticated state transitions. The contract module grants no authority.

**Spec:** The owner-reviewed transport revision 3. Operational evidence stays outside git.

**Constraints:** No host, deployment, resource, credential, schema or financial data changes. IDs are opaque and remain byte-exact. Missing readiness never permits collection. Replay is reconciliation, not permission to deliver another prompt.

## Implementation

- [x] Add failing tests for strict launch/claim/start parsing, byte-exact canonical scope digest, durable event decisions and fail-closed start readiness.
- [x] Implement `src/lib/finance/run-contract.ts` and adjacent `run-contract.spec.ts`. Define claims/control, discriminated events and durable decisions, start instruction identity, readiness, and non-consuming errors. Document rejected-slot consumption and immutable replay semantics.
- [x] Verify targeted tests, full suite, static checks, formatting and focused mutations. Publish an isolated branch commit and hand it to the host owner.

## Review focus

- Unknown fields must not smuggle commands or model policy into requests.
- Duplicate IDs, malformed Unicode and unsafe integers must reject without normalizing identity.
- Reordering scope must preserve digest; changing scope must change it.
- A rejected event consumes its own sequence while retaining the original decision; a transport failure is not that receipt.
- Readiness, cancellation, reservation and closed capture must each independently prevent start.

## Verification ledger

- Request boundary tests first failed for the missing module, then passed.
- Digest tests first failed for missing canonical helpers, then matched independent Python golden vectors.
- Fresh read-only review found BOM handling and negative-zero parsing inconsistencies. Both were reproduced with failing tests and fixed. These affect byte-exact cross-language identity, so they were treated as contract correctness fixes before pinning.
- Generic wire contract only; no active route, infrastructure or runtime behavior changed. No AGENTS.md update needed.
- Final verification: 160 tests passed; svelte-check zero errors/warnings; full-repository formatting passed. Four mutations were caught: closed-capture guard, duplicate-scope guard, consumed-slot match, and UTF-8 object ordering.
