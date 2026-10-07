# Widget design options

The requested starting points are card/category guidance and current card balances.
The interactive `widgets.html` preview adds cap headroom, available rewards,
verified expiry deadlines and collection freshness for comparison. Every example is
fictional, and preview selection changes no account or financial data.

Use the native system typeface, left-aligned labels and tabular money. Forest green
marks the guidance widget; the balance and supporting widgets stay on a quiet white
surface. Widget-shaped layouts are the subject of the preview, not dashboard panels.
Colors: ink `#182b2b`, muted `#56666a`, green `#176354`, surface `#ffffff`,
page `#f2f4f5`, soft green `#e4eeea`.

## Behavior

- Card guidance compares the chosen category across eligible cards using dated,
  verified earning rules, current caps, selected categories and applicable tiers.
  Missing or stale prerequisites withhold the recommendation. Points estimates are
  explicitly labeled and never silently ranked as guaranteed cash.
- Balances show selected accounts' posted values and individual source dates.
  Pending charges and statement/minimum payment amounts are distinct facts.
- Cap headroom uses the provider's actual period, eligibility and reversal rules.
  It never assumes all issuers use a calendar quarter.
- Available rewards are method-specific. Earned/pending, currently redeemable and
  actually redeemed remain separate; a nominal estimate is not spendable cash.
- Expiry displays only supported lot/program deadlines and relevant exemptions.
  A balance capture timestamp is not qualifying activity.
- Freshness opens collection/reconciliation detail without triggering capture.
  Widget taps never initiate redemption, payment or bank collection.

## Native delivery boundaries

These are design previews, not installed WidgetKit extensions. Native implementation
needs an owning app container, supported scoped enrollment and secure storage,
replacement-device reenrollment, verified source contracts and device installation.
Do not reuse browser cookies, operator credentials, host-companion auth or another
project's resource. No deployment or enrollment is implied by preview review.

The app supplies a last-good snapshot to its own widget extension; UI distinguishes
capture time and source-as-of. Refresh is opportunistic under WidgetKit scheduling,
not an always-live balance promise. Use native privacy-sensitive views and explicit
amount concealment. Locked, unenrolled, stale and partial states need native tests.

References: [Apple timeline refresh](https://developer.apple.com/documentation/widgetkit/keeping-a-widget-up-to-date),
[privacy-sensitive widget views](https://developer.apple.com/documentation/widgetkit/creating-a-widget-extension).
