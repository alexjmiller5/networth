import { afterEach, beforeEach, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { sqliteD1 } from './sqlite-d1';
import { FinanceRuns, RunBusyError, RunConflictError } from './finance-runs';

let sqlite: DatabaseSync;
let runs: FinanceRuns;
const now = 2_000_000_000_000;
const hostA = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
	hostB = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
beforeEach(() => {
	const d1 = sqliteD1('migrations-finance-runs/0001_runs.sql');
	sqlite = d1.sqlite;
	runs = new FinanceRuns(d1.db);
});
afterEach(() => sqlite.close());

it('queues a run and replays the same request without creating another', async () => {
	const run = await runs.create({ requestId: 'r1', accountIds: ['cash'] }, now);
	expect(run).toMatchObject({ status: 'queued', account_ids: ['cash'], cancel_requested: false });
	expect(await runs.create({ requestId: 'r1', accountIds: ['cash'] }, now + 5)).toEqual(run);
	await expect(runs.create({ requestId: 'r1', accountIds: ['bofa'] }, now)).rejects.toThrow(
		RunConflictError
	);
	expect((await runs.list(10)).length).toBe(1);
});

it('refuses a second run while one is active, and allows one after it ends', async () => {
	const first = await runs.create({ requestId: 'r1', accountIds: ['cash'] }, now);
	const busy = await runs.create({ requestId: 'r2', accountIds: ['cash'] }, now).catch((e) => e);
	expect(busy).toBeInstanceOf(RunBusyError);
	expect((busy as RunBusyError).active.id).toBe(first.id);
	await runs.claim(hostA, now + 1);
	await expect(runs.create({ requestId: 'r3', accountIds: ['cash'] }, now)).rejects.toThrow(
		RunBusyError
	);
	await runs.update(first.id, hostA, { status: 'done', summary: 'ok' }, now + 2);
	expect(await runs.create({ requestId: 'r4', accountIds: ['cash'] }, now + 3)).toMatchObject({
		status: 'queued'
	});
});

it('lets the one host claim the oldest queued run, and resumes it after a restart', async () => {
	expect(await runs.claim(hostA, now)).toBeNull();
	const run = await runs.create({ requestId: 'r1', accountIds: ['cash', 'bofa-checking'] }, now);
	const claimed = await runs.claim(hostA, now + 1);
	expect(claimed).toMatchObject({
		id: run.id,
		status: 'claimed',
		host_id: hostA,
		claimed_at: now + 1
	});
	expect(await runs.claim(hostB, now + 2)).toBeNull();
	expect(await runs.claim(hostA, now + 3)).toMatchObject({ id: run.id, claimed_at: now + 1 });
});

it('cancels a queued run outright and flags a claimed run for the host', async () => {
	const queued = await runs.create({ requestId: 'r1', accountIds: ['cash'] }, now);
	expect(await runs.cancel(queued.id, now + 1)).toMatchObject({
		status: 'canceled',
		cancel_requested: true,
		finished_at: now + 1
	});
	expect(await runs.claim(hostA, now + 2)).toBeNull();
	expect(await runs.cancel(queued.id, now + 3)).toBeNull();
	const next = await runs.create({ requestId: 'r2', accountIds: ['cash'] }, now + 4);
	await runs.claim(hostA, now + 5);
	expect(await runs.cancel(next.id, now + 6)).toMatchObject({
		status: 'claimed',
		cancel_requested: true,
		finished_at: null
	});
	expect(await runs.get(next.id)).toMatchObject({ cancel_requested: true });
});

it('accepts reports only from the claiming host and only forward transitions', async () => {
	const run = await runs.create({ requestId: 'r1', accountIds: ['cash'] }, now);
	expect(await runs.update(run.id, hostA, { status: 'running' }, now + 1)).toBeNull();
	await runs.claim(hostA, now + 1);
	expect(await runs.update(run.id, hostB, { status: 'running' }, now + 2)).toBeNull();
	const running = await runs.update(
		run.id,
		hostA,
		{
			status: 'running',
			tab_id: 'w1:t9',
			pane_id: 'w1:p9',
			tab_label: 'Finance review 2033-05-18',
			agent_name: 'finance-run-12345678',
			agent_kind: 'claude'
		},
		now + 2
	);
	expect(running).toMatchObject({ status: 'running', started_at: now + 2, agent_kind: 'claude' });
	expect(await runs.update(run.id, hostA, { agent_kind: 'codex' }, now + 3)).toMatchObject({
		status: 'running',
		agent_kind: 'codex',
		started_at: now + 2
	});
	expect(
		await runs.update(run.id, hostA, { status: 'failed', summary: 'Bank 2FA timed out' }, now + 4)
	).toMatchObject({ status: 'failed', summary: 'Bank 2FA timed out', finished_at: now + 4 });
	expect(await runs.update(run.id, hostA, { status: 'running' }, now + 5)).toBeNull();
	expect(await runs.update(run.id, hostA, { summary: 'late' }, now + 5)).toBeNull();
});

it('lists newest first', async () => {
	const a = await runs.create({ requestId: 'r1', accountIds: ['cash'] }, now);
	await runs.cancel(a.id, now + 1);
	const b = await runs.create({ requestId: 'r2', accountIds: ['cash'] }, now + 2);
	expect((await runs.list(10)).map((r) => r.id)).toEqual([b.id, a.id]);
});
