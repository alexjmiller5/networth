import { expect, it } from 'vitest';
import { GET } from './+server';
import { fakeHub } from '$lib/server/fake-hub';
const event = (fetch: typeof globalThis.fetch) =>
	({
		fetch,
		platform: { env: { SOMA_HUB_URL: 'https://hub.test', SOMA_HUB_TOKEN: 'synthetic-only' } }
	}) as never;
it('projects registered dated claims and settlement identities without raw stream bodies', async () => {
	const hub = fakeHub({
		trips: [{ id: 't1', name: 'Trip one' }],
		provenance: [
			{
				id: 'edge',
				from_kind: 'txn',
				from_ref: 'bank:x',
				to_kind: 'trip',
				to_ref: 't1',
				rel: 'settles'
			}
		]
	});
	const fetch = (async (url: string, init: RequestInit) =>
		url.includes('/streams/')
			? Response.json({
					entries: [
						{
							id: 'landing',
							body: JSON.stringify([
								{
									notion_id: 't1',
									start: '2026-01-01',
									end: '2026-01-03',
									cities: ['Synthetic city']
								}
							])
						}
					],
					next_cursor: null
				})
			: hub.fetch(url, init)) as typeof globalThis.fetch;
	const response = await GET(event(fetch));
	const data = await response.json();
	expect(response.headers.get('cache-control')).toBe('private, no-store');
	expect(data).toEqual({
		trips: [
			{ id: 't1', name: 'Trip one', intervals: [{ start: '2026-01-01', end: '2026-01-03' }] }
		],
		settlements: { 'bank:x': ['t1'] }
	});
	expect(JSON.stringify(data)).not.toContain('Synthetic city');
});
it('marks a failed trip source unavailable without inventing unassigned trip coverage', async () => {
	await expect(
		GET(event((async () => new Response('', { status: 503 })) as typeof fetch))
	).rejects.toMatchObject({ status: 503 });
});
