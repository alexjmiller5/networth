import { afterEach, beforeEach, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sqliteD1 } from '../../../tests/support/sqlite-d1';
import { FinanceRuns } from './finance-runs';

const request = {
	request_id: 'request-1',
	action: 'finance-review' as const,
	account_ids: ['account-b', 'account-a'],
	tracking_task_ids: ['task-1']
};
let sqlite: DatabaseSync, store: FinanceRuns, dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'finance-runs-'));
	sqlite = new DatabaseSync(join(dir, 'runs.db'));
	sqlite.exec(readFileSync('migrations/finance-runs/0001.sql', 'utf8'));
	store = new FinanceRuns(sqliteD1(sqlite));
});
afterEach(() => {
	sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});
const eligible = async () => true;

it('replays a durable request before consulting a changed account registry', async () => {
	const first = await store.launch('principal-a', 'browser-1', request, eligible);
	sqlite.close();
	sqlite = new DatabaseSync(join(dir, 'runs.db'));
	store = new FinanceRuns(sqliteD1(sqlite));
	const retry = await store.launch(
		'principal-a',
		'browser-1',
		{ ...request, account_ids: ['account-a', 'account-b'] },
		async () => {
			throw new Error('closed registry must not be consulted');
		}
	);
	expect(retry).toEqual(first);
	expect(first.account_ids).toEqual(['account-a', 'account-b']);
	expect(first.collection).toBe('not_started');
	expect(first.readiness.native_identity.state).toBe('unavailable');
	await expect(
		store.launch('principal-a', 'browser-1', { ...request, account_ids: ['account-a'] }, eligible)
	).rejects.toMatchObject({ code: 'idempotency_conflict' });
});

it('reserves the physical browser across principals without disclosing the existing run', async () => {
	const run = await store.launch('principal-a', 'browser-1', request, eligible);
	await expect(store.launch('principal-b', 'browser-1', request, eligible)).rejects.toMatchObject({
		code: 'domain_busy'
	});
	expect(await store.read('principal-b', run.run_id)).toBeNull();
	await expect(store.cancel('principal-b', run.run_id)).rejects.toMatchObject({
		code: 'not_found'
	});
	expect((await store.read('principal-a', run.run_id))?.reservation).toBe('held');
	expect(sqlite.prepare('SELECT count(*) AS n FROM finance_runs').get()?.n).toBe(1);
});

it('rejects unknown or ineligible scope without leaving a run or reservation', async () => {
	await expect(
		store.launch('principal-a', 'browser-1', request, async () => false)
	).rejects.toMatchObject({ code: 'invalid_request' });
	expect(sqlite.prepare('SELECT count(*) AS n FROM finance_runs').get()?.n).toBe(0);
	await expect(
		store.launch(
			'principal-a',
			'browser-1',
			{ ...request, account_ids: ['account-a', 'account-a'] },
			eligible
		)
	).rejects.toThrow();
	expect(sqlite.prepare('SELECT count(*) AS n FROM finance_runs').get()?.n).toBe(0);
});

it('atomically closes an unclaimed run and fences a later claim without fabricating a collector acknowledgment', async () => {
	const run = await store.launch('principal-a', 'browser-1', request, eligible);
	const cancel = await store.cancel('principal-a', run.run_id);
	expect(cancel).toMatchObject({
		cancellation: 'acknowledged',
		acknowledgment_kind: 'server_unclaimed',
		capture_closed: true
	});
	expect(await store.claim('host-1', run.run_id, cancel.revision, 'lease-1')).toBeNull();
	expect((await store.read('principal-a', run.run_id))?.reservation).toBe('released');
	expect(await store.cancel('principal-a', run.run_id)).toEqual(cancel);
	const next = await store.launch(
		'principal-b',
		'browser-1',
		{ ...request, request_id: 'request-2' },
		eligible
	);
	expect(next.run_id).not.toBe(run.run_id);
});

it('commits a host intent before claim acknowledgment and retains ambiguous ownership after cancel', async () => {
	const run = await store.launch('principal-a', 'browser-1', request, eligible);
	const claimed = await store.claim('host-1', run.run_id, run.revision, 'lease-1');
	expect(claimed).toMatchObject({
		host_id: 'host-1',
		lease_generation: 'lease-1',
		transport: 'claimed',
		collection: 'not_started'
	});
	expect(
		sqlite.prepare('SELECT host_operation_intent FROM finance_runs WHERE run_id=?').get(run.run_id)
			?.host_operation_intent
	).toBe(1);
	expect(await store.claim('host-2', run.run_id, run.revision, 'lease-2')).toBeNull();
	const cancel = await store.cancel('principal-a', run.run_id);
	expect(cancel).toMatchObject({
		cancellation: 'requested',
		acknowledgment_kind: null,
		capture_closed: false
	});
	expect((await store.read('principal-a', run.run_id))?.reservation).toBe('held');
	await expect(store.launch('principal-b', 'browser-1', request, eligible)).rejects.toMatchObject({
		code: 'domain_busy'
	});
	expect(await store.cancel('principal-a', run.run_id)).toEqual(cancel);
});

it('resolves concurrent identical requests to one committed run and conflicting retries to one winner', async () => {
	const runs = await Promise.all([
		store.launch('principal-a', 'browser-1', request, eligible),
		store.launch(
			'principal-a',
			'browser-1',
			{ ...request, account_ids: ['account-a', 'account-b'] },
			eligible
		)
	]);
	expect(runs[0]).toEqual(runs[1]);
	expect(sqlite.prepare('SELECT count(*) AS n FROM finance_runs').get()?.n).toBe(1);
	const replay = await store.launch('principal-a', 'different-browser', request, async () => false);
	expect(replay.domain_id).toBe('browser-1');
	await store.cancel('principal-a', runs[0].run_id);
	const closed = await store.launch('principal-a', 'browser-1', request, async () => false);
	expect(closed.run_id).toBe(runs[0].run_id);
	expect(closed.capture_closed).toBe(true);
});

it('retains one global reservation when simultaneous principals attempt the same physical domain', async () => {
	const outcomes = await Promise.allSettled([
		store.launch('principal-a', 'browser-1', request, eligible),
		store.launch('principal-b', 'browser-1', request, eligible)
	]);
	expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
	const failed = outcomes.find((r) => r.status === 'rejected') as PromiseRejectedResult;
	expect(Object.keys(failed.reason)).toEqual(['code']);
	expect(failed.reason.code).toBe('domain_busy');
});

it('does not let eligibility checking alter the frozen requested scope', async () => {
	await expect(
		store.launch('principal-a', 'browser-1', request, async (scope) => {
			scope.account_ids.pop();
			return true;
		})
	).rejects.toThrow();
	expect(sqlite.prepare('SELECT count(*) AS n FROM finance_runs').get()?.n).toBe(0);
});

it('does not commit a host intent for an invalid or stale claim', async () => {
	const run = await store.launch('principal-a', 'browser-1', request, eligible);
	expect(await store.claim('host-1', run.run_id, run.revision + 1, 'lease-1')).toBeNull();
	await expect(store.claim('', run.run_id, run.revision, 'lease-1')).rejects.toMatchObject({
		code: 'invalid_request'
	});
	expect(
		sqlite.prepare('SELECT host_operation_intent FROM finance_runs WHERE run_id=?').get(run.run_id)
			?.host_operation_intent
	).toBe(0);
	expect(await store.read('principal-a', run.run_id)).toEqual(run);
});
