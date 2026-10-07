# Native widgets implementation plan

> Execute inline with superpowers:executing-plans. Preserve existing approvals and the approved widget scope.

**Goal:** Deliver native balance and guidance widgets, plus the approved optional views.

**Architecture:** Networth serves a narrow snapshot to enrolled read-only devices.
A SwiftUI app retains the last good snapshot for its WidgetKit extension.
Financial selection remains server-side and reuses existing readers.

**Tech stack:** SvelteKit, project-owned D1, SwiftUI, WidgetKit, Keychain, App Groups.

**Spec:** `docs/superpowers/specs/2026-10-07-native-widgets.md` and `docs/design/widgets.md`.

## Constraints and review focus

- No personal data in source or synthetic fixtures.
- No invented balances, earning rates, expiry dates or capture timestamps.
- Separate native units and earned, available and redeemed rewards.
- Test device revocation, cross-origin approval, replay and expired enrollment.
- Test cold, stale, offline, locked and malformed snapshot states.
- Verify Cloudflare edge behavior and native entitlements in their real runtimes.

## Work

- [ ] Add synthetic tests for `src/lib/finance/widget-snapshot.ts` and implement
  the minimal projection over existing finance/rewards selectors.
- [ ] Add the bounded device registry and enrollment routes under
  `src/lib/server/widget-devices.ts` and `src/routes/api/device/`; test scope,
  expiry, revocation and replay before implementation.
- [ ] Add the Access-protected enrollment/revocation page and the dedicated
  Networth registry migration/resource declaration. Verify edge policy before
  enabling the public device path.
- [ ] Build `ios/` from the personal iOS template with snapshot logic tests,
  secure enrollment, last-good storage and native widget configuration.
- [ ] Render and exercise every widget state in previews and the simulator;
  mutation-test financial selection and enrollment guards.
- [ ] Deploy through CI, verify authenticated and rejected device requests,
  build the signed app and install through the supported paired-device flow.
- [ ] Complete physical widget/enrollment acceptance, preserve evidence in the
  existing tracking task and remove temporary test instances and credentials.
