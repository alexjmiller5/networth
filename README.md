# Networth

A private money-over-time dashboard backed by a soma hub. One chart
shares its date range, grouping, visible series, and display controls with
the figures around it. Bars are the default; filters persist in localStorage
and the URL stays clean.

Use the Chart / Overview selector to replace the graph with compact totals.
Overview shows closing balances in Balances mode and period totals in Activity
mode. Activity shows spending, income, or their net flow; internal transfers
are excluded in all three. Balances include transfers because they move money
between accounts. The headline always states which measure it represents.

Open / Closed, Cash / Investments, and Banks & cash / Wallets & rewards are
independent multiselects. They filter both views, the totals, and coverage.
By asset class groups the chart into Cash and Investments. Cash means balances
outside brokerage and retirement accounts, net of credit-card debt. The
wallets/rewards selection includes stored-value accounts and points snapshots;
points are never added to monetary totals. Investment-only hides the points.

Both views keep the same width and shared selector positions. Date controls
appear only on Chart; the selected range stays saved in Overview. Other
chart-only controls stay disabled. Unavailable balances are labeled explicitly
and excluded from the subtotal. An all-unavailable selection has no dollar
total. Tooltips omit amounts that display as zero.

## Data path

The browser requests `/api/finance` from the SvelteKit Worker. That route
reads the account registry, source transaction tables, overlays, shares,
categories, reconciliation records, Venmo statement evidence, and points
history using its own read-only Soma token. Only the fields needed
by the dashboard reach the browser. The token, raw provider payloads, notes,
and stated balance evidence remain server-side. Responses are private and
not cached server-side. Cloudflare Access protects the entire site and API.

- **Balances** use signed raw ledger amounts, including genuine opening
  entries. Shares and spending categories never change a bank balance.
  Venmo statement evidence distinguishes balance movements from externally
  funded payments.
- **Spending and income** use the overlay category, or dated shares when
  present. Friend-paid shares contribute to flows without creating money
  in an account. Transfers, synthetic openings, and excluded pieces are
  omitted. Refunds reduce the category they reimburse.
- **Coverage** distinguishes verified monetary balances, unreconciled
  accounts, missing history, and investments without market valuations.
  Contributions and trade proceeds are not a substitute for holdings times
  historical prices. An incomplete subtotal is never complete net worth.
- **Points** are dated snapshots, separate from monetary account balances.
  Missing dollar estimates stay unknown.

The source tables and financial invariants belong to the data estate.
Networth does not scrape banks, change categories, or repair financial data.
Refresh reloads hub data; it does not initiate a bank sync.

Account metadata can include `is_closed` (known status without inventing a
closure date), `name_history` (chronological `{name, until}` intervals with
exclusive ISO dates), and `logo` (an inline SVG data URI). Product conversions
change dated labels, never account identities or transaction ledgers. The
current name applies after the last historical interval.

## Configuration and development

Requires Bun and Node 24 for the SQLite-backed API tests. Set `SOMA_HUB_URL` in `wrangler.jsonc` to the hub endpoint and
provide `SOMA_HUB_TOKEN` as a server secret. The token is read-only: enroll
the server with a Soma profile granting broad `tables:read` (the reward and
asset reads include `provenance`, which no table-scoped grant can name). `.env.tpl` contains 1Password references, never secret values.

```sh
bun install --frozen-lockfile
just dev
just test
just check
just build
uv run --with httpx python scripts/test_provision.py
```

`just dev` resolves `.env.tpl` through the caller's 1Password authentication.
Alternatively inject the same environment variables through your own secret
provider and run `bun run dev`. No client-prefixed environment variables
should contain the hub token.

Enroll the hub token rather than minting it: the Soma operator adds the
profile, then `soma login --profile <id> --name "Networth server" --start
pending.json` prints a link the owner approves, and `soma login --claim
pending.json --wait` prints the token for the `SOMA_HUB_TOKEN` field. The
provisioning script mints only the Cloudflare deployment credential.

## Deployment

### Marker storage activation

Event markers belong to this dashboard's `MARKERS_DB` D1 binding, independently
of the read-only financial service. `wrangler.jsonc` declares `networth-markers`
with its provisioned database ID. The Worker uses the binding directly;
its runtime has no database-provider credential.

After deployment approval, use `scripts/cf-d1.py` from the cf-site template
with the owning project's provisioning credentials in `CLOUDFLARE_API_TOKEN`
and `CLOUDFLARE_ACCOUNT_ID`. `--parse-only` is offline; `--dry-run` reads the
provider without creating anything. The existing Workers-only deployment
token does not grant D1 provisioning or migration permissions. Never substitute
another project's database or credentials.

