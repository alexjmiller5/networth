import { describe, expect, it, vi } from 'vitest';
import { sqliteD1 } from '$lib/server/sqlite-d1';
import { POST } from './+server';

const origin = 'https://networth.example';
const post = (env: Record<string, unknown>, from = origin) => {
	const request = new Request(`${origin}/api/prices/refresh`, {
		method: 'POST',
		headers: { origin: from }
	});
	return POST({
		request,
		url: new URL(request.url),
		platform: { env }
	} as unknown as Parameters<typeof POST>[0]);
};

describe('price refresh route', () => {
	it('refreshes the cache with the server key and never returns it', async () => {
		const { db, sqlite } = sqliteD1('migrations-prices/0001_prices.sql');
		sqlite.exec(
			"INSERT INTO price_mappings (account_id, security_id, provider, symbol) VALUES ('b', 'VUG', 'tiingo', 'VUG')"
		);
		const fetch = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(
				Response.json([{ date: '2026-01-08T00:00:00.000Z', close: 80, splitFactor: 1 }])
			);
		const response = await post({ PRICES_DB: db, TIINGO_API_KEY: 'server-secret' });
		const text = await response.text();
		expect(response.status).toBe(200);
		expect(JSON.parse(text).results).toMatchObject([
			{ symbol: 'VUG', status: 'available', rows: 1 }
		]);
		expect(text).not.toContain('server-secret');
		fetch.mockRestore();
	});

	it('requires the dashboard origin and the cache binding', async () => {
		const { db } = sqliteD1('migrations-prices/0001_prices.sql');
		expect((await post({ PRICES_DB: db }, 'https://evil.example')).status).toBe(403);
		expect((await post({})).status).toBe(503);
	});
});
