# Benefit observations

`/benefits` shows provider-native benefit plans and dated observations from
`/api/benefits`. The server uses the existing Networth `SOMA_HUB_URL` and
`SOMA_HUB_TOKEN` service configuration, with its read-only Soma profile.
No resource, credential, or data-write path is added.

The endpoint requests only `benefit_plans` and `benefit_snapshots`, with fixed
column allowlists. It requests the supported complete-table response initially, then follows any
returned Soma rows-pull `next_cursor` / `after` with bounded 200-row pages,
uses one deadline per table, and rejects redirects, malformed pages, and
nonadvancing cursors. A later-page failure rejects the whole result. Required
source evidence references are validated server-side and omitted from the browser
model. Extra upstream fields cannot pass through.

Plans retain their identity across years. Observations are grouped by plan and
year, then ordered by explicit source date descending and capture time descending.
An older source date never becomes the latest because it was captured again.
Unknown source dates sort after dated observations and display as unknown. Capture
times are labelled separately in UTC. All observations remain available in the
history disclosure; there is no inferred historical interpolation.

Election, employee contributions, submitted/paid/denied claims, available benefit,
notional credit, and vested balance are separate source facts. The view performs
no accounting arithmetic or cross-currency totals. Missing values remain null;
explicit zero remains zero. Suppressed or unexposed vested amounts must be null.
Benefits do not produce cash transactions, reimbursements, liquid assets, or
net-worth totals.

Amount concealment reads the existing device-local `networth-ui.hideAmounts`
preference before rendering and updates only that field. It also conceals freeform
eligibility text, which can contain amounts. This is visual concealment, matching
the main dashboard; source values remain in device memory and its offline cache.
Reload fetches saved source observations, not a new provider collection. A failed
reload preserves the previous view. Cached reads show the cache save timestamp,
which is distinct from provider and capture dates.

The dashboard links to `/benefits`, which includes a return link. Navigation keeps
the saved dashboard filters and shared privacy preference. `/api/finance` is
unchanged. Deployment and authenticated live verification are separate steps.

Validation uses synthetic fixtures only: model/API unit tests and
`scripts/test-benefits.mjs <owned-CDP-page-websocket> <local-dev-base-URL>`.
The browser driver checks privacy before paint and after reload, native metrics,
zero/missing/suppressed states, history, dashboard navigation, failed refresh, empty state, and 390px
layout. It only intercepts reads on its own local test target. Optional
`BENEFITS_SCREENSHOT` writes its mobile screenshot to the requested path.
