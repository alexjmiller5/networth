// Worker entry: SvelteKit serves every request. The daily cron runs the same
// owner-facing price refresh route in-process, so it never passes the Access edge,
// after resetting the estate cache's cursors.
import app from './.svelte-kit/cloudflare/_worker.js';

const ORIGIN = 'https://networth.invalid';

export default {
	fetch: app.fetch,
	async scheduled(_controller, env, ctx) {
		// Incremental pulls cannot see a purged older row: drop the estate cursors so the
		// next load re-reads every table in full (src/lib/server/estate.ts).
		await env.ESTATE_CACHE_DB?.prepare('DELETE FROM pull_state').run();
		const response = await app.fetch(
			new Request(`${ORIGIN}/api/prices/refresh`, { method: 'POST', headers: { origin: ORIGIN } }),
			env,
			ctx
		);
		if (!response.ok) throw new Error(`Price refresh failed with HTTP ${response.status}`);
	}
};
