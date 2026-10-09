# Networth for iPhone

The native app securely connects to a Networth dashboard and saves a narrow
snapshot for its WidgetKit extension. It never holds the source service token.
The extension has no network client or credential.

Enter the dashboard's HTTPS address and a device label, tap Connect, compare the
connection code in the browser, and approve the device. Return to the app to
refresh. Replacement phones enroll independently. Revoke an individual device
in the website's Widgets page or disconnect in the app.

Add Networth from the Home Screen widget picker, then edit the widget to choose a
view: card balances, which card (per category this quarter), cap headroom,
available rewards, expiry or freshness. Cards and programs without verified
published terms show unknown rather than a guess. Amount concealment is device-local. Widget refresh
is opportunistic; open the app to fetch a new snapshot. Source dates remain
independent from fetch time.

Snapshots use complete file protection in the App Group container. Locked or
unavailable storage yields an unavailable widget. Credentials are stored in the
app's native Keychain and are not synchronized or shared with the extension.
An offline device's previously saved data cannot be erased remotely; revoked
access is detected and local snapshots removed on reconnection.

Run `just check` and `just test` here. XcodeGen regenerates the project. Set
`NETWORTH_BUNDLE_ID` and `NETWORTH_APP_GROUP` at build time for your registered
application identity. Both application and widget profiles must include the
same App Group. Development defaults use a generic example identity; production
signing facts belong to the owning signing configuration, never the source.

A signed physical installation must verify App Group access and widget rendering.
Simulator tests prove Keychain round trips and validation, not physical signing.

For an Ad Hoc archive, supply `IOS_BUNDLE_ID`, `IOS_APP_GROUP`,
`IOS_CERTIFICATE_P12_BASE64`, `IOS_CERTIFICATE_PASSWORD`, and
`IOS_PROFILE_MAP_JSON` through your signing credential provider. The profile map
is a JSON object from each exact application/extension bundle identifier to its
base64 provisioning profile. Set `IOS_RELEASE_OUTPUT` to a directory outside the
repository, then run `just release`. Optional `IOS_DEVICE_ID` verifies that both
profiles authorize the selected device. The archive helper validates both
embedded profiles, signing identities, and App Group entitlements, and cleans
its disposable keychain and temporary profiles. It never installs or publishes.

Run `python3 scripts/widget_signing_test.py` from the repository root to verify
the profile selection rules. Use the paired Mac's `devicectl device install app`
with the verified IPA for physical installation. A replacement phone must be
registered in both profiles and separately enrolled in the dashboard.
