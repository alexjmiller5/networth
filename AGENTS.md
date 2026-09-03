# AGENTS.md

Website on Cloudflare Workers with static assets: Svelte 5 frontend +
optional thin co-located API (server routes → the same Worker). This is the
template for every site, dashboard, and site-attached backend.

## Architecture rules

- **Backend logic that exists to serve this site lives HERE** as SvelteKit
  server routes (`+page.server.ts`, `src/routes/api/*/+server.ts`) — it all
  compiles into the one Worker. Do not create a separate backend for form
  handling, D1 reads, or thin API glue.
- Heavier Python work (AI pipelines, scraping, long jobs) does NOT belong
  here — that's Modal or the mac mini (see the `infra` skill).
- Bindings (D1, R2, KV, cron triggers) are declared in `wrangler.jsonc` —
  that file IS the IaC. Access them via `platform.env` (typed in
  `worker-configuration.d.ts`; regenerate with `bun run gen`).
  - Resources wrangler references but doesn't create are provisioned by
    idempotent ensure-scripts that read the declaration straight from
    `wrangler.jsonc`: **`scripts/cf-r2.py`** creates any missing bucket named
    in `r2_buckets` (`--dry-run` / `--parse-only`; never deletes). Local dev
    needs no provisioning — miniflare fakes bindings in `.wrangler/state/`.
- **Zone/edge config that wrangler DOESN'T manage — HSTS, WAF/rate-limit
  rules, DNS records, Access policies — is declarative-via-SCRIPTS, never
  Terraform.** When a site needs one, add an idempotent `scripts/cf-*.py`
  (reads the CF API token + zone id from 1Password, PUT/PATCHes the setting)
  plus a `just cf-*` recipe. The script IS the declarative source of truth —
  the intended settings read straight off it. Terraform is overkill for
  Cloudflare and drags back state files. Don't scaffold this until a site
  actually needs it. (See the `infra` skill.)
