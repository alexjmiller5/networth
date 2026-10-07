import { afterEach, beforeEach, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { FinanceRunStore } from './finance-run-store';

let directory, database, store, path, eligible, host, resolutions, failAt;
const connections = [];
const request = (overrides = {}) => ({
	request_id: 'request-1',
	action: 'finance-review',
	account_ids: ['account-b', 'account-a'],
	tracking_task_ids: ['task-1'],
	...overrides
});
const claim = (overrides = {}) => ({ request_id: 'claim-1', wait_seconds: 0, ...overrides });
function storage(db) {
	return {
		transaction(operation) {
			db.exec('BEGIN IMMEDIATE');
			let writes = 0;
			try {
				const result = operation({
					get: (sql, ...args) => db.prepare(sql).get(...args) ?? null,
					run: (sql, ...args) => {
						const result = db.prepare(sql).run(...args);
						if (failAt === ++writes) throw new Error('injected crash');
						return { changes: Number(result.changes) };
					}
				});
				db.exec('COMMIT');
				return result;
			} catch (error) {
				db.exec('ROLLBACK');
				throw error;
			}
		}
	};
}
function open() {
	const db = new DatabaseSync(path);
	db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
	connections.push(db);
	return db;
}
function make(db = database, domainId = 'domain-1') {
	return new FinanceRunStore(storage(db), {
		domainId,
		resolveScope: (_principal, ids) => {
			resolutions++;
			return eligible ? ids.map((account_id) => ({ account_id, source_id: 'source-1' })) : null;
		},
		resolveHost: () => host
	});
}
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), 'finance-run-store-'));
	path = join(directory, 'runs.sqlite');
	database = open();
	database.exec(readFileSync('finance-run-migrations/0001_lifecycle.sql', 'utf8'));
	eligible = true;
	resolutions = 0;
	failAt = undefined;
	host = { principal_id: 'principal-1', domain_id: 'domain-1', enabled: true };
	store = make();
});
afterEach(() => {
	for (const db of connections.splice(0)) db.close();
	rmSync(directory, { recursive: true, force: true });
});

