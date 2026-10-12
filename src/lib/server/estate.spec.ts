import { describe, expect, it, vi } from 'vitest';
import { estateSource, readEstate, type EstateSource } from './estate';
import { at, fakeHub } from './fake-hub';
import { sqliteD1 } from './sqlite-d1';

const cache = () => sqliteD1('migrations-estate-cache/0001_estate_cache.sql').db;
const source = (hub: ReturnType<typeof fakeHub>, db?: D1Database): EstateSource => ({
	hub: 'https://hub.example',
	token: 'synthetic-token',
	fetch: hub.fetch,
	db
});
const ids = (rows: Record<string, unknown>[]) => rows.map((r) => r.id);
const paths = (hub: ReturnType<typeof fakeHub>) => hub.requests.map((r) => r.path);

describe('estate reads', () => {
	it('pulls every table in one batch, then answers a quiet load with one cursor request', async () => {
		const hub = fakeHub({
			accounts: [
				{ id: 'b', name: 'B' },
				{ id: 'a', name: 'A' }
			],
			benefit_plans: [{ id: 'p', name: 'Plan' }]
		});
		const db = cache();
		const first = await readEstate(source(hub, db), ['accounts', 'benefit_plans']);
		expect(ids(first.rows.accounts)).toEqual(['a', 'b']);
		expect(first.rows.benefit_plans).toMatchObject([{ id: 'p', name: 'Plan' }]);
		expect(first.complete).toBe(true);
		expect(paths(hub)).toEqual(['/v1/cursor', '/v1/rows/pull']);
		hub.requests.length = 0;
		const batch = vi.spyOn(db, 'batch');
		const quiet = await readEstate(source(hub, db), ['accounts', 'benefit_plans']);
		expect(quiet).toEqual(first);
		expect(paths(hub)).toEqual(['/v1/cursor']);
		// A quiet load only reads the cache: one read batch, no writes.
		expect(batch).toHaveBeenCalledTimes(1);
	});

	it('applies arrivals and keeps tombstones with their columns', async () => {
		const hub = fakeHub({
			accounts: [
				{ id: 'a', name: 'A' },
				{ id: 'gone', name: 'Old' }
			]
		});
		const db = cache();
		await readEstate(source(hub, db), ['accounts']);
		hub.put('accounts', { id: 'a', name: 'A2' }, at(2));
		hub.put('accounts', { id: 'c', name: 'C' }, at(2));
		hub.put('accounts', { id: 'gone', name: 'Old', deleted_at: at(3) }, at(3));
		hub.requests.length = 0;
		const { rows } = await readEstate(source(hub, db), ['accounts']);
		expect(hub.pulls()).toMatchObject([{ table: 'accounts', since: at(1) }]);
		expect(rows.accounts).toMatchObject([
			{ id: 'a', name: 'A2' },
			{ id: 'c', name: 'C' },
			{ id: 'gone', name: 'Old', deleted_at: at(3) }
		]);
		// The cached copy is what the next quiet load serves.
		hub.requests.length = 0;
		expect((await readEstate(source(hub, db), ['accounts'])).rows).toEqual(rows);
		expect(paths(hub)).toEqual(['/v1/cursor']);
	});

	it('reads in full without a cache store, when it fails, or after the daily reset', async () => {
		const hub = fakeHub({ accounts: [{ id: 'a' }] });
		const broken = {
			prepare() {
				throw new Error('no such table: pull_state');
			}
		} as unknown as D1Database;
		for (const db of [undefined, broken, undefined]) {
			hub.requests.length = 0;
			expect(ids((await readEstate(source(hub, db), ['accounts'])).rows.accounts)).toEqual(['a']);
			expect(paths(hub)).toEqual(['/v1/cursor', '/v1/rows/pull']);
		}
		const db = cache();
		await readEstate(source(hub, db), ['accounts']);
		// The daily cron (worker.js) drops every cursor, so purged rows leave the copy.
		await db.prepare('DELETE FROM pull_state').run();
		hub.requests.length = 0;
		await readEstate(source(hub, db), ['accounts']);
		expect(hub.pulls()).toMatchObject([{ table: 'accounts', since: '' }]);
	});

	it('pulls in full again for another hub, without serving the other hub rows', async () => {
		const db = cache();
		await readEstate(source(fakeHub({ accounts: [{ id: 'old' }] }), db), ['accounts']);
		const other = fakeHub({ accounts: [{ id: 'new' }] });
		const { rows } = await readEstate({ ...source(other, db), hub: 'https://other.example' }, [
			'accounts'
		]);
		expect(ids(rows.accounts)).toEqual(['new']);
		expect(other.requests.every((r) => r.url.startsWith('https://other.example/'))).toBe(true);
		other.requests.length = 0;
		const again = await readEstate({ ...source(other, db), hub: 'https://other.example' }, [
			'accounts'
		]);
		expect(ids(again.rows.accounts)).toEqual(['new']);
		expect(paths(other)).toEqual(['/v1/cursor']);
	});

	it('reads other columns around the cache, leaving its copy and cursor alone', async () => {
		const hub = fakeHub({ points_balances: [{ id: 'p', program: 'Example', points: 1 }] });
		const db = cache();
		await readEstate(source(hub, db), ['points_balances']);
		const legacy = await readEstate(source(hub, db), ['points_balances'], {
			columns: { points_balances: ['id', 'program', 'points'] }
		});
		expect(Object.keys(legacy.rows.points_balances[0]).sort()).toEqual([
			'deleted_at',
			'hub_at',
			'id',
			'points',
			'program'
		]);
		hub.requests.length = 0;
		await readEstate(source(hub, db), ['points_balances']);
		expect(paths(hub)).toEqual(['/v1/cursor']);
	});

	it('re-reads a provenance slice only when provenance moves', async () => {
		const hub = fakeHub({
			accounts: [{ id: 'a' }],
			provenance: [
				{ id: 'e1', to_kind: 'asset_events', rel: 'evidence_of', to_ref: 'x', from_ref: 'k' },
				{ id: 'e2', to_kind: 'reward_events', rel: 'evidence_of', to_ref: 'y', from_ref: 'k' }
			]
		});
		const db = cache();
		const first = await readEstate(source(hub, db), ['accounts'], { slices: ['asset_evidence'] });
		expect(ids(first.rows.asset_evidence)).toEqual(['e1']);
		expect(hub.pulls().find((p) => p.table === 'provenance')).toMatchObject({
			since: '',
			where: { to_kind: 'asset_events', rel: 'evidence_of' }
		});
		// The large table itself is never copied.
		expect(hub.pulls().filter((p) => p.table === 'provenance')).toHaveLength(1);
		hub.requests.length = 0;
		expect(await readEstate(source(hub, db), ['accounts'], { slices: ['asset_evidence'] })).toEqual(
			first
		);
		expect(paths(hub)).toEqual(['/v1/cursor']);
		expect(hub.requests[0].body.tables).toContain('provenance');
		// The mark moves with the same count at it (two rows at each mark).
		hub.put('provenance', { id: 'e3', to_kind: 'asset_events', rel: 'evidence_of' }, at(5));
		hub.put('provenance', { id: 'z', to_kind: 'txns', rel: 'imported_from' }, at(5));
		const read = () => readEstate(source(hub, db), ['accounts'], { slices: ['asset_evidence'] });
		hub.requests.length = 0;
		const moved = await read();
		expect(ids(moved.rows.asset_evidence)).toEqual(['e1', 'e3']);
		expect(paths(hub)).toEqual(['/v1/cursor', '/v1/rows/pull']);
		// A commit on the same mark moves only the count.
		hub.put('provenance', { id: 'e4', to_kind: 'asset_events', rel: 'evidence_of' }, at(5));
		expect(ids((await read()).rows.asset_evidence)).toEqual(['e1', 'e3', 'e4']);
		// A changed slice definition re-reads it too.
		await db.prepare("UPDATE pull_state SET columns = '{}' WHERE tbl = 'asset_evidence'").run();
		hub.requests.length = 0;
		await read();
		expect(paths(hub)).toEqual(['/v1/cursor', '/v1/rows/pull']);
		// Another slice of the same table keeps its own mark.
		hub.requests.length = 0;
		const links = await readEstate(source(hub, db), ['accounts'], { slices: ['reward_links'] });
		expect(links.rows.reward_links).toEqual([]);
		hub.requests.length = 0;
		await readEstate(source(hub, db), ['accounts'], { slices: ['asset_evidence', 'reward_links'] });
		expect(paths(hub)).toEqual(['/v1/cursor']);
	});

	it('reads ledgers named by cached accounts in the same cursor request', async () => {
		const hub = fakeHub({
			accounts: [{ id: 'a', source: 'bank' }],
			txns_bank: [{ id: 't1' }],
			txns_card: [{ id: 't2' }]
		});
		const expand = (rows: Record<string, Record<string, unknown>[]>) =>
			(rows.accounts ?? []).map((a) => `txns_${a.source}`);
		const db = cache();
		const cold = await readEstate(source(hub, db), ['accounts'], { expand });
		expect(ids(cold.rows.txns_bank)).toEqual(['t1']);
		expect(paths(hub)).toEqual(['/v1/cursor', '/v1/rows/pull', '/v1/cursor', '/v1/rows/pull']);
		hub.requests.length = 0;
		expect(await readEstate(source(hub, db), ['accounts'], { expand })).toEqual(cold);
		expect(paths(hub)).toEqual(['/v1/cursor']);
		expect(hub.requests[0].body.tables).toEqual(['accounts', 'txns_bank']);
		// A new source joins in a second round; a dropped one leaves the result.
		hub.put('accounts', { id: 'a', source: 'card' }, at(4));
		hub.requests.length = 0;
		const moved = await readEstate(source(hub, db), ['accounts'], { expand });
		expect(Object.keys(moved.rows).sort()).toEqual(['accounts', 'txns_card']);
		expect(ids(moved.rows.txns_card)).toEqual(['t2']);
	});

	it('keeps the credential on the configured hub and fails closed on redirects', async () => {
		const hub = fakeHub({ accounts: [{ id: 'a' }] });
		await readEstate(source(hub), ['accounts'], { slices: ['asset_evidence'] });
		for (const { url, init } of hub.requests) {
			expect(url.startsWith('https://hub.example/v1/')).toBe(true);
			expect(init.redirect).toBe('manual');
			expect(init.signal).toBeInstanceOf(AbortSignal);
		}
		const redirect = async () =>
			new Response(null, { status: 302, headers: { location: 'https://other.example' } });
		await expect(readEstate({ ...source(hub), fetch: redirect }, ['accounts'])).rejects.toThrow();
		const slice = fakeHub({ accounts: [{ id: 'a' }] });
		const fetch = (async (url: string, init: RequestInit) =>
			JSON.parse(String(init.body)).where
				? redirect()
				: slice.fetch(url, init)) as typeof globalThis.fetch;
		await expect(
			readEstate({ ...source(slice), fetch }, ['accounts'], { slices: ['asset_evidence'] })
		).rejects.toThrow();
		for (const answer of [
			() => Response.json({ rows: [] }, { status: 500 }),
			() => Response.json({ rows: [{ id: 7 }] }),
			() => Response.json({ rows: [null] })
		]) {
			const failing = (async (url: string, init: RequestInit) =>
				JSON.parse(String(init.body)).where
					? answer()
					: slice.fetch(url, init)) as typeof globalThis.fetch;
			await expect(
				readEstate({ ...source(slice), fetch: failing }, ['accounts'], {
					slices: ['asset_evidence']
				})
			).rejects.toThrow();
		}
	});

	it('marks a read that walked pages incomplete, and a quiet read after it complete', async () => {
		// Two pages: one cursor request plus two batches.
		const hub = fakeHub(
			{
				accounts: Array.from({ length: 1001 }, (_, i) => ({ id: `a${String(i).padStart(4, '0')}` }))
			},
			{ batchRows: 1000 }
		);
		const db = cache();
		const walked = await readEstate(source(hub, db), ['accounts']);
		expect(paths(hub)).toEqual(['/v1/cursor', '/v1/rows/pull', '/v1/rows/pull']);
		expect(walked.rows.accounts).toHaveLength(1001);
		expect(walked.complete).toBe(false);
		const quiet = await readEstate(source(hub, db), ['accounts']);
		expect(quiet.rows.accounts).toHaveLength(1001);
		expect(quiet.complete).toBe(true);
	});

	it('takes the hub and only this server token from configuration', () => {
		const fetch = globalThis.fetch;
		const env = { SOMA_HUB_URL: 'https://hub.example/', SOMA_HUB_TOKEN: 'synthetic-token' };
		expect(estateSource({ fetch, platform: { env } as never })).toMatchObject({
			hub: 'https://hub.example',
			token: 'synthetic-token'
		});
		expect(
			estateSource({ fetch, platform: { env: { ...env, SOMA_HUB_TOKEN: '' } } as never })
		).toBeNull();
	});
});
