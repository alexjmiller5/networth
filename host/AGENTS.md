# Host companion

This subtree owns the installed outbound Networth host companion and its local
recovery/control boundary. The site owns routes, server state and the canonical
wire contract in `src/lib/finance/run-contract.ts`. Do not fork that contract.

- Persist an intent before every native mutation and its exact receipt before
  advancing. An ambiguous outcome requires reconciliation, never a new session.
- Use Claude's native subscription with its default model first. Codex's native
  default is the only fallback, for verified unavailability or exhausted credits
  after prestart quiescence. No API-billing fallback or model/effort override.
- Local journals are operational evidence, not authority to release a server
  reservation, approve a start, claim user reachability, or change account scope.
- Bind collector access to authoritative native invocation context before secure
  capability retrieval. A run ID, environment variable or shared tool process
  cannot select arbitrary run authority.
- Only generic functionality and synthetic tests belong here. Runtime account
  selection, credentials and retained evidence never enter git.
- Run `PYTHONPATH=host uv run --no-project python -m unittest discover -s host/tests`.
  Existing site tests remain `bun run test`. Do not activate capture on mock proof.
