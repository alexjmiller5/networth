# cf-site (template)

Template for websites on Cloudflare Workers with static assets: Svelte 5 +
Tailwind v4 frontend, with any site-attached backend as SvelteKit server
routes compiled into the same Worker. One repo, one `wrangler deploy`, $0.

## Layout

```
src/routes/       pages + server routes (thin co-located API)
src/routes/layout.css   Tailwind + @theme design tokens
wrangler.jsonc    the IaC — bindings (D1/R2/KV), cron triggers, domain
.env.tpl          secrets manifest (1Password op:// refs, committed)
justfile          dev / test / check / sync-secrets / deploy
```

## Bootstrap a new project from this template

See the `new-project` skill, or the checklist in CLAUDE.md.

No manual dashboard steps. Private sites get Cloudflare Access from
`scripts/cf-access.py` (idempotent; `--dry-run` to preview) - if a step ever
genuinely can't be codified, document it here.
