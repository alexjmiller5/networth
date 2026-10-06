# Raw price observations

`src/lib/finance/prices.server.ts` exposes `fetchPriceHistory(request, options)`.
It is a server-only read adapter with no ambient credentials, persistence,
valuation integration, or scheduled requests. `prices.ts` contains the pure parser
and result types. No provider request runs until a server caller invokes it.

A request supplies an opaque instrument ID, provider identifier, explicit ISO
currency, and inclusive `YYYY-MM-DD` interval. The finance-owned runtime mapping
must establish the exact instrument/share class and currency. Fidelity identifiers
are numeric issuer fund IDs; Alpha Vantage identifiers are provider symbols. A
syntactically valid identifier does not prove economic identity. Mapping evidence
must be verified before using observations for valuation.

The caller supplies an Alpha Vantage server key through `alphaVantageKey`; missing
keys return `missing-key` without network access. Keys are not returned, logged,
or persisted. Requests have a ten-second bound, reject redirects, and do not
retry. Optional `fetcher` and `now` seams allow synthetic testing.

## Result semantics

- Prices remain exact nonnegative decimal strings, including explicit zero.
  Empty Fidelity NAV is a gap, never zero. Dates, decimal strings, duplicate dates,
  provider identity, and any reported currency are validated before any rows are
  accepted. Invalid responses return no observations.
- `basis` is `raw-nav` for Fidelity or `raw-close` for Alpha Vantage. Adjusted close
  is never substituted. A consumer must handle splits and cash distributions
  separately, with dated holdings and cash evidence.
- Currency is required from the runtime mapping because these feeds can omit it.
  `currencySource` distinguishes mapping from provider provenance; a conflicting
  reported currency rejects the response. USD is never inferred.
- `sourceAsOf` is the latest nonblank NAV date in the Fidelity payload, or Alpha
  Vantage's daily `Last Refreshed` date. `sourceTimeZone` preserves Alpha Vantage's
  supplied zone; Fidelity leaves it null. `fetchedAt` records request start in UTC
  and never replaces the price date. Consumers must assess staleness from source
  dates, not retrieval time.
- `available` means at least one valid observation in the requested interval.
  `completeness` is always `unverified`. Gaps identify explicit empty NAV rows and
  requested edges outside the returned date range. No exchange calendar is wired:
  missing interior dates are neither certified closed days nor backfilled prices.
  Even an empty `gaps` list cannot establish complete history.
- Source URLs omit query strings and credentials. Errors contain generic details,
  never raw provider payloads or exception messages.

## Providers and verified limits

[Fidelity's public historical tool](https://institutional.fidelity.com/app/funds/hpdy)
uses an anonymous form POST to
`https://institutional.fidelity.com/app/funds/historicalFundPricing`, with `fundNo`,
`startDate`, and `endDate` in month/day/year form. Public registered-fund history
was verified for recent dates and a month in 2012. The response includes calendar
rows with empty NAVs. This is a public website endpoint, not a documented stable
API or a coverage guarantee for plan-specific trusts. The adapter preserves raw
NAV and does not scrape HTML. Actual plan/share-class coverage remains unverified.

[Alpha Vantage documentation](https://www.alphavantage.co/documentation/) defines
`TIME_SERIES_DAILY` as raw daily data. This adapter requests `compact` (latest 100
observations); full history and daily adjusted data require premium access.
The [free service limit](https://www.alphavantage.co/support/) is 25 requests/day.
HTTP 200 `Information`, `Note`, and error payloads are unavailable, not prices.
No paid access, automatic fallback chain, or quota scheduler is configured.

Stooq stays disabled: CSV requests returned HTTP 404 outside the browser and
HTTP 200 `Access denied` inside it. Its history UI also exposes adjustment
controls, so the raw-price adjustment basis is unverified. Neither failure
proves that an instrument is absent. There is no HTML scraping fallback.

## Remaining integration gates

1. Verify finance-owned runtime mappings, exact share classes, currency, and
   provider coverage for the requested instruments and historical intervals.
2. Approve and provision a Networth-owned durable cache before activation. Cache
   keys must include instrument/provider identifier, currency, basis, and date;
   retain source dates, retrieval time, mapping provenance, and provider limits.
   Never overwrite useful cached observations with an unavailable response or
   relabel stale cached observations as newly priced.
3. Reconstruct dated holdings from signed activity and independently reconcile
   positions/cash. Handle splits, distributions, and FX explicitly where needed.
4. Integrate holdings-times-raw-price valuation separately from cash. Market gains
   are not fabricated transactions. Missing prices or unreconciled holdings remain
   unavailable in valuation and coverage.

The assembled estate, valuation selectors, deployed resources, and runtime data
are intentionally not connected to these adapters.
