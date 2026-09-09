# Canonical secrets manifest — 1Password secret references only, SAFE to commit.
# Most sites have zero-to-few secrets; Worker bindings (D1, R2, KV) are NOT
# secrets — they go in wrangler.jsonc.
# Local dev:      op run --env-file=.env.tpl -- bun run dev
# Push to CF:     just sync-secrets
#
#
# The one runtime secret: a life-data hub token scoped tables:read, minted
# with `life token create networth --scopes tables:read` and stored in the
# project ENV item. The hub URL is a plain var in wrangler.jsonc. CI deploy
# creds live in deploy.yml.
LIFE_HUB_TOKEN=op://Networth/Networth ENV/LIFE_HUB_TOKEN
