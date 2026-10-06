# Local dashboard amount concealment

Approved behavior: a live-dashboard toggle conceals amounts for a nearby viewer. Source data stays on the device; account labels and relative chart shapes remain visible. No redacted dataset or export is implied.

Implementation: one localStorage control read synchronously before initial rendering, shared money/unit/tick formatters, header/Overview/points masking, and chart tooltip/axis masking. Toggle changes must repaint an existing chart and clear previously visible tooltip text.

Verification: tests written first fail for missing display helpers and control preference. Verify pure formatting, persistence, browser Chart/Overview/points/hover, reload and restore, then fresh review and mutation checks. No financial writes or deployments.

## Verification receipt

- 184 tests passed; static checks and full formatting passed.
- Real browser Chart.js tooltip changed from a numeric amount to Hidden; all amount-axis tick labels cleared. Overview and points values masked, reload retained the setting, and restoring amounts recovered original formatting.
- Fresh review identified prose equivalents of exact zero in coverage. Regression failed first, then coverage labels/reasons were made concealment-aware; expanded coverage verified in browser.
- Four mutations caught: money mask, axis mask, prose mask, and saved concealment restoration. No deferred review findings.
