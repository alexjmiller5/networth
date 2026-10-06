# Networth host companion

Source-only implementation of the outbound finance-host transport and recovery
boundary. It does not expose the host to the Internet, create a Herdr session,
enroll a device, or collect financial data.

The canonical wire contract is `src/lib/finance/run-contract.ts`, source commit
`472ec2e6d38412cf334551c5e252ccadac9ed93b`. The test fixture here is an exact copy
of that commit's `run-contract.golden.json`. Update both consumers together.

## Implemented

- Bounded outbound HTTPS long polling, stable claim identity after a lost reply,
  no redirects or automatic mutation retries, strict JSON and response limits.
- SQLite recovery journal in user state: persist native intent before an effect,
  retain ambiguous outcomes, one active reservation per physical browser domain.
- Claude native/default first; one Codex native/default fallback only for
  confirmed unavailability or exhausted credits after prestart quiescence. A
  timeout is not unavailability. No fallback after a collection instruction may
  have been delivered, and no API-billing or model/effort override.
- Exact event outbox replay. A definitive rejection consumes its sequence without
  pretending the observation applied. A lost acknowledgment retains the original
  envelope; an acknowledgment with the wrong digest cannot advance the queue.
- Whole-batch incoming/stored account-binding validation and current run-control
  validation for source-helper integration. These functions are not yet called by
  the installed finance helpers; they do not claim to enforce that workflow.

## Commands and packaging

```sh
nix build ./host
./result/bin/networth-host status
PYTHONPATH=host uv run --no-project python -m unittest discover -s host/tests
uv run --no-project --with ruff ruff check host
uv build host
```

The flake exports a package and `homeModules.default`. Enabling
`programs.networth-host.enable` installs the CLI only. It does not enroll a host,
write credentials, schedule a job, or enable collection.

`status` is local and requires no credentials. `run` exits with status 2 because
native subscription-context verification, client-open acknowledgment,
collector-context binding and enforced source helpers are unavailable. There is
no flag to bypass those gates.

`poll-once --url <https-origin> --host-id <enrolled-id>` is a transport diagnostic
for an already enrolled host. It can claim a run but never creates a native
session or grants capture. Do not activate it against a service until that
service and host enrollment have passed release review. By default, operational
state lives in `$XDG_STATE_HOME/networth-host` (or `~/.local/state/networth-host`).
`--state-dir` supports isolated verification.

The device credential is read from an OS keyring entry with service
`networth-host` and account `<origin>/<enrolled-id>`. Only native macOS Keychain,
Secret Service and Windows keyring backends are accepted. Credential retrieval
failure stops contact; there is no plaintext, operator-token, provider-token or
environment-secret fallback. Enrollment and replacement-device reenrollment
still need the supported service pairing flow; this package does not provide an
ad hoc token-write command.

## Remaining integration gates

The service must implement the pinned routes, verified Access identity, durable
run store, globally exclusive browser reservation, claim/start/event replay and
device enrollment. No routes or infrastructure are activated by this subtree.
Local release of a reservation is only a mirror of a verified service receipt.
Lease expiry or disconnection never permits another native session.

Herdr remains the session owner. Before native mutation, the host must have a
verified subscription launch context. Before a finance instruction, it needs
actual native identity, a verified reachable user client, authoritative local
collector binding and enforced helpers. A run ID or shared tool-process context
does not prove collector identity. No host credential is passed to a model.

Source helpers must preflight the whole incoming batch and existing target
account IDs before any write, retain the binding in conditional mutations, and
check current control before each source/MFA/page/download/write primitive.
Existing ingest is not atomic as a whole. Preserve known commits and unknown
outcomes, reconcile by readback before retry, and report truthful partial work.
Once browser resources are released, capture cannot resume in that run even
when its human review conversation remains open.
