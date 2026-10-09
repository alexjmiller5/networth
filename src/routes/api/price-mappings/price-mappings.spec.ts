import { describe, expect, it } from 'vitest';
import { sqliteD1 } from '$lib/server/sqlite-d1';
import { DELETE, GET, PUT } from './+server';

const origin = 'https://networth.example';
function call(handler: typeof PUT, db: D1Database | undefined, body?: unknown, from = origin) {
	const request = new Request(`${origin}/api/price-mappings`, {
		method: 'PUT',
		headers: { origin: from, 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
	return handler({
		request,
		url: new URL(request.url),
		platform: { env: { PRICES_DB: db } }
	} as unknown as Parameters<typeof PUT>[0]);
}
const mapping = { account_id: 'b', security_id: 'VUG', provider: 'tiingo', symbol: 'VUG' };

describe('price sources', () => {
	it('creates, revises and deletes mappings with revision preconditions', async () => {
		const { db } = sqliteD1('migrations-prices/0001_prices.sql');
		const created = await call(PUT, db, { ...mapping, revision: null });
		expect(await created.json()).toMatchObject({ ...mapping, currency: 'USD', revision: 1 });
		expect((await call(PUT, db, { ...mapping, revision: null })).status).toBe(409);
		const nav = { ...mapping, provider: 'netbenefits', symbol: null };
		expect(await (await call(PUT, db, { ...nav, revision: 1 })).json()).toMatchObject({
			provider: 'netbenefits',
			symbol: null,
			revision: 2
		});
		expect((await call(PUT, db, { ...mapping, revision: 1 })).status).toBe(409);
		const listed = await GET({ platform: { env: { PRICES_DB: db } } } as never);
		expect(((await listed.json()) as { mappings: unknown[] }).mappings).toHaveLength(1);
		expect(
			(await call(DELETE, db, { account_id: 'b', security_id: 'VUG', revision: 1 })).status
		).toBe(409);
		expect(
			(await call(DELETE, db, { account_id: 'b', security_id: 'VUG', revision: 2 })).status
		).toBe(204);
	});

	it('rejects foreign origins, invalid providers and symbols, and missing storage', async () => {
		const { db } = sqliteD1('migrations-prices/0001_prices.sql');
		expect(
			(await call(PUT, db, { ...mapping, revision: null }, 'https://evil.example')).status
		).toBe(403);
		for (const bad of [
			{ ...mapping, provider: 'stooq' },
			{ ...mapping, provider: 'fidelity', symbol: 'FXAIX' },
			{ ...mapping, provider: 'netbenefits', symbol: 'TF0Q' },
			{ ...mapping, symbol: null },
			{ ...mapping, account_id: '' },
			{ ...mapping, extra: 1 }
		])
			expect((await call(PUT, db, { ...bad, revision: null })).status).toBe(400);
		expect((await call(PUT, undefined, { ...mapping, revision: null })).status).toBe(503);
	});
});
