# Interactive markers implementation plan

**Goal:** Add point and inclusive date-range annotations through the dashboard, following the existing marker editors.

**Architecture:** Networth owns its marker D1 binding and migration. Its authenticated Worker exposes per-marker CRUD with revision preconditions. Calendar dates are UTC labels, independent of financial rows. A dialog edits markers, and the chart draws point rules/range bands with accessible labels and an exhaustive list.

**Constraints:** Source-only feature branch. No provisioning, deployment, credentials, financial writes or personal fixtures. A missing database produces an explicit unavailable state. Free-text marker content disappears while amounts are concealed; editing is disabled. Date/relative geometry may remain visible. No content lives in source or localStorage.

**Design choices:** An omitted end date means a point; an inclusive end date on/after the start means a range. Titles are trimmed, bounded to 200 characters, rendered as text. Each edit/delete supplies the exact integer revision last read; conflicts preserve the draft and require an explicit reload. Separate marker writes do not overwrite other markers.

## Review focus

- Impossible dates and malformed/unknown inputs must reject before storage.
- Concurrent edits/deletes must not silently overwrite an intervening change.
- Partial weeks/months and ranges crossing the viewport must remain visible at their containing buckets.
- Hiding amounts must remove free-text from labels, tooltips, accessible names, lists and editors immediately.
- Missing storage, failed requests and conflicts must preserve financial rendering and unsaved edits.

## Tasks

- [x] Test marker validation, UTC bucket intersection, concealed labels and lane bounds; implement the shared model/helpers.
- [x] Test actual SQL CRUD and revision races with SQLite; implement the route, migration and unprovisioned owning D1 declaration.
- [x] Reproduce missing marker interaction in the local browser; implement dialog, loading/error handling and chart rules/bands/accessible marker list.
- [x] Run full tests, static checks, formatting, build, browser CRUD/reload/conflict/privacy/mobile checks and focused mutations. Obtain fresh review.

Integration: push the feature branch and open a draft PR stacked on date viewport; remote activation stays outside this source-only change.

## Verification ledger

- Baseline: 190 tests passed at the date-viewport parent commit.
- Precedent: ScreenTime uses individual D1 marker CRUD; Task Burndown already has its own R2 editor. Only code patterns are reused.

- Model/API: 25 added tests, including actual SQLite schema and conditional CRUD.
- Browser: local synthetic finance proxy plus real local D1; point/range create, update, stale conflict with draft preserved, explicit reload, sibling-safe delete, persisted reload, concealment and concealed reload, 390px editor/chart overflow check, dense 12-marker list, month/week buckets, crossing range, and offline draft retention passed.
- Browser found the copied month-label convention did not match this chart. An actual bucketize integration regression failed first, then passed with canonical comparison labels.
- Seven focused mutants were killed by assertion failures: privacy text, overlap selection, monthly normalization, edit revision delete revision creation replay and deleted identity retention.
- Fresh review found ambiguous creation retries could duplicate markers. A failing regression drove stable draft UUIDs and exact-payload replay; the real-browser lost-acknowledgement retry leaves exactly one row. A second failing regression verifies deleted marker IDs stay consumed without retaining deleted content.
- Final checks: 215 tests passed, Svelte check reported zero errors/warnings, production build succeeded, formatting and provisioner static/parse-only checks passed.
- Storage remains unprovisioned. No remote resource, credential, finance data, deployment or task-status changes.
