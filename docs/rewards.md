# Native reward views

`/rewards` reads programs, immutable unit components, source event versions, balance
observations, terms and redemption valuations through the dedicated Life Data reader.
The application never invents account identities, reward units, earning history,
expiry dates or cash value from a balance.

## One chart, many lenses

The page is one chart per selected unit (program component) with the dashboard
controls: unit, measure (Balances or Activity), lens (Native units or Dollars),
bucket, date preset and range, and a series filter. All controls persist on the
device; the URL stays clean.

- **Balances** plot each observation at its source date, or at its capture day when
  the source gives no date. A bucket shows its closing observation; empty buckets stay
  empty. Bases whose selection is in conflict, broken or incomplete are not plotted.
- **Activity** plots posted event heads by event date, signed like the source:
  earnings above the axis, redemptions and expiry below.
- **Dollars** apply only to cash rewards (exact) or to a unit whose program has an
  owner-entered value, labelled as an estimate. Qualifying counters never have one.

## Figures beside the chart

- **Available / pending**: a source-dated selection first; otherwise the latest
  capture, shown as "Captured <date>, no source date". A capture never outranks a
  dated fact, and a same-time capture with a different amount is a conflict.
- **Known earned / redeemed / expired**: exact sums of known event heads only.
  Missing amounts, invalid chains or incomplete pulls withhold totals.
- **Earning rate** = posted earned units / the card spend proved for those exact
  events (provenance `txn -> reward_events` edges, `evidence_of`). An event with any
  unresolved ledger citation is left out. No linked spend means "Unavailable" with
  the reason, never zero.
- **Cap headroom** = stated cap limit minus provider-observed usage, for the current
  period (explicit bounds, or calendar quarter/year). A public cap rule alone has no
  usage, so headroom stays unavailable.
- **Next expiry** uses in-effect expiry terms of the most specific applicability
  (owner confirmed > account observed > public). A stated deadline gives a date; an
  inactivity rule needs a stated last qualifying activity and verified applicability;
  per-lot expiry needs lot dates. Public no-expiry policy shows as unverified.
  Conflicting outcomes show "Unknown". Capture time is never qualifying activity.
- **Redemptions** list posted redeem heads with the valuation bound to that exact head
  (`selectRedemptionValuationHeads`); a corrected event drops a stale valuation.

## Owner values

The per-program dollars-per-unit value is dashboard state in Networth's own
`MARKERS_DB` (`reward_values`, `migrations/0002_reward_values.sql`), edited on
`/rewards` and served by `/api/reward-values` (Access, same-origin JSON writes,
revision compare-and-set). It never enters Life Data or git, and it only labels
estimates; frozen redemption valuations stay as published.

Unknown stays an explicit diagnostic everywhere. Evidence locators and credentials
remain server-side. Amount concealment masks every amount and chart scale.