- Scheduled work attached to this site → [`triggers.crons`](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
  in wrangler.jsonc (free) — though Modal cron is the house default for
  standalone jobs.
- **Who is this site for? That picks the auth, and it is not a close call:**
  - **Just Alex, or a handful of named people** (internal dashboards, admin
    panels, personal tools) → **Cloudflare Access**. It runs at the edge
    BEFORE the Worker, so unauthorized requests never execute or bill, and
    the app itself stays auth-free - no login UI, no session table, no user
    model. Free ≤50 users.
  - **Real end users signing themselves up** → **Better Auth** in the Worker
    (D1 as the auth DB). Only when accounts are a product feature.
  - Never roll custom auth, and never reach for Better Auth to gate a
    personal-only app - a user table for an audience of one is the
    definition of overkill.
  - **Tailnet-only access is not achievable at Cloudflare** - tailnet IPs
    never reach CF's edge and cellular is CGNAT, so there is nothing to
    allowlist. Don't try. Access with a 1-month session is the closest thing
    to "just let me in": you log in once, then it's invisible for a month.
    (A dashboard that genuinely only ever needs to be reachable from the
    tailnet doesn't belong on CF at all - that's `tailscale serve` on the
    mac mini.)
- Provision Access with **`scripts/cf-access.py`** (idempotent, same
  declarative-via-script rule as above - never the dashboard):

  ```bash
  scripts/cf-access.py --name <site> --domain <site>.example.com --email you@example.com
  ```

  Repeat `--email` per person, `--domain` per hostname (add
  `'*-<site>.<subdomain>.workers.dev'` to cover Workers preview URLs too).
  `--dry-run` prints the plan without touching anything. Re-running
  converges - it is the source of truth for who can reach the site.
  - Machine callers (CI smoke tests, cron pokes) use Access **Service
    Tokens** (`CF-Access-Client-Id`/`CF-Access-Client-Secret` headers), not
    a human policy.
  - If it's also a homescreen PWA: the manifest and apple-touch-icon are
    fetched WITHOUT cookies, so Access blocks them and the iOS icon degrades
    to a letter monogram. Pass **`--pwa`** - it adds a second Bypass app
    covering exactly those asset paths (non-sensitive; everything else stays
    protected). Then set `crossorigin="use-credentials"` on the manifest
    `<link>`, and delete + re-add the homescreen app, since iOS snapshots
    the icon at add-time.

## Stack

Bun (never npm) · SvelteKit + Svelte 5 runes · Tailwind v4 ·
shadcn-svelte (+ bits-ui) · vitest · prettier. Config note: there is no `svelte.config.js` — adapter and compiler
options live in `vite.config.ts` inside the `sveltekit()` plugin.

## UI conventions

- **Components: shadcn-svelte** (styled copy-paste over the Bits UI headless
  layer). The core set lives in `src/lib/components/ui/` — that code is OURS:
  edit it freely, restyle it, never treat it as a vendored dependency. Add
  more with `bunx shadcn-svelte@latest add <component>` (config in
  `components.json`; zinc base, `nova` style). Behavior/a11y fixes arrive via
  `bun update bits-ui` — the styling layer never auto-updates.
- ALL design tokens (colors, fonts, spacing, radii) go in the `@theme` block
  in `src/routes/layout.css`. Components consume tokens, never raw values.
  shadcn-svelte's semantic tokens (`--primary`, `--radius`, …) are defined in
  the `:root`/`.dark` blocks there — retheme a project by editing those, not
  the component files.
- Icons: Tabler ONLY, via `@tabler/icons-svelte` (already a dependency; browse
  at tabler.io/icons or icones.js.org) — never emojis or generic unicode.
  Import as components: `import { IconChevronRight } from '@tabler/icons-svelte'`.
  shadcn-svelte components render Lucide internally (`@lucide/svelte` stays a
  dependency for that) — same 24px/2px visual language, so the UI still reads
  as one icon set. Full standard in the global `icons` skill.

## Site basics (SEO, titles, favicon, https)

- **Every route renders `<Seo title description [image]>`**
  (`src/lib/components/seo.svelte`) - it emits the title, meta description,
  Open Graph, and twitter-card tags in one place. Head basics live on pages,
  not the layout - a layout title duplicates when a page adds its own. Give
  `image` a 1200x630 banner path once the site has one (link unfurls in
  iMessage/Slack/Discord depend on it).
- **Favicon: purpose-driven, never empty, never stock.** Replace
  `src/lib/assets/favicon.svg` (keep SVG; it's wired in `+layout.svelte`)
  with an icon that depicts THIS site specifically - its subject + function
  together, e.g. a ticket tracker for the ACL festival gets the ACL logo
  merged with a ticket glyph, not a bare ticket. The global `icons` skill is
  raw material (glyphs to compose, recolor, overlay into one SVG), never the
  finished favicon on its own. Shipping the template default or a blank
  favicon to prod is a bug - the browser tab is the site's smallest logo,
  treat it like one.
- **`static/robots.txt`** ships allow-all; **`static/llms.txt`** describes
  the site for LLM crawlers - fill its CHANGEMEs alongside the titles.
- **apple-touch-icon**: `static/apple-touch-icon.png` (180x180) - the same
  purpose-driven icon rendered to PNG; iOS homescreen/share-sheet uses it.
  Shipping the placeholder to prod is a bug, same as the favicon.
- **theme-color** metas in `src/app.html` (light + dark) - match them to the
  site's background tokens in `layout.css`. Dark-mode-aware favicon: embed a
  `prefers-color-scheme` `<style>` inside the favicon SVG when its colors
  need to flip.
- **Error page**: `src/routes/+error.svelte` renders 404/500 with the site's
  theme tokens - restyle it with the site, don't delete it.
- **http → https** is a 301 in `src/hooks.server.ts` (skipped in dev) - works
  on any domain with zero zone config. The same hook sets baseline security
  headers (nosniff, Referrer-Policy, Permissions-Policy); CSP stays
  per-site. Zone-level HSTS, if a site wants it, follows the
  `scripts/cf-*.py` convention above.
- **Sitemap**: content sites fill the routes list in
  `src/routes/sitemap.xml/+server.ts` and uncomment the Sitemap line in
  robots.txt; dashboards/personal tools delete that route dir instead.
- **Analytics: PostHog, OPT-IN per project** (house standard when wanted -
  every adopting app gets its OWN PostHog Cloud project). The wiring ships
  in `src/lib/analytics.ts` + `+layout.svelte`; at scaffold time ASK Alex
  whether this site gets analytics (same ritual as Turnstile):
  - **Internal/personal sites (anything behind CF Access) default to NO** -
    an audience of one produces no data worth reading. Declined → delete
    `src/lib/analytics.ts`, its import + `onMount` in `+layout.svelte`, the
    `PUBLIC_POSTHOG_KEY` var in `wrangler.jsonc`, and
    `bun remove posthog-js`.
  - Adopted → the agent CREATES a PostHog project for this app and fills
    its publishable `phc_` token into `PUBLIC_POSTHOG_KEY` in
    `wrangler.jsonc` `vars` (committed config, not the tpl - it is not a
    secret). Management key = "AI Agent PostHog Personal API Key"
    (`op://4eeyrkqibibn7k4j6rz2fbzvxm/mmwl3dsd7kbsfc62osuj43ovvm/credential`),
    org `01a06053-2eab-0000-6350-0004810c636e`, US Cloud:
    ```bash
    KEY=$(op read "op://4eeyrkqibibn7k4j6rz2fbzvxm/mmwl3dsd7kbsfc62osuj43ovvm/credential")
    curl -s -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
      -d '{"name":"<project-slug>"}' \
      "https://us.posthog.com/api/organizations/01a06053-2eab-0000-6350-0004810c636e/projects/" \
      | jq -r .api_token   # → PUBLIC_POSTHOG_KEY
    ```
    Free tier allows ONE project (the org's existing project - rename and
    reuse it for the first adopter instead of creating); more projects need
    Alex to add a card first - ask him, and remind him to SET BILLING
    LIMITS then (they default OFF once a card exists). Autocapture is OFF
    deliberately - capture explicit named events via
    `import { posthog } from '$lib/analytics'`; don't re-enable it.
    Pageviews (incl. SPA navs) are tracked automatically. Dev runs are
    keyless by design - don't wire the key into `.env.tpl`.

## Form abuse ladder

Public forms get defenses in this order, stopping at the first level that
holds (pattern proven on WTW - its historical bot spam died at level 3):

1. **Honeypot field** - off-screen input; bots fill it, handler fakes success.
2. **Per-IP rate limit** - Workers rate-limiting binding in `wrangler.jsonc`;
   caps email-relay/D1 abuse. Free, no zone config.
3. **Semantic validation** - server-side checks only a human passes (known
   event names, ASCII folding, field plausibility).
4. **Cloudflare Turnstile (managed mode)** - the canonical implementation
   SHIPS in this template; never hand-roll a variant. The pieces:
   `src/lib/components/turnstile.svelte` (widget, dummy always-pass sitekey
   by default so dev/test needs no registration),
   `src/lib/server/turnstile.ts` (+ spec) for the form-action verify, and
   `scripts/cf-turnstile.py` (idempotent widget provisioner; secret →
   `TURNSTILE_SECRET_KEY` in the project's 1P ENV item, sitekey →
   `PUBLIC_TURNSTILE_SITE_KEY`).
   When scaffolding a site with a public form, OFFER Turnstile to Alex with
   the tradeoffs for THIS site: what the form triggers (email relay, D1
   writes, paid APIs, reputational spam) versus its costs - a per-hostname
   widget registration, a secret per site, a third-party script, and a
   nonzero real-human block rate. Lean toward levels 1-3 alone for
   low-stakes forms; toward Turnstile when side effects are expensive or
   abuse is expected. **Declined or no public form → delete the three
   turnstile files (+ spec)**; adopted → wire the shipped pieces, never new
   ones.

## Commands

Standard verb set (see global AGENTS.md) — the justfile is the interface,
not a script catalog; one-offs go in `scripts/` and run directly.

| Command                   | Purpose                                                        |
| ------------------------- | -------------------------------------------------------------- |
| `just dev`                | Dev server (secrets injected via op)                           |
| `just test`               | vitest                                                         |
| `just check` / `just fmt` | wrangler types + svelte-check + prettier / auto-fix            |
| `just build`              | Production build                                               |
| `just logs`               | `wrangler tail` on the deployed Worker                         |
| `just sync-secrets`       | Push `.env.tpl` → Worker secrets                               |
| `just deploy`             | test + build + `wrangler deploy` — CI's job, not yours (below) |

**Deploying = commit + push to `main`.** The GHA deploy workflow runs tests,
syncs secrets, and deploys — never run `just deploy` locally unless there's a
legitimate stated reason (e.g. CI itself is broken): local deploys ship code
that isn't in git, and the next push silently reverts it. After pushing,
verify the run with the gh CLI (`gh run watch <id> --exit-status`; on failure
`gh run view <id> --log-failed`) — never assume the deploy succeeded.

## TDD

Write the test first (`*.spec.ts` next to the code, or `src/**/*.svelte.spec.ts`
for components), then the code. Delete `src/lib/vitest-examples/` once real
tests exist.

## New-project checklist (delete this section after setup)

1. Rename `name` in `wrangler.jsonc` and `package.json`.
2. Fill `@theme` tokens in `src/routes/layout.css`; adjust the shadcn-svelte
   `:root`/`.dark` variables there if the project needs its own palette.
3. Site basics: `<Seo>` title/description CHANGEMEs, `static/llms.txt`,
   theme-color metas in `app.html`, and purpose-driven icons - favicon.svg
   AND apple-touch-icon.png (compose for this site; never ship the template
   defaults). Restyle `+error.svelte` with the theme.
4. Forms: run the abuse ladder; offer Turnstile with this site's tradeoffs -
   keep + wire the shipped turnstile files if adopted, delete them if not.
5. Sitemap: content site → fill routes + uncomment robots.txt line;
   dashboard → delete `src/routes/sitemap.xml/`.
6. Fill `.env.tpl` if the site needs secrets; `just sync-secrets`. A site with
   no runtime secrets keeps the tpl empty - CI deploy creds live only in
   `deploy.yml`.
   Analytics: ASK Alex whether this site gets analytics (internal/CF-Access
   sites default no → delete the wiring per the Analytics bullet above).
   Adopted → create this app's own PostHog project and fill
   `PUBLIC_POSTHOG_KEY` in `wrangler.jsonc` (API call in the Analytics
   bullet above).
7. `scripts/provision.py`: set `NAME` to the project slug and adjust the
   deploy-token permission groups to what this site deploys (R2/D1/KV).
   Machine-mintable secrets never prompt - `op-project-bootstrap` calls it
   for the CI Cloudflare Token item (api-token + account-id); add minters for any other
   API-creatable credential (Resend, Turnstile, random tokens - shapes in
   acl-price-watch).
8. Custom domain / D1 / R2: add to `wrangler.jsonc`, then `bun run gen`;
   R2 buckets: `scripts/cf-r2.py` creates the declared ones. No R2 → delete
   that script.
9. Vault + CI: Alex runs `op-project-bootstrap .env.tpl --repo <owner/name>` — creates the project vault, the `<Project> ENV` item, the read-only CI SA, and sets the repo's `OP_SERVICE_ACCOUNT_TOKEN`.
10. If private: `scripts/cf-access.py --name <site> --domain <host> --email <you>`
    (add `--pwa` if it's a homescreen app). Public site → delete
    `scripts/cf-access.py`.

## Hardcoded owner assumptions

The code is generic, but the workflow is wired to Alex's setup for
convenience: secrets flow through his 1Password (`.env.tpl` with `op://`
references; `op-project-bootstrap` is his private bootstrap script) and
deploys target his Cloudflare account.
