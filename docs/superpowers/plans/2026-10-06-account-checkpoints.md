# Account checkpoints and closed investment zero

Approved behavior: retain each account's latest explicit checkpoint and date; unknown evidence stays unknown. A closed investment may show current zero only after independent cash and positions verification. This does not establish historical market prices.

Implementation:

- Select account-scoped runs from explicit monetary or unit gates, respecting source and live rows.
- Preserve newer failed/malformed explicit checkpoints as unavailable instead of reviving older proof.
- Verify closed zero from a successful dated run, actual ledger history, zero cash and flat positions. Expose a current-only zero separately from historical valuation.
- Overview can show this zero at/after its checkpoint; chart/history/activity must not inherit it.

Verification ledger:

- Browser reproduction with two synthetic same-source accounts showed a subtotal of 100 instead of 200 after the second account's checkpoint. Fixed browser subtotal is 200.
- New checkpoint tests failed first for sibling evidence and timezone ordering; pass after account-scoped selection.
- Closed-zero tests failed first for missing current balance and Overview support; implementation added after reproduction. Historical values remain unavailable.
- All fixtures are invented and no runtime financial data changed.

- Fresh review found unresolved quantity without a ticker could pass flatness and current-zero rows were omitted from filter applicability. Both findings were reproduced RED, fixed, and tested GREEN; these are correctness fixes, not deferred polish.
- Browser Overview verified both independent account dates and current closed zero. Current-zero series remains absent from chart history. Generic retired-source endpoint regression proves retained tombstoned registry history never triggers a source table pull.
- Four mutations caught: removal of cash-zero evidence, removal of flat-position gate, source-level checkpoint lookup, and zero backfill into chart history.
