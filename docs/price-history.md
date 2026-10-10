# Price history and investment valuation

Networth values investment accounts from its own daily price cache. Positions
come from the reconciled activity ledgers; prices come from providers; nothing
is written back to Soma.

## Price sources (owner data)

`price_mappings` in `PRICES_DB` maps an account and its exact ledger security
(the `txns_<source>.ticker`, which equals the instrument's `native_security_id`)
to one series. Edit them on `/investments` (Price sources); they are never source
code or Soma rows.

| Provider       | Symbol                                                                            | History                                                                                                                                                                                                                               |
| -------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tiingo`       | Tiingo ticker (stocks, ETFs, mutual funds)                                        | Whole history on first fetch, then a 10-day overlap                                                                                                                                                                                   |
| `fidelity`     | Fidelity fund number; the payload's trading symbol must equal the ledger security | Last 30 days per run (the public endpoint rejects longer ranges and throttles bursts)                                                                                                                                                 |
| `alphavantage` | Alpha Vantage symbol                                                              | Last 100 days (free `compact`); needs `ALPHA_VANTAGE_API_KEY`, not provisioned                                                                                                                                                        |
| `netbenefits`  | none                                                                              | NAV observations from finance runs (`investment_observations`, `price_kind = nav`, source-dated: current NAV, 12 month-end closes, per-transaction unit prices), only for that account's own instrument; carried forward between them |

A held security without a mapping makes its account unavailable with the reason
"No price source for X". Mapping a shared fund once per account is deliberate:
instrument identity never crosses accounts, even when two mappings read the same
provider series.

## The cache

`price_closes` holds one raw close per provider, symbol and trading date, as the
provider's exact decimal text, with Tiingo's split factor on ex-dates. Tiingo's
`close` is unadjusted; `adjClose` is never stored. Fidelity NAVs are `raw-nav`.
Empty Fidelity NAV rows are gaps. A failed or malformed response leaves every
cached row untouched; a changed close from the provider replaces the cached one.

`POST /api/prices/refresh` (Access plus same-origin) fetches every mapped daily
series once. The `30 2 * * *` cron trigger calls the same route in-process from
`worker.js`, after US mutual fund NAVs post. A missed day heals on the next run
through the overlap window. Free-tier Tiingo limits: 50 requests/hour, 1,000/day,
500 unique symbols/month, internal personal use only
([pricing](https://www.tiingo.com/about/pricing)); one request per series per run.

## Valuation rules

`valuation.ts` walks each investment account from its first ledger day to today:

- Value = sum of signed units times the price on or before the day, plus custody
  cash (the ledger's running amount) only for accounts with a monetary gate.
  Workplace plans have a units-only gate and no custody cash.
- A price is usable when it is at most 4 calendar days old and no cached daily
  series has a newer market day in between. Weekends and holidays carry the last
  close; a missing trading-day close is a gap, never interpolated.
- A `netbenefits` plan-fund NAV is the exception: it carries forward until the
  next recorded NAV, however old, because plan funds have no daily series and a
  NAV moves little between finance runs. Those days are `carried`: they count in
  totals, the Overview card reads "As of <NAV date> · NAV N days old", and
  coverage reads "Carried NAV" (never verified) when the end date is carried.
- Unavailable days are `null` with a reason, recorded as run-length gaps. The
  chart leaves them empty; groups with an unavailable member are unavailable;
  totals sum only available values, so a gap can lower but never inflate them.
- Any coverage gate failure, custody cash that disagrees with the monetary gate,
  ledger units that disagree with observed holdings (same day or the day before a
  capture), or a provider split the ledger books on another day blocks the
  affected days.
- Coverage turns `verified` only when the end date is freshly priced; `valuedAsOf`
  is the oldest price date behind that value and the Overview shows it as "Market
  value as of". Brokerage trade execution prices are never used as NAVs; a plan
  fund's own transaction unit price is its NAV and arrives as a Soma observation.

Dividends accrue between ex-date and pay date as a small dip (cash arrives on the
pay date); there is no accrual model.
