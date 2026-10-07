# Native reward views

`/rewards` reads programs, immutable unit components, source event versions and
balance observations through the dedicated Life Data reader. The application
never invents account identities, reward units or earning history from a balance.

Known event heads show earned, pending, redeemed and expired quantities separately.
A missing amount or invalid correction chain withholds arithmetic. Complete row
membership proves the chain only, not a complete provider transaction history.
Native activity charts group dated posted events by day and kind with exact decimal
sums. Each component retains its own unit; redemptions do not reduce earned totals.
Chart geometry is approximate, while displayed quantities remain exact text.

Balances keep available, pending, period earning, lifetime and qualifying metrics
separate. Source-date and exact-time observations remain separate partitions;
undated captures are historical observations without an asserted current balance.
Legacy snapshots preserve original labels and do not enter typed arithmetic.
Evidence locators and credentials remain server-side.

The 90-day chart selection and amount concealment persist on the device. Concealment
also covers expanded histories and chart values while preserving relative geometry.
Failed refreshes retain the last successful observations and show an error.

Reward rules, cash redemption linkage and editable redemption valuations require
published source contracts and their supported guarded writer. This reader does
not activate a legacy writer or infer cash value for unvalued points.
