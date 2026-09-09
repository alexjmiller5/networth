# Networth

A private money-over-time dashboard backed by a life-data hub. One chart
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
history using a dedicated `tables:read` hub token. Only the fields needed
by the dashboard reach the browser. The token, raw provider payloads, notes,
and stated balance evidence remain server-side. Responses are private and
not cached. Cloudflare Access protects the entire site and API.

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

Requires Bun. Set `LIFE_HUB_URL` in `wrangler.jsonc` to the hub endpoint and
provide `LIFE_HUB_TOKEN` as a server secret. The token needs `tables:read`
only. `.env.tpl` contains 1Password references, never secret values.

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

The provisioning script can mint a dedicated read-only hub token using the
caller's configured `life` admin access. It refuses to replace an existing
live token. Run it through the project bootstrap process so the newly minted
value goes straight into the project's secret vault.

## Deployment

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
