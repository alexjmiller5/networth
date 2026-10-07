import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { GET, POST, PUT, DELETE } from './+server';
import type { Marker } from '$lib/finance/markers';
const read = async <T>(response: Response): Promise<T> => (await response.json()) as T;

let sqlite: DatabaseSync;
let platform: App.Platform;
beforeEach(() => {
	sqlite = new DatabaseSync(':memory:');
	sqlite.exec(readFileSync('migrations/0001_markers.sql', 'utf8'));
	platform = {
		env: {
			MARKERS_DB: {
				prepare(sql: string) {
					const statement = sqlite.prepare(sql);
					const bound = (values: (string | number | null)[]) => ({
						async first() {
							return statement.get(...values) ?? null;
						},
						async all() {
							return { results: statement.all(...values) };
						},
						async run() {
							return { meta: { changes: statement.run(...values).changes } };
						}
					});
					return {
						...bound([]),
						bind(...values: (string | number | null)[]) {
							return bound(values);
						}
					};
				}
			}
		}
	} as unknown as App.Platform;
});
afterEach(() => sqlite.close());
const input = {
	id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
	date: '2030-01-15',
	end: null,
	title: 'Example event'
};
const event = (method: string, body?: unknown, origin = 'https://dashboard.example') =>
	({
		platform,
		url: new URL('https://dashboard.example/api/markers'),
		request: new Request('https://dashboard.example/api/markers', {
			method,
			headers: { origin, 'content-type': 'application/json' },
			...(body === undefined ? {} : { body: JSON.stringify(body) })
		})
	}) as Parameters<typeof POST>[0];

describe('owned marker API', () => {
	it('persists individual markers, updates with a revision and deletes without affecting siblings', async () => {
		const created = await POST(event('POST', input));
		expect(created.status).toBe(201);
		const marker = await read<Marker>(created);
		expect(marker).toMatchObject({ ...input, revision: 1 });
		await POST(
			event('POST', { ...input, id: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb', title: 'Sibling' })
		);
		const updated = await PUT(event('PUT', { ...marker, title: 'Changed' }));
		expect(await updated.json()).toMatchObject({ title: 'Changed', revision: 2 });
		const removed = await DELETE(event('DELETE', { id: marker.id, revision: 2 }));
		expect(removed.status).toBe(204);
		const listed = await GET(event('GET'));
		expect((await read<{ markers: Marker[] }>(listed)).markers).toMatchObject([
			{ title: 'Sibling' }
		]);
		expect(listed.headers.get('cache-control')).toContain('no-store');
	});
	it('replays creation after a lost response without inserting a duplicate', async () => {
		// The first commit succeeds but its acknowledgement never reaches the client.
		expect((await POST(event('POST', input))).status).toBe(201);
		const retried = await POST(event('POST', input));
		expect(retried.status).toBe(200);
		expect(await retried.json()).toEqual({ ...input, revision: 1 });
		expect((await POST(event('POST', { ...input, title: 'Changed draft' }))).status).toBe(409);
		expect((await read<{ markers: Marker[] }>(await GET(event('GET')))).markers).toEqual([
			{ ...input, revision: 1 }
		]);
	});
	it('does not resurrect a deleted marker when an old creation request retries', async () => {
		const marker = await read<Marker>(await POST(event('POST', input)));
		expect(
			(await DELETE(event('DELETE', { id: marker.id, revision: marker.revision }))).status
		).toBe(204);
		expect((await POST(event('POST', input))).status).toBe(409);
		expect((await PUT(event('PUT', { ...marker, title: 'Restore' }))).status).toBe(409);
		expect((await read<{ markers: Marker[] }>(await GET(event('GET')))).markers).toEqual([]);
	});
	it('rejects stale edits and deletes, preserving the winning content', async () => {
		const marker = await read<Marker>(await POST(event('POST', input)));
		await PUT(event('PUT', { ...marker, title: 'Winner' }));
		expect((await PUT(event('PUT', { ...marker, title: 'Stale' }))).status).toBe(409);
		expect((await DELETE(event('DELETE', { id: marker.id, revision: 1 }))).status).toBe(409);
		expect((await read<{ markers: Marker[] }>(await GET(event('GET')))).markers[0].title).toBe(
			'Winner'
		);
	});
	it('fails closed without its own database', async () => {
		expect((await GET({ ...event('GET'), platform: undefined })).status).toBe(503);
	});
	it('rejects foreign origin mutations and invalid data before any row is written', async () => {
		expect((await POST(event('POST', input, 'https://foreign.example'))).status).toBe(403);
		expect((await POST(event('POST', { ...input, date: '2030-02-30' }))).status).toBe(400);
		expect((await POST(event('POST', { ...input, title: 'x'.repeat(9000) }))).status).toBe(413);
		expect((await read<{ markers: Marker[] }>(await GET(event('GET')))).markers).toEqual([]);
	});
	it('requires exact revision and identity without accepting surplus fields', async () => {
		const marker = await read<Marker>(await POST(event('POST', input)));
		for (const revision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER, '1'])
			expect((await PUT(event('PUT', { ...marker, revision }))).status).toBe(400);
		expect((await PUT(event('PUT', { ...marker, extra: true }))).status).toBe(400);
		expect(
			(await DELETE(event('DELETE', { id: marker.id, revision: 1, extra: true }))).status
		).toBe(400);
	});
	it('does not expose database error bodies', async () => {
		sqlite.close();
		const response = await GET(event('GET'));
		expect(response.status).toBe(503);
		expect(await response.text()).not.toMatch(/SQL|sqlite|database is not open/i);
		sqlite = new DatabaseSync(':memory:');
	});
});