it('persists one canonical launch and original receipt across lost response, registry drift and reopen', async () => {
	const first = await store.launch('principal-1', request());
	expect(first).toMatchObject({ revision: 1 });
	eligible = false;
	const reopened = make(open());
	expect(
		await reopened.launch('principal-1', request({ account_ids: ['account-a', 'account-b'] }))
	).toEqual(first);
	expect(resolutions).toBe(1);
	expect(reopened.read('principal-1', first.run_id)).toMatchObject({
		revision: 1,
		reservation: 'held',
		cancellation: 'none',
		capture_closed: false,
		host_id: null,
		host_intent_id: null,
		scope: [
			{ account_id: 'account-a', source_id: 'source-1' },
			{ account_id: 'account-b', source_id: 'source-1' }
		]
	});
	expect(await reopened.launch('principal-1', request({ account_ids: ['account-a'] }))).toEqual({
		error: { code: 'idempotency_conflict' }
	});
});
it('rejects malformed or ineligible new scope without reserving a domain', async () => {
	for (const invalid of [
		{ account_ids: [] },
		{ account_ids: ['account-a', 'account-a'] },
		{ tracking_task_ids: [] },
		{ command: 'execute' },
		{ action: 'other' }
	])
		expect(await store.launch('principal-1', request(invalid))).toEqual({
			error: { code: 'invalid_request' }
		});
	eligible = false;
	expect(await store.launch('principal-1', request())).toEqual({ error: { code: 'forbidden' } });
	expect(database.prepare('SELECT count(*) n FROM finance_runs').get().n).toBe(0);
});
it('reserves physical domains globally and never leaks another principal scope', async () => {
	const first = await store.launch('principal-1', request());
	expect(await store.launch('principal-2', request({ request_id: 'request-2' }))).toEqual({
		error: { code: 'domain_busy' }
	});
	expect(store.read('principal-2', first.run_id)).toEqual({ error: { code: 'not_found' } });
	expect(store.cancel('principal-2', first.run_id)).toEqual({ error: { code: 'not_found' } });
	expect(await make(open(), 'domain-2').launch('principal-2', request())).toMatchObject({
		revision: 1
	});
});
it('commits host-operation intent and immutable binding with an exactly replayable claim', async () => {
	const launched = await store.launch('principal-1', request());
	const first = await store.claim('host-1', claim());
	expect(first.claim).toMatchObject({
		run_id: launched.run_id,
		host_id: 'host-1',
		revision: 2,
		account_ids: ['account-a', 'account-b'],
		domain_id: 'domain-1'
	});
	expect(store.read('principal-1', launched.run_id).host_intent_id).toEqual(expect.any(String));
	const cancelled = store.cancel('principal-1', launched.run_id);
	expect(cancelled).toMatchObject({
		cancellation: 'requested',
		capture_closed: false,
		acknowledgment_kind: null
	});
	expect(await make(open()).claim('host-1', claim())).toEqual(first);
	expect(await store.claim('host-1', claim({ wait_seconds: 1 }))).toEqual({
		error: { code: 'idempotency_conflict' }
	});
	expect(await store.claim('host-2', claim())).toEqual({ claim: null });
	expect(store.read('principal-1', launched.run_id)).toMatchObject({
		reservation: 'held',
		cancellation: 'requested',
		host_id: 'host-1',
		lease_generation: first.claim.lease_generation
	});
	expect(await store.launch('principal-2', request({ request_id: 'new' }))).toEqual({
		error: { code: 'domain_busy' }
	});
});
it('replays null claims after work arrives instead of acquiring a different run', async () => {
	expect(await store.claim('host-1', claim())).toEqual({ claim: null });
	await store.launch('principal-1', request());
	expect(await make(open()).claim('host-1', claim())).toEqual({ claim: null });
	expect((await store.claim('host-1', claim({ request_id: 'claim-2' }))).claim).not.toBeNull();
});
it('denies disabled, foreign-principal/domain and rebound hosts, even on receipt replay', async () => {
	await store.launch('principal-1', request());
	host = { ...host, enabled: false };
	expect(await store.claim('host-1', claim())).toEqual({ error: { code: 'forbidden' } });
	host = { principal_id: 'principal-2', domain_id: 'domain-1', enabled: true };
	expect(await store.claim('host-1', claim())).toEqual({ claim: null });
	host = { principal_id: 'principal-1', domain_id: 'domain-1', enabled: true };
	expect(await store.claim('host-1', claim())).toEqual({ error: { code: 'forbidden' } });
	host = { ...host, domain_id: 'other-domain' };
	expect(await store.claim('host-2', claim())).toEqual({ error: { code: 'forbidden' } });
});
it('unclaimed cancellation closes capture and releases atomically without a fictional collector receipt', async () => {
	const launched = await store.launch('principal-1', request());
	const result = store.cancel('principal-1', launched.run_id);
	expect(result).toEqual({
		run_id: launched.run_id,
		revision: 2,
		cancellation: 'acknowledged',
		capture_closed: true,
		acknowledgment_kind: 'server_unclaimed'
	});
	expect(store.cancel('principal-1', launched.run_id)).toEqual(result);
	expect(await store.claim('host-1', claim())).toEqual({ claim: null });
	expect(store.read('principal-1', launched.run_id)).toMatchObject({
		collection: 'cancelled',
		reservation: 'released',
		host_id: null
	});
	expect(await store.launch('principal-2', request({ request_id: 'next' }))).toMatchObject({
		revision: 1
	});
	expect(await store.launch('principal-1', request())).toEqual(launched);
});
it.each([1, 2])(
	'rolls back launch and reservation if write %i fails before commit',
	async (write) => {
		failAt = write;
		await expect(store.launch('principal-1', request())).rejects.toThrow('injected crash');
		failAt = undefined;
		expect(database.prepare('SELECT count(*) n FROM finance_runs').get().n).toBe(0);
		expect(await make(open()).launch('principal-1', request())).toMatchObject({ revision: 1 });
	}
);
it.each([1, 2])('rolls back host binding and claim receipt if write %i fails', async (write) => {
	const launched = await store.launch('principal-1', request());
	failAt = write;
	await expect(store.claim('host-1', claim())).rejects.toThrow('injected crash');
	failAt = undefined;
	expect(store.read('principal-1', launched.run_id)).toMatchObject({
		revision: 1,
		host_id: null,
		host_intent_id: null
	});
	expect((await make(open()).claim('host-1', claim())).claim).toMatchObject({
		run_id: launched.run_id,
		revision: 2
	});
});
it('rolls back interrupted unclaimed cancellation and retains the reservation', async () => {
	const launched = await store.launch('principal-1', request());
	failAt = 1;
	expect(() => store.cancel('principal-1', launched.run_id)).toThrow('injected crash');
	failAt = undefined;
	expect(make(open()).read('principal-1', launched.run_id)).toMatchObject({
		cancellation: 'none',
		capture_closed: false,
		reservation: 'held'
	});
});
it('database constraints reject binding, scope, cancellation and closure regressions', async () => {
	const launched = await store.launch('principal-1', request());
	await store.claim('host-1', claim());
	store.cancel('principal-1', launched.run_id);
	for (const sql of [
		"UPDATE finance_runs SET host_id='other'",
		"UPDATE finance_runs SET lease_generation='other'",
		"UPDATE finance_runs SET host_intent_id='other'",
		"UPDATE finance_runs SET scope_json='[]'",
		"UPDATE finance_runs SET cancellation='none'",
		'DELETE FROM finance_claim_receipts'
	])
		expect(() =>
			database.exec(sql.startsWith('UPDATE') ? sql + ', revision=revision+1' : sql)
		).toThrow();
	const closed = await make(open(), 'domain-2').launch('principal-2', request());
	make(database, 'domain-2').cancel('principal-2', closed.run_id);
	expect(() =>
		database
			.prepare('UPDATE finance_runs SET capture_closed=0,revision=revision+1 WHERE run_id=?')
			.run(closed.run_id)
	).toThrow();
});
it('has no start/event authority or runtime fallback when service-owned policy is unavailable', async () => {
	const disabled = new FinanceRunStore(storage(database), { domainId: 'domain-1' });
	expect(await disabled.launch('principal-1', request())).toEqual({
		error: { code: 'unsupported' }
	});
	expect(await disabled.claim('host-1', claim())).toEqual({ error: { code: 'forbidden' } });
	expect(store.start).toBeUndefined();
	expect(store.event).toBeUndefined();
});

