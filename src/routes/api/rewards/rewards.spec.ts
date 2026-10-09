import { expect, it, vi } from 'vitest';
import { GET } from './+server';
const event = (fetch: typeof globalThis.fetch) =>
	({
		fetch,
		platform: { env: { LIFE_HUB_URL: 'https://hub.example', LIFE_HUB_TOKEN: 'synthetic' } }
	}) as unknown as Parameters<typeof GET>[0];
it('preserves legacy snapshots when typed tables are not yet available', async () => {
	const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
		const body = JSON.parse(String(init?.body));
		if (body.table === 'points_balances' && !body.columns.includes('component_id'))
			return Response.json({
				rows: [
					{ id: 'legacy', program: 'Example', points: 42, scraped_at: '2024-01-01T00:00:00.000Z' }
				]
			});
		return new Response('unknown typed source', { status: 404 });
	});
	expect(await (await GET(event(fetch))).json()).toMatchObject({
		typedUnavailable: true,
		programs: [],
		legacyBalances: [{ points: 42 }]
	});
});
it('returns no raw data or credential on total source failure', async () => {
	await expect(
		GET(event(vi.fn(async () => new Response('private', { status: 500 }))))
	).rejects.toMatchObject({
		status: 502,
		body: { message: 'Rewards could not be loaded. Try refreshing.' }
	});
});
it('uses the existing dedicated reader and fixed native projections', async () => {
	const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
		expect(url).toBe('https://hub.example/v1/rows/pull');
		expect(init?.headers).toMatchObject({ authorization: 'Bearer synthetic' });
		expect(init?.redirect).toBe('manual');
		const body = JSON.parse(String(init?.body));
		expect(body.columns).not.toContain('raw');
		return Response.json({ rows: [] });
	});
	const response = await GET(event(fetch));
	expect(response.headers.get('cache-control')).toBe('private, no-store');
	expect(await response.json()).toMatchObject({
		programs: [],
		legacyBalances: [],
		typedUnavailable: false,
		valuesUnavailable: true
	});
	const tables = fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).table);
	expect(tables).toContain('reward_terms');
	expect(tables).not.toContain('provenance');
});
