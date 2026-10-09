import { afterEach, beforeEach, expect, it } from 'vitest';
import type { FinanceRun } from '$lib/finance/run-contract';
import type { DatabaseSync } from 'node:sqlite';
import { sqliteD1 } from '$lib/server/sqlite-d1';
import { WidgetDevices, hashWidgetToken } from '$lib/server/widget-devices';
import { FinanceRuns } from '$lib/server/finance-runs';
import { POST as claim } from './claim/+server';
import { GET, PATCH } from './runs/[id]/+server';

let widgets: DatabaseSync, runsDb: DatabaseSync;
let platform: App.Platform;
let runs: FinanceRuns;
const host = `nw_${'01'.repeat(32)}`,
	widget = `nw_${'02'.repeat(32)}`,
	pending = `nw_${'03'.repeat(32)}`;
beforeEach(async () => {
	const w = sqliteD1(
		'migrations-widgets/0001_devices.sql',
		'migrations-widgets/0002_device_kind.sql'
	);
	const r = sqliteD1('migrations-finance-runs/0001_runs.sql');
	widgets = w.sqlite;
	runsDb = r.sqlite;
	platform = { env: { WIDGETS_DB: w.db, FINANCE_RUNS_DB: r.db } } as unknown as App.Platform;
	runs = new FinanceRuns(r.db);
	const devices = new WidgetDevices(w.db),
		now = Date.now();
	const enroll = async (token: string, n: number, kind: 'host' | 'widget', approve = true) => {
		const id = `aaaaaaaa-aaaa-4aaa-aaaa-00000000000${n}`;
		await devices.stage({ id, hash: await hashWidgetToken(token), label: 'Device', kind }, now);
		if (approve) await devices.approve(id, now);
	};
	await enroll(host, 1, 'host');
	await enroll(widget, 2, 'widget');
	await enroll(pending, 3, 'host', false);
});
afterEach(() => {
	widgets.close();
	runsDb.close();
});
const event = (method: string, token: string | null, body?: unknown, id?: string) =>
	({
		platform,
		params: { id },
		url: new URL('https://dashboard.example/api/finance-host/v1/claim'),
		request: new Request('https://dashboard.example/api/finance-host/v1/claim', {
			method,
			headers: {
				'Content-Type': 'application/json',
				...(token ? { Authorization: `Bearer ${token}` } : {})
			},
			...(body ? { body: JSON.stringify(body) } : {})
		})
	}) as unknown as Parameters<typeof claim>[0];

it('admits only an approved host device', async () => {
	await runs.create({ requestId: 'r1', accountIds: ['cash'] }, Date.now());
	for (const token of [null, widget, pending, 'nw_bad'])
		expect([401, 403]).toContain((await claim(event('POST', token, { wait_seconds: 0 }))).status);
	expect(runsDb.prepare('SELECT status FROM finance_runs').get()?.status).toBe('queued');
});

it('long-polls until a run is queued, then reports progress and completion', async () => {
	const empty = await claim(event('POST', host, { wait_seconds: 0 }));
	expect(await empty.json()).toEqual({ run: null });
	setTimeout(() => void runs.create({ requestId: 'r1', accountIds: ['cash'] }, Date.now()), 200);
	const started = Date.now();
	const { run } = (await (await claim(event('POST', host, { wait_seconds: 5 }))).json()) as {
		run: FinanceRun;
	};
	expect(run).toMatchObject({ status: 'claimed', account_ids: ['cash'] });
	expect(Date.now() - started).toBeLessThan(4000);
	const patch = (body: unknown) => PATCH(event('PATCH', host, body, run.id));
	expect(
		await (
			await patch({
				status: 'running',
				tab_id: 'w1:t9',
				pane_id: 'w1:p9',
				tab_label: 'Finance review 2026-10-08',
				agent_name: `finance-run-${run.id.slice(0, 8)}`,
				agent_kind: 'claude'
			})
		).json()
	).toMatchObject({ run: { status: 'running', tab_label: 'Finance review 2026-10-08' } });
	expect((await patch({ host_id: 'x' })).status).toBe(400);
	await runs.cancel(run.id, Date.now());
	expect(await (await GET(event('GET', host, undefined, run.id))).json()).toMatchObject({
		run: { cancel_requested: true, status: 'running' }
	});
	expect((await GET(event('GET', widget, undefined, run.id))).status).toBe(403);
	expect(await (await patch({ status: 'canceled', summary: 'Stopped' })).json()).toMatchObject({
		run: { status: 'canceled' }
	});
	expect((await patch({ status: 'running' })).status).toBe(409);
});

it('rejects malformed claims', async () => {
	for (const body of [{ wait_seconds: 26 }, { wait_seconds: -1 }, { wait_seconds: 1, x: 1 }])
		expect((await claim(event('POST', host, body))).status).toBe(400);
});
