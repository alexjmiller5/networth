# Canonical secrets manifest — 1Password secret references only, SAFE to commit.
# Most sites have zero-to-few secrets; Worker bindings (D1, R2, KV) are NOT
# secrets — they go in wrangler.jsonc.
# Local dev:      op run --env-file=.env.tpl -- bun run dev
# Push to CF:     just sync-secrets
#
#
# networth has no runtime secrets: data comes from the life-data hub at run
# time (token wired in a later phase) and CI deploy creds live in deploy.yml.