async function competitor(action, args, { principal = 'principal-1', crash = false } = {}) {
	const worker = new Worker(
		`
  const {parentPort,workerData}=require('node:worker_threads');
  const {DatabaseSync}=require('node:sqlite');
  (async()=>{
   const {FinanceRunStore}=await import(workerData.module);
   const db=new DatabaseSync(workerData.path);db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
   const adapter={transaction(fn){db.exec('BEGIN IMMEDIATE');try{const value=fn({get:(sql,...args)=>db.prepare(sql).get(...args)??null,run:(sql,...args)=>({changes:Number(db.prepare(sql).run(...args).changes)})});if(workerData.crash)process.exit(0);db.exec('COMMIT');return value;}catch(e){db.exec('ROLLBACK');throw e;}}};
   const store=new FinanceRunStore(adapter,{domainId:'domain-1',resolveScope:(_p,ids)=>ids.map(account_id=>({account_id,source_id:'source-1'})),resolveHost:()=>({principal_id:workerData.principal,domain_id:'domain-1',enabled:true})});
   parentPort.once('message',async()=>{try{const result=await store[workerData.action](...workerData.args);parentPort.postMessage({result});}catch(e){parentPort.postMessage({error:e.message});}finally{db.close();}});
   parentPort.postMessage({ready:true});
  })().catch(error=>{parentPort.postMessage({error:error.message});process.exit(1)});
 `,
		{
			eval: true,
			workerData: {
				module: new URL('./finance-run-store.ts', import.meta.url).href,
				path,
				action,
				args,
				principal,
				crash
			}
		}
	);
	let readyResolve, resultResolve, resultReject;
	const ready = new Promise((resolve) => {
		readyResolve = resolve;
	});
	const result = new Promise((resolve, reject) => {
		resultResolve = resolve;
		resultReject = reject;
	});
	worker.on('message', (message) => {
		if (message.ready) readyResolve();
		else if (message.error) resultReject(new Error(message.error));
		else resultResolve(message.result);
	});
	worker.on('error', (error) => {
		readyResolve();
		resultReject(error);
	});
	const exited = new Promise((resolve) =>
		worker.on('exit', (code) => {
			if (crash && code === 0) resultResolve(null);
			else if (code !== 0) resultReject(new Error(`Worker exited ${code}`));
			resolve();
		})
	);
	await ready;
	return { start: () => worker.postMessage('start'), result, exited };
}
it('serializes competing worker connections so only one global-domain launch commits', async () => {
	const a = await competitor('launch', ['principal-1', request()]);
	const b = await competitor('launch', ['principal-2', request({ request_id: 'other' })]);
	a.start();
	b.start();
	const results = await Promise.all([a.result, b.result]);
	await Promise.all([a.exited, b.exited]);
	expect(results.filter((result) => result.run_id)).toHaveLength(1);
	expect(results.filter((result) => result.error)).toEqual([{ error: { code: 'domain_busy' } }]);
	expect(
		database.prepare("SELECT count(*) n FROM finance_runs WHERE reservation='held'").get().n
	).toBe(1);
});
it('serializes a simultaneous claim/cancel without releasing a claimed physical domain', async () => {
	const launched = await store.launch('principal-1', request());
	const a = await competitor('claim', ['host-1', claim()]);
	const b = await competitor('cancel', ['principal-1', launched.run_id]);
	a.start();
	b.start();
	const [claimed, cancelled] = await Promise.all([a.result, b.result]);
	await Promise.all([a.exited, b.exited]);
	const state = store.read('principal-1', launched.run_id);
	if (claimed.claim) {
		expect(cancelled).toMatchObject({ cancellation: 'requested', capture_closed: false });
		expect(state).toMatchObject({ reservation: 'held', host_id: 'host-1' });
	} else {
		expect(cancelled).toMatchObject({
			cancellation: 'acknowledged',
			capture_closed: true,
			acknowledgment_kind: 'server_unclaimed'
		});
		expect(state).toMatchObject({ reservation: 'released', host_id: null });
	}
	expect(await store.claim('host-1', claim())).toEqual(claimed);
});
it('recovers an abrupt worker exit after both launch writes but before commit', async () => {
	const worker = await competitor('launch', ['principal-1', request()], { crash: true });
	worker.start();
	await worker.exited;
	expect(database.prepare('SELECT count(*) n FROM finance_runs').get().n).toBe(0);
	expect(database.prepare('SELECT count(*) n FROM finance_launch_receipts').get().n).toBe(0);
	expect(await make(open()).launch('principal-1', request())).toMatchObject({ revision: 1 });
});

