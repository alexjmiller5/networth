// Worker entry: SvelteKit serves every request. The daily cron runs the same
// owner-facing price refresh route in-process, so it never passes the Access edge.
import app from './.svelte-kit/cloudflare/_worker.js';

const ORIGIN = 'https://networth.invalid';

export default {
	fetch: app.fetch,
	async scheduled(_controller, env, ctx) {
		const response = await app.fetch(
			new Request(`${ORIGIN}/api/prices/refresh`, { method: 'POST', headers: { origin: ORIGIN } }),
			env,
			ctx
		);
		if (!response.ok) throw new Error(`Price refresh failed with HTTP ${response.status}`);
	}
};
