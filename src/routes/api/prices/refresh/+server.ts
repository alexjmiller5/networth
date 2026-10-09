import { json, type RequestHandler } from '@sveltejs/kit';
import { env as privateEnv } from '$env/dynamic/private';
import { refreshPrices } from '$lib/server/prices';

// Fetch new closes into Networth's own cache. The daily cron calls this in-process
// (worker.js); the dashboard calls it behind Access. Keys never leave the Worker.
const headers = { 'cache-control': 'private, no-store' };

export const POST: RequestHandler = async ({ platform, request, url }) => {
	if (request.headers.get('origin') !== url.origin)
		return json({ error: 'This request must come from the dashboard.' }, { status: 403, headers });
	const db = platform?.env.PRICES_DB;
	if (!db) return json({ error: 'The price cache is not configured.' }, { status: 503, headers });
	const env = { ...privateEnv, ...platform?.env } as {
		TIINGO_API_KEY?: string;
		ALPHA_VANTAGE_API_KEY?: string;
	};
	try {
		const results = await refreshPrices(db, {
			tiingo: env.TIINGO_API_KEY,
			alphaVantage: env.ALPHA_VANTAGE_API_KEY
		});
		return json({ results }, { headers });
	} catch {
		return json(
			{ error: 'Prices could not be refreshed. Try again later.' },
			{ status: 503, headers }
		);
	}
};
