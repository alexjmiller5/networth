import { expect, it, vi } from 'vitest';
import { readTripClaims } from './trips';
const source = (fetch: typeof globalThis.fetch) => ({
	hub: 'https://hub.test',
	token: 'synthetic-only',
	fetch
});
it('reads bounded authorized stream pages and retained batch bodies without forwarding redirects', async () => {
	const fetch = vi.fn(async (url: string, init: RequestInit) => {
		expect(url).toMatch(/^https:\/\/hub.test\/v1\/streams\/location_trips\/records\?/);
		expect(init.headers).toMatchObject({ Authorization: 'Bearer synthetic-only' });
		expect(init.redirect).toBe('manual');
		return Response.json(
			url.includes('cursor=')
				? { entries: [{ id: 'b', body: JSON.stringify({ notion_id: 'two' }) }], next_cursor: null }
				: {
						entries: [{ id: 'a', body: JSON.stringify([{ notion_id: 'one' }]) }],
						next_cursor: 'opaque+/='
					}
		);
	});
	expect(await readTripClaims(source(fetch as never))).toEqual([
		{ notion_id: 'one' },
		{ notion_id: 'two' }
	]);
	expect(fetch.mock.calls[1][0]).toContain('cursor=opaque%2B%2F%3D');
});
it('rejects looping or malformed pages rather than treating missing trip data as unassigned', async () => {
	const fetch = vi.fn(async () => Response.json({ entries: [], next_cursor: 'loop' }));
	await expect(readTripClaims(source(fetch as never))).rejects.toThrow();
	expect(fetch).toHaveBeenCalledTimes(2);
	await expect(
		readTripClaims(source(vi.fn(async () => new Response('', { status: 302 })) as never))
	).rejects.toThrow();
});

it('reduces oversized page size without skipping the cursor or accepting partial data', async () => {
	const fetch = vi.fn(async (url: string) =>
		url.includes('limit=20')
			? new Response('', { status: 413 })
			: Response.json({ entries: [{ id: 'a', body: '[]' }], next_cursor: null })
	);
	expect(await readTripClaims(source(fetch as never))).toEqual([]);
	expect(fetch.mock.calls[1][0]).toContain('limit=1');
});
