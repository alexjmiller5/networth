import { describe, expect, it, vi } from 'vitest';
import { sqliteD1 } from './sqlite-d1';
import { readMappings, readPrices, refreshPrices, valueEstate } from './prices';
import type { Estate } from '$lib/finance/assemble';

const now = () => new Date('2026-01-09T23:00:00.000Z');
const tiingoRow = (date: string, close: number, splitFactor = 1) => ({
	date: `${date}T00:00:00.000Z`,
	close,
	adjClose: close / 2,
	splitFactor
});
function store() {
	const { db, sqlite } = sqliteD1('migrations-prices/0001_prices.sql');
	sqlite.exec(`INSERT INTO price_mappings (account_id, security_id, provider, symbol) VALUES
		('b', 'VUG', 'tiingo', 'VUG'), ('r', 'VUG', 'tiingo', 'VUG'), ('p', 'TF0Q', 'netbenefits', NULL)`);
	return { db, sqlite };
}

describe('price cache', () => {
	it('backfills a new series once, then refetches only an overlapping recent window', async () => {
		const { db, sqlite } = store();
		const fetcher = vi.fn<typeof fetch>(async () =>
			Response.json([tiingoRow('2026-01-07', 480), tiingoRow('2026-01-08', 80, 6)])
		);
		const first = await refreshPrices(db, { tiingo: 'key' }, { fetcher, now });
		// One request per series even when two accounts map to it; NetBenefits is never fetched.
		expect(fetcher).toHaveBeenCalledOnce();
		expect(new URL(String(fetcher.mock.calls[0][0])).searchParams.get('startDate')).toBe(
			'1970-01-01'
		);
		expect(first).toEqual([
			{ provider: 'tiingo', symbol: 'VUG', status: 'available', rows: 2, from: '1970-01-01' }
		]);
		expect(
			sqlite.prepare('SELECT date, close, split_factor, basis FROM price_closes').all()
		).toEqual([
			{ date: '2026-01-07', close: '480', split_factor: null, basis: 'raw-close' },
			{ date: '2026-01-08', close: '80', split_factor: '6', basis: 'raw-close' }
		]);
		await refreshPrices(db, { tiingo: 'key' }, { fetcher, now });
		expect(new URL(String(fetcher.mock.calls[1][0])).searchParams.get('startDate')).toBe(
			'2025-12-29'
		);
		expect(sqlite.prepare('SELECT count(*) AS n FROM price_closes').get()).toEqual({ n: 2 });
	});

	it('keeps cached closes when the provider fails, and accepts provider corrections', async () => {
		const { db, sqlite } = store();
		await refreshPrices(
			db,
			{ tiingo: 'key' },
			{
				fetcher: async () => Response.json([tiingoRow('2026-01-08', 80)]),
				now
			}
		);
		const failed = await refreshPrices(
			db,
			{ tiingo: 'key' },
			{
				fetcher: async () => Response.json({ detail: 'Error' }),
				now
			}
		);
		expect(failed[0]).toMatchObject({ status: 'unavailable', rows: 0 });
		expect(sqlite.prepare('SELECT close FROM price_closes').all()).toEqual([{ close: '80' }]);
		await refreshPrices(
			db,
			{ tiingo: 'key' },
			{
				fetcher: async () => Response.json([tiingoRow('2026-01-08', 80.5)]),
				now
			}
		);
		expect(sqlite.prepare('SELECT close FROM price_closes').all()).toEqual([{ close: '80.5' }]);
		expect((await refreshPrices(db, {}, { fetcher: vi.fn<typeof fetch>(), now }))[0]).toMatchObject(
			{ status: 'unavailable', detail: 'A caller-supplied server API key is required.' }
		);
	});

	it('reads mapped series from a date with split factors, and the mappings as data', async () => {
		const { db } = store();
		await refreshPrices(
			db,
			{ tiingo: 'key' },
			{
				fetcher: async () =>
					Response.json([tiingoRow('2026-01-05', 470), tiingoRow('2026-01-08', 80, 6)]),
				now
			}
		);
		const mappings = await readMappings(db);
		expect(mappings.map((m) => `${m.account_id}:${m.security_id}:${m.provider}`)).toEqual([
			'b:VUG:tiingo',
			'p:TF0Q:netbenefits',
			'r:VUG:tiingo'
		]);
		expect(await readPrices(db, mappings, '2026-01-06')).toEqual(
			new Map([['tiingo:VUG', [{ date: '2026-01-08', price: 80, split: 6 }]]])
		);
	});

	it('rejects mappings the schema cannot value', () => {
		const { sqlite } = store();
		for (const values of [
			"('x', 'A', 'tiingo', NULL)",
			"('x', 'A', 'netbenefits', 'A')",
			"('x', 'A', 'stooq', 'A')"
		])
			expect(() =>
				sqlite.exec(
					`INSERT INTO price_mappings (account_id, security_id, provider, symbol) VALUES ${values}`
				)
			).toThrow();
	});
});

describe('NetBenefits NAVs', () => {
	const estate = {
		accounts: [{ id: 'p', bank: 'Plan', name: '401(k)', type: '401k' }],
		txns: [{ account_id: 'p', date: '2026-01-05', amount: 100, qty: 2, ticker: 'TF0Q' }],
		coverage: [
			{
				account_id: 'p',
				status: 'investment-unvalued',
				basis: 'units',
				asOf: null,
				firstTransaction: null,
				lastTransaction: null,
				transactionCount: 1,
				reasons: []
			}
		]
	} as unknown as Estate;
	const nav = (instrument_id: string, exact_amount: string, source_date = '2026-01-05') => ({
		instrument_id,
		metric: 'unit_price',
		price_kind: 'nav',
		currency: 'USD',
		value_status: 'reported',
		exact_amount,
		source_date
	});
	const instruments = [
		{ id: 'i1', account_id: 'p', native_security_id: 'TF0Q' },
		{ id: 'i2', account_id: 'other', native_security_id: 'TF0Q' }
	];

	it('values a plan fund from its own source-dated NAV and drops conflicting NAVs for a date', async () => {
		const { db, sqlite } = sqliteD1('migrations-prices/0001_prices.sql');
		sqlite.exec(
			"INSERT INTO price_mappings (account_id, security_id, provider, symbol) VALUES ('p', 'TF0Q', 'netbenefits', NULL)"
		);
		const one = await valueEstate(
			estate,
			db,
			instruments,
			[nav('i1', '50'), nav('i2', '99')],
			'2026-01-05'
		);
		expect(one.valuations![0].values).toEqual([100]);
		const conflict = await valueEstate(
			estate,
			db,
			instruments,
			[nav('i1', '50'), nav('i1', '51')],
			'2026-01-05'
		);
		expect(conflict.valuations![0].values).toEqual([null]);
		expect(conflict.coverage[0].status).toBe('investment-unvalued');
	});
});