it('deduplicates simultaneous identical launches across independent SQLite connections', async () => {
	const a = await competitor('launch', ['principal-1', request()]);
	const b = await competitor('launch', [
		'principal-1',
		request({ account_ids: ['account-a', 'account-b'] })
	]);
	a.start();
	b.start();
	const results = await Promise.all([a.result, b.result]);
	await Promise.all([a.exited, b.exited]);
	expect(results[0]).toEqual(results[1]);
	expect(database.prepare('SELECT count(*) n FROM finance_launch_receipts').get().n).toBe(1);
});
it('rejects changed or incomplete service-resolved scope instead of broadening the request', async () => {
	for (const resolved of [
		[],
		[
			{ account_id: 'account-a', source_id: 'source-1' },
			{ account_id: 'account-c', source_id: 'source-1' }
		],
		[
			{ account_id: 'account-a', source_id: 'source-1' },
			{ account_id: 'account-a', source_id: 'source-1' }
		],
		[
			{ account_id: 'account-a', source_id: '' },
			{ account_id: 'account-b', source_id: 'source-1' }
		]
	]) {
		const invalid = new FinanceRunStore(storage(database), {
			domainId: 'domain-1',
			resolveScope: () => resolved
		});
		expect(await invalid.launch('principal-1', request())).toEqual({
			error: { code: 'forbidden' }
		});
	}
	expect(database.prepare('SELECT count(*) n FROM finance_runs').get().n).toBe(0);
});
it('requires real database uniqueness even when a caller bypasses the domain precheck', async () => {
	await store.launch('principal-1', request());
	expect(() =>
		database.exec(
			"INSERT INTO finance_runs SELECT 'different-run','principal-2',domain_id,scope_json,task_ids_json,1,transport,collection,cancellation,reservation,capture_closed,host_id,lease_generation,host_intent_id FROM finance_runs"
		)
	).toThrow(/UNIQUE/);
});
