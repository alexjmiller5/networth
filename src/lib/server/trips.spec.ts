import { expect, it, vi } from 'vitest';
import { readTripClaims } from './trips';

it('cancels before decoding an oversized chunk and never consumes later chunks', async () => {
	let pulls = 0;
	let cancelled = false;
	const stream = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				pulls++;
				controller.enqueue(new Uint8Array(pulls === 1 ? 1_000_001 : 5));
				if (pulls === 3) controller.close();
			},
			cancel() {
				cancelled = true;
			}
		},
		{ highWaterMark: 0 }
	);
	const first = JSON.stringify({ entries: [], next_cursor: 'next' }).padEnd(3_000_000, ' ');
	const fetcher = vi.fn(async (url: string) =>
		url.includes('cursor=') ? new Response(stream) : new Response(first)
	);
	await expect(
		readTripClaims({ hub: 'https://hub.test', token: 'synthetic-only', fetch: fetcher as never })
	).rejects.toThrow('Trip stream read limit');
	expect(cancelled).toBe(true);
	expect(pulls).toBe(1);
});

it('decodes split UTF-8 incrementally and rejects malformed bytes', async () => {
	const bytes = new TextEncoder().encode(
		JSON.stringify({
			entries: [{ id: 'one', body: JSON.stringify({ label: 'café' }) }],
			next_cursor: null
		})
	);
	const split = bytes.indexOf(0xc3) + 1;
	const response = new Response(
		new ReadableStream({
			start(c) {
				c.enqueue(bytes.slice(0, split));
				c.enqueue(bytes.slice(split));
				c.close();
			}
		})
	);
	expect(
		await readTripClaims({
			hub: 'https://hub.test',
			token: 'synthetic-only',
			fetch: (async () => response) as typeof fetch
		})
	).toEqual([{ label: 'café' }]);
	// Keep JSON valid under replacement decoding, so only strict UTF-8 rejects it.
	const invalidBytes = bytes.slice();
	invalidBytes[split] = 0x20;
	const invalid = new Response(invalidBytes);
	await expect(
		readTripClaims({
			hub: 'https://hub.test',
			token: 'synthetic-only',
			fetch: (async () => invalid) as typeof fetch
		})
	).rejects.toThrow();
});
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
