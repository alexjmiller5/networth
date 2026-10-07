import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { GET, POST, DELETE } from './+server';
import { GET as financeGET } from '../finance/+server';
import {
	GET as deviceGET,
	DELETE as deviceDELETE,
	POST as devicePOST
} from '../device/[...path]/+server';
import { hashWidgetToken } from '$lib/server/widget-devices';
vi.mock('../finance/+server', () => ({
	GET: vi.fn(
		async () =>
			new Response(
				JSON.stringify({ accounts: [], txns: [], coverage: [], privateEvidence: 'do not expose' })
			)
	)
}));
let sqlite: DatabaseSync;
let platform: App.Platform;
const id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
	token = `nw_${'01'.repeat(32)}`;
let hash: string;
beforeEach(async () => {
	sqlite = new DatabaseSync(':memory:');
	sqlite.exec(readFileSync('migrations-widgets/0001_devices.sql', 'utf8'));
	const db = {
		prepare(sql: string) {
			const stmt = sqlite.prepare(sql);
			const bind = (...v: (string | number | null)[]) => ({
				async first() {
					return stmt.get(...v) ?? null;
				},
				async all() {
					return { results: stmt.all(...v) };
				}
			});
			return { ...bind(), bind };
		}
	};
	platform = { env: { WIDGETS_DB: db } } as unknown as App.Platform;
	hash = await hashWidgetToken(token);
});
afterEach(() => sqlite.close());
const event = (
	method: string,
	body?: unknown,
	options: { path?: string; owner?: boolean; origin?: string; token?: string } = {}
) =>
	({
		platform,
		params: { path: options.path ?? 'session' },
		url: new URL('https://dashboard.example/api/widget-devices'),
		request: new Request('https://dashboard.example/api/widget-devices', {
			method,
			headers: {
				'Content-Type': 'application/json',
				Origin: options.origin ?? 'https://dashboard.example',
				...(options.owner === false ? {} : { 'Cf-Access-Jwt-Assertion': 'edge-verified' }),
				...(options.token ? { Authorization: `Bearer ${options.token}` } : {})
			},
			...(body ? { body: JSON.stringify(body) } : {})
		}),
		fetch: globalThis.fetch
	}) as unknown as Parameters<typeof POST>[0];
const stage = () => POST(event('POST', { action: 'stage', id, hash, label: 'Example phone' }));
const approve = () => POST(event('POST', { action: 'approve', id }));
it('requires protected same-origin approval before serving a narrow snapshot', async () => {
	expect((await deviceGET(event('GET', undefined, { token }))).status).toBe(401);
	expect((await stage()).status).toBe(201);
	expect((await deviceGET(event('GET', undefined, { token }))).status).toBe(200);
	expect((await deviceGET(event('GET', undefined, { token, path: 'snapshot' }))).status).toBe(403);
	expect((await approve()).status).toBe(200);
	const response = await deviceGET(event('GET', undefined, { token, path: 'snapshot' }));
	expect(response.status).toBe(200);
	expect(await response.clone().text()).not.toContain('privateEvidence');
	expect(await response.json()).toMatchObject({ version: 1, balances: [] });
	expect(response.headers.get('cache-control')).toContain('no-store');
});
it('rejects cross-origin/missing edge identity before creating rows and does not allow public staging', async () => {
	for (const opts of [{ origin: 'https://foreign.example' }, { owner: false }])
		expect(
			(await POST(event('POST', { action: 'stage', id, hash, label: 'Example' }, opts))).status
		).toBe(403);
	expect(
		(await devicePOST(event('POST', { action: 'stage', id, hash, label: 'Example' }, { token })))
			.status
	).toBe(405);
	expect(sqlite.prepare('SELECT count(*) AS n FROM widget_devices').get()?.n).toBe(0);
});
it('does not let even an active device read full finance or mutate data, and honors revocation', async () => {
	await stage();
	await approve();
	expect((await deviceGET(event('GET', undefined, { token, path: 'finance' }))).status).toBe(404);
	expect((await devicePOST(event('POST', {}, { token, path: 'snapshot' }))).status).toBe(405);
	expect((await deviceDELETE(event('DELETE', undefined, { token }))).status).toBe(204);
	expect((await deviceGET(event('GET', undefined, { token, path: 'snapshot' }))).status).toBe(403);
	expect((await approve()).status).toBe(409);
});
it('lists and revokes individual devices without publishing token fingerprints', async () => {
	await stage();
	await approve();
	const result = await GET(event('GET'));
	expect(await result.json()).toMatchObject({ devices: [{ id, state: 'active' }] });
	const raw = await (await GET(event('GET'))).text();
	expect(raw).not.toContain(hash);
	expect(raw).not.toContain(token);
	expect((await DELETE(event('DELETE', { id }))).status).toBe(204);
	expect((await deviceGET(event('GET', undefined, { token, path: 'session' }))).status).toBe(200);
});
it('rejects surplus fields and unconfigured storage without leaking SQL', async () => {
	expect(
		(await POST(event('POST', { action: 'stage', id, hash, label: 'Example', scope: 'write' })))
			.status
	).toBe(400);
	expect((await GET({ ...event('GET'), platform: undefined })).status).toBe(503);
	sqlite.close();
	const response = await GET(event('GET'));
	expect(response.status).toBe(503);
	expect(await response.text()).not.toMatch(/SQL|sqlite/);
	sqlite = new DatabaseSync(':memory:');
});

it('withholds a snapshot if the owner revokes access while financial sources are loading', async () => {
	await stage();
	await approve();
	vi.mocked(financeGET).mockImplementationOnce(async () => {
		await DELETE(event('DELETE', { id }));
		return new Response(JSON.stringify({ accounts: [], txns: [], coverage: [] }));
	});
	expect((await deviceGET(event('GET', undefined, { token, path: 'snapshot' }))).status).toBe(403);
});