Apply `migrations/0001_markers.sql` through Wrangler's D1 migrations interface
to the new database before the approved deployment. Future schema changes
follow the same reviewed migration step. Local development requires no
provider credentials:

```sh
bunx wrangler d1 migrations apply networth-markers --local
```

The Markers button adds dated points or inclusive ranges, edits titles/dates,
and deletes individual annotations. Calendar dates are UTC labels. Each edit
and deletion checks the last-read revision; after a conflict the draft stays
visible. Reload saved markers and choose Edit on the latest entry to reconcile.
A draft keeps its creation ID through failed requests, so retrying a lost response
does not duplicate the marker. Changed content under an already saved ID conflicts;
reload or explicitly start a New draft to proceed. Deletion keeps only the consumed
ID, so an older creation retry cannot restore a deleted marker.
Markers require an online request and are not included in the offline finance
cache. A storage failure keeps the financial dashboard usable and shows Retry.

Amount concealment replaces marker text with “Hidden marker” in chart labels,
tooltips and the accessible list, and disables editing. Dates and marker geometry
remain visible. This is visual concealment, not dataset redaction.

GitHub Actions tests, checks, builds, and deploys pushes to `main`. Its sole
GitHub secret is the project's `OP_SERVICE_ACCOUNT_TOKEN`; the workflow
resolves its Cloudflare deploy credentials from the project vault.
`scripts/sync-secrets.sh --deploy` uploads code and the runtime secret in
one Wrangler deployment, passing the secret through stdin without writing
it to disk. `just sync-secrets` updates only the existing Worker's secret.

Provision Cloudflare Access with `scripts/cf-access.py` before exposing
personal data. Version preview URLs are disabled. Protect every application hostname;
verify unauthenticated `/api/finance` requests are challenged before the
Worker runs. The repository is shareable; the financial dataset is not.

## Finance review runs

The dashboard's Finance review card queues a review for the selected open
accounts. An enrolled host computer picks it up within seconds, opens a Herdr
tab and starts an agent with the review instruction (Claude first, Codex if
Claude cannot start or has no usage left). The card shows the status, the tab
and agent, and Cancel. Only one run can be active; a second Run is refused.

Run storage is this Worker's `FINANCE_RUNS_DB` (`networth-finance-runs`,
schema in `migrations-finance-runs/`). Provision it like the other databases
with `scripts/cf-d1.py`, then apply migrations with
`bunx wrangler d1 migrations apply networth-finance-runs --remote`.
Cloudflare Access must bypass exactly the host routes:
`--public-path /api/finance-host/v1/claim --public-path '/api/finance-host/v1/runs/*'`
next to the existing `--pwa --public-path '/api/device/*'` flags of
`scripts/cf-access.py`.

### Installing the host

The host is `host/`: a Python package (`networth-host`) with a flake and a
nix-darwin module. It only makes outbound HTTPS requests. Install it on a Mac
that runs Herdr and the agent CLIs:

```nix
inputs.networth-host.url = "github:alexjmiller5/networth?dir=host";
# modules = [ inputs.networth-host.darwinModules.default ];
services.networth-host = {
  enable = true;
  user = "<login user>";
  url = "https://<your networth site>";
  herdrWorkspace = "w1"; # optional
};
```

Then enroll once, in the login session. The login Keychain is locked over
ssh; on a headless Mac submit a one-shot job and read the link from its log.
`launchctl submit` restarts a job that exits, so the job removes itself
(a restarted enroll would replace the approved credential):

```sh
launchctl submit -l networth-enroll -o <log> -e <log> -- /bin/sh -c \
  '/run/current-system/sw/bin/networth-host enroll --label "Mac mini"; launchctl remove networth-enroll'
```

From a desktop terminal it is just:

```sh
networth-host enroll --label "Mac mini"
```

It saves a random credential in the login Keychain, prints an approval link
and waits. Open the link (it lands on `/widgets` behind Access), check the
code and approve. The receipt is `~/.local/state/networth-host/enrollment.json`.
Revoke the host on `/widgets`; enroll again on a replacement machine. The
`networth-host` launchd agent then long-polls the site and logs to
`~/.local/state/networth-host/networth-host.log`. The agent finishes a run with
`networth-host report --run-id <id> --status done|failed|canceled --summary
"<text>"`, which queues the report for the daemon to deliver.

Host tests: `cd host && uv run --no-project --with pytest pytest -q tests`.

## Offline use

Open the dashboard online once and let it finish loading. Later launches can use
its downloaded application and last successful data on that device. Saved data is
labelled with its save time. Reconnect loads through Cloudflare Access when your
connection returns or your sign-in needs renewing. Refresh waits for a fresh
response and keeps the previous chart if the request fails. Clearing the site's
browser data removes the offline copy; a first visit still needs internet access.
