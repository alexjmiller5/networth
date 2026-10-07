# Native Networth widgets

Implement the approved balance and card-guidance widgets, with optional cap,
rewards, expiry and freshness views described in `docs/design/widgets.md`.
The iOS app and extension belong to Networth and live in this repository.
The app has no analytics. No source financial data ships in its bundle.

## Data and behavior

- The server shall project the existing finance and rewards readers into a
  versioned, read-only widget snapshot. It shall omit transactions, evidence
  references, provider identifiers and credentials that a widget does not need.
- The balance view shall retain account-specific verification and as-of dates.
  Credit-card liabilities shall be labeled balance owed; a positive net credit
  shall be labeled credit. Missing values shall never become zero.
- Guidance shall require verified dated earning rules, account elections and
  cap usage. Unsupported or incomplete inputs shall display unavailable with
  a reason. Estimates shall remain visibly distinct from guaranteed cash.
- Optional views shall separately show cap headroom, available/pending/redeemed
  rewards, supported expiry deadlines and account freshness. They shall not
  infer earnings from balance differences or expiry from capture timestamps.
- Tapping shall open the corresponding view in the app. Widgets shall never
  initiate bank collection, payments or redemptions.

## Enrollment and ownership

The Access-protected website approves a native device's one-time enrollment.
The device generates a random secret, submits only its fingerprint for
approval and retains the secret in its native Keychain. Its sole scope is
reading Networth widget snapshots. A device can revoke itself; the website
can revoke an individual enrollment. Replacement devices enroll anew.
Enrollment secrets expire, approval is single-use and rejected attempts cannot
resurrect revoked devices. No operator credential, browser cookie, Life Data
credential or finance-host capability is delivered to the app.

Networth owns the device registry and enrollment state in its own D1 resource.
Only the narrow device API bypasses browser Access. Every bypassed request
requires the supported device credential or the bounded pending-enrollment
handshake; website approvals remain Access-protected. Production activation
must verify both allowed and rejected requests.

## Native presentation and storage

Use the existing personal iOS template for a SwiftUI container and WidgetKit
extension. Configurable widget kinds use native intents. The app retains a
last-good snapshot in its own protected App Group container, with explicit
source and capture times and a separate fetch time. The extension reads only
that snapshot and contains no service credential. Refresh is opportunistic;
background scheduling is not a promise of live balances.

Amount concealment is a native device preference. Sensitive views use native
privacy-sensitive rendering; locked/unavailable protected storage produces
an unavailable view. Unenrolled, offline, stale, partial and revoked states
remain distinct. A failed refresh cannot replace a good snapshot with zeroes.
No fictional snapshot is reachable from an ordinary app launch.

## Acceptance

Unit tests cover malformed snapshots, mixed units, unavailable rules, signed
balances, source dates, stale data, secure enrollment, replay and revocation.
Simulator checks cover enrollment UI, widget configuration, amount concealment,
failed refresh and last-good persistence. Physical installation verifies the
actual App Group entitlement, Keychain storage and widget rendering. Device
signing and enrollment use the supported platform workflow.
