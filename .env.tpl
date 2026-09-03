# Canonical secrets manifest — 1Password secret references only, SAFE to commit.
# Most sites have zero-to-few secrets; Worker bindings (D1, R2, KV) are NOT
# secrets — they go in wrangler.jsonc.
# Local dev:      op run --env-file=.env.tpl -- bun run dev
# Push to CF:     just sync-secrets
#
# CHANGEME — one line per secret. ALL of this app's env vars are fields of
# ONE item titled "<Project> ENV" in the project vault (field name = var name):
#   VAR_NAME=op :// <Vault> / <Project> ENV / VAR_NAME   <- remove the spaces;
#   spelled out because a literal reference in a comment breaks `op inject`.
