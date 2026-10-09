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

## Native delivery

All six views ship in the iPhone WidgetKit extension as one configurable widget
(edit the widget to choose its view). They read the last-good snapshot the app
saves from `/api/device/snapshot`; reward sections are optional fields in that
version 1 payload, so a failed rewards read never withholds balances. Guidance,
caps and expiry come from published typed terms only: a card or program without
verified terms shows unknown, never a guess. Hide amounts in the app masks every
amount in every view; rates and dates stay visible. Widget taps open the app; they
never redeem, pay or start collection.

References: [Apple timeline refresh](https://developer.apple.com/documentation/widgetkit/keeping-a-widget-up-to-date),
[privacy-sensitive widget views](https://developer.apple.com/documentation/widgetkit/creating-a-widget-extension).
