import { beforeEach, afterEach, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { GET, POST, DELETE } from './+server';
import { hashHostToken } from '$lib/server/hosts';
import { sqliteD1, hostMigrations } from '$lib/server/sqlite-d1';
let sqlite: DatabaseSync;
let platform: App.Platform;
const id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
	token = `nw_${'01'.repeat(32)}`;
let hash: string;
beforeEach(async () => {
	let db: D1Database;
	({ sqlite, db } = sqliteD1(...hostMigrations));
	platform = { env: { HOSTS_DB: db } } as unknown as App.Platform;
	hash = await hashHostToken(token);
});
afterEach(() => sqlite.close());
const event = (
	method: string,
	body?: unknown,
	options: { owner?: boolean; origin?: string } = {}
) =>
	({
		platform,
		url: new URL('https://dashboard.example/api/hosts'),
		request: new Request('https://dashboard.example/api/hosts', {
			method,
			headers: {
				'Content-Type': 'application/json',
				Origin: options.origin ?? 'https://dashboard.example',
				...(options.owner === false ? {} : { 'Cf-Access-Jwt-Assertion': 'edge-verified' })
			},
			...(body ? { body: JSON.stringify(body) } : {})
		})
	}) as unknown as Parameters<typeof POST>[0];
const stage = () => POST(event('POST', { action: 'stage', id, hash, label: 'Mac mini' }));
const approve = () => POST(event('POST', { action: 'approve', id }));

it('stages and approves a host only through the protected same-origin dashboard', async () => {
	for (const opts of [{ origin: 'https://foreign.example' }, { owner: false }])
		expect(
			(await POST(event('POST', { action: 'stage', id, hash, label: 'Mac mini' }, opts))).status
		).toBe(403);
	expect(sqlite.prepare('SELECT count(*) AS n FROM hosts').get()?.n).toBe(0);
	expect((await stage()).status).toBe(201);
	expect((await approve()).status).toBe(200);
	expect(await (await GET(event('GET'))).json()).toMatchObject({
		hosts: [{ id, label: 'Mac mini', state: 'active' }]
	});
});

it('lists and revokes hosts without publishing token fingerprints', async () => {
	await stage();
	await approve();
	const raw = await (await GET(event('GET'))).text();
	expect(raw).not.toContain(hash);
	expect(raw).not.toContain(token);
	expect((await DELETE(event('DELETE', { id }))).status).toBe(204);
	expect(await (await GET(event('GET'))).json()).toMatchObject({
		hosts: [{ id, state: 'revoked' }]
	});
	expect((await approve()).status).toBe(409);
});

it('rejects surplus fields, a device kind, and unconfigured storage without leaking SQL', async () => {
	for (const extra of [{ scope: 'write' }, { kind: 'host' }])
		expect(
			(await POST(event('POST', { action: 'stage', id, hash, label: 'Mac mini', ...extra }))).status
		).toBe(400);
	expect((await GET({ ...event('GET'), platform: undefined })).status).toBe(503);
	sqlite.close();
	const response = await GET(event('GET'));
	expect(response.status).toBe(503);
	expect(await response.text()).not.toMatch(/SQL|sqlite/);
	({ sqlite } = sqliteD1());
});
