import { expect, it, vi } from 'vitest';
import { GET } from './+server';
import { fakeHub } from '$lib/server/fake-hub';
const event = (fetch: typeof globalThis.fetch) =>
	({
		fetch,
		platform: { env: { SOMA_HUB_URL: 'https://hub.example', SOMA_HUB_TOKEN: 'synthetic' } }
	}) as unknown as Parameters<typeof GET>[0];
it('preserves legacy snapshots when typed tables are not yet available', async () => {
	const hub = fakeHub({
		points_balances: [
			{ id: 'legacy', program: 'Example', points: 42, scraped_at: '2024-01-01T00:00:00.000Z' }
		]
	});
	const fetch = (async (url: string, init: RequestInit) => {
		const body = JSON.parse(String(init.body));
		// A hub without typed publication refuses the typed tables and columns.
		const typed =
			(body.tables ?? []).some((t: string) => t !== 'points_balances') ||
			(body.batch ?? []).some((p: { columns: string[] }) => p.columns.includes('component_id'));
		return typed ? new Response('unknown typed source', { status: 404 }) : hub.fetch(url, init);
	}) as typeof globalThis.fetch;
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
	const hub = fakeHub();
	const response = await GET(event(hub.fetch));
	expect(response.headers.get('cache-control')).toBe('private, no-store');
	expect(await response.json()).toMatchObject({
		programs: [],
		legacyBalances: [],
		typedUnavailable: false,
		valuesUnavailable: true
	});
	for (const { url, init } of hub.requests) {
		expect(url.startsWith('https://hub.example/v1/')).toBe(true);
		expect(init.headers).toMatchObject({ Authorization: 'Bearer synthetic' });
		expect(init.redirect).toBe('manual');
	}
	const tables = hub.pulls().map((p) => p.table);
	expect(tables).toContain('reward_terms');
	// The links slice is read; the provenance table itself never is.
	expect(
		hub
			.pulls()
			.filter((p) => p.table === 'provenance')
			.every((p) => p.where)
	).toBe(true);
});
