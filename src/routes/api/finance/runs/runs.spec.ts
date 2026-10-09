import { afterEach, beforeEach, expect, it } from 'vitest';
import type { FinanceRun } from '$lib/finance/run-contract';
import type { DatabaseSync } from 'node:sqlite';
import { sqliteD1 } from '$lib/server/sqlite-d1';
import { GET, POST } from './+server';
import { POST as cancel } from './[id]/cancel/+server';

let sqlite: DatabaseSync;
let platform: App.Platform;
beforeEach(() => {
	const d1 = sqliteD1('migrations-finance-runs/0001_runs.sql');
	sqlite = d1.sqlite;
	platform = { env: { FINANCE_RUNS_DB: d1.db } } as unknown as App.Platform;
});
afterEach(() => sqlite.close());
const event = (
	method: string,
	body?: unknown,
	options: { owner?: boolean; origin?: string; id?: string } = {}
) =>
	({
		platform,
		params: { id: options.id },
		url: new URL('https://dashboard.example/api/finance/runs'),
		request: new Request('https://dashboard.example/api/finance/runs', {
			method,
			headers: {
				'Content-Type': 'application/json',
				Origin: options.origin ?? 'https://dashboard.example',
				...(options.owner === false ? {} : { 'Cf-Access-Jwt-Assertion': 'edge-verified' })
			},
			...(body ? { body: JSON.stringify(body) } : {})
		})
	}) as unknown as Parameters<typeof POST>[0];
const start = (request_id: string, account_ids: unknown = ['cash']) =>
	POST(event('POST', { request_id, account_ids }));

it('starts one run, replays the same click, and refuses a second run with a clear message', async () => {
	const first = await start('11111111-1111-4111-8111-111111111111');
	expect(first.status).toBe(201);
	const { run } = (await first.json()) as { run: FinanceRun };
	expect(run).toMatchObject({ status: 'queued', account_ids: ['cash'] });
	const replay = (await (await start('11111111-1111-4111-8111-111111111111')).json()) as {
		run: FinanceRun;
	};
	expect(replay.run.id).toBe(run.id);
	const busy = await start('22222222-2222-4222-8222-222222222222');
	expect(busy.status).toBe(409);
	expect(await busy.json()).toMatchObject({
		error: expect.stringMatching(/already queued/),
		run: { id: run.id }
	});
	expect(await (await GET(event('GET'))).json()).toMatchObject({ runs: [{ id: run.id }] });
});

it('cancels a queued run and then allows a new one', async () => {
	const { run } = (await (await start('11111111-1111-4111-8111-111111111111')).json()) as {
		run: FinanceRun;
	};
	const canceled = await cancel(event('POST', undefined, { id: run.id }));
	expect(await canceled.json()).toMatchObject({ run: { status: 'canceled' } });
	expect((await cancel(event('POST', undefined, { id: run.id }))).status).toBe(409);
	expect((await start('22222222-2222-4222-8222-222222222222')).status).toBe(201);
});

it('rejects foreign origins, missing edge identity and malformed accounts before writing', async () => {
	const body = { request_id: '11111111-1111-4111-8111-111111111111', account_ids: ['cash'] };
	expect((await POST(event('POST', body, { origin: 'https://evil.example' }))).status).toBe(403);
	expect((await POST(event('POST', body, { owner: false }))).status).toBe(403);
	expect((await GET(event('GET', undefined, { owner: false }))).status).toBe(403);
	for (const bad of [[], ['Cash; rm'], 'cash'])
		expect((await start('11111111-1111-4111-8111-111111111111', bad)).status).toBe(400);
	expect((await POST(event('POST', { ...body, command: 'x' }))).status).toBe(400);
	expect((await cancel(event('POST', undefined, { id: 'nope' }))).status).toBe(404);
	expect(sqlite.prepare('SELECT count(*) AS n FROM finance_runs').get()?.n).toBe(0);
	expect((await GET({ ...event('GET'), platform: undefined })).status).toBe(503);
});
