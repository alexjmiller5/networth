# Bounded date navigation

Approved behavior: initially select the trailing 90 days; retain valid saved date
presets, custom intervals and other controls per device. Show a bounded calendar
viewport rather than compressing the entire archive. Dragging at the edge pans
through history. Earlier/Later navigation changes the viewport without changing
the selected dates. Keyboard access and touch targets remain usable.

Reuse the independently tested ScreenTime calendar helper and slider source in
this project. Keep project resources and runtime state independent. Use UTC day
arithmetic, clamp at archive bounds, and preserve the selected interval width
when moving the range. Long intervals may extend outside the visible track.

Verification: helper and default/persistence regressions first, then static checks,
full tests, formatting, browser pointer/keyboard/navigation/reload checks, meaningful
mutation checks and a fresh review. Feature branch only; no deployment or data writes.

## Verification receipt

190 tests passed; static checks have zero errors/warnings; full formatting and
production build pass. Four mutations caught archive-width, range-clamping,
viewport-width and initial-default regressions. Trusted browser checks cover
Earlier/Later preserving selection, keyboard Custom dates, reload, held edge
panning, range width, pointer release, composed preferences and 390px layout.

Fresh review caught Home/End panning to the requested archive bound rather than
the actual clamped handle. The shared component now anchors to the resulting
selection; the historical-date browser regression passes. No deferred findings.
