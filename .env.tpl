# Canonical secrets manifest — 1Password secret references only, SAFE to commit.
# Most sites have zero-to-few secrets; Worker bindings (D1, R2, KV) are NOT
# secrets — they go in wrangler.jsonc.
# Local dev:      op run --env-file=.env.tpl -- bun run dev
# Push to CF:     just sync-secrets
#
#
# The one runtime secret: this server's own Soma token, enrolled with a
# read-only Soma profile (owner-approved link, `soma login --start/--claim`)
# and stored in the project ENV item. The hub URL is a plain var in wrangler.jsonc. CI deploy
# creds live in deploy.yml.
SOMA_HUB_TOKEN=op://Networth/Networth ENV/SOMA_HUB_TOKEN
# Price cache provider key (Tiingo free tier, personal use), its own item in the
# Networth vault. Read by the daily price refresh only; never sent to the browser.
TIINGO_API_KEY=op://Networth/Networth Tiingo API Key/credential
