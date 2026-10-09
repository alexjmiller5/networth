import { describe, expect, it, vi } from 'vitest';
import { GET } from './+server';
import type { Estate } from '$lib/finance/assemble';
import { sqliteD1 } from '$lib/server/sqlite-d1';

const environment = { SOMA_HUB_URL: 'https://hub.example', SOMA_HUB_TOKEN: 'test-read-token' };
const event = (fetch: typeof globalThis.fetch, env = environment) =>
	({ fetch, platform: { env } }) as unknown as Parameters<typeof GET>[0];

describe('finance endpoint', () => {
	it('requires the configured hub and token before making requests', async () => {
		const fetch = vi.fn();
		await expect(GET(event(fetch, { ...environment, SOMA_HUB_TOKEN: '' }))).rejects.toMatchObject({
			status: 503
		});
		await expect(GET(event(fetch, { ...environment, SOMA_HUB_URL: '' }))).rejects.toMatchObject({
			status: 503
		});
		expect(fetch).not.toHaveBeenCalled();
	});

	it('rejects malformed upstream data instead of returning a successful empty estate', async () => {
		const fetch = vi.fn(async () => new Response(JSON.stringify({ unexpected: [] })));
		await expect(GET(event(fetch))).rejects.toMatchObject({ status: 502 });
	});

	it('rejects redirects without forwarding the hub credential', async () => {
		const fetch = vi.fn(
			async () =>
				new Response(null, { status: 302, headers: { location: 'https://other.example' } })
		);
		await expect(GET(event(fetch))).rejects.toMatchObject({ status: 502 });
		for (const [url, init] of fetch.mock.calls as unknown as [string, RequestInit][]) {
			expect(url).toBe(`${environment.SOMA_HUB_URL}/v1/rows/pull`);
			expect(init.redirect).toBe('manual');
		}
	});

	it('contains network and upstream errors without revealing their bodies', async () => {
		const fetch = vi.fn().mockRejectedValue(new Error('internal credential-bearing error'));
		await expect(GET(event(fetch))).rejects.toMatchObject({
			status: 502,
			body: { message: 'Finance data could not be loaded. Try refreshing.' }
		});
	});

	it('keeps the response private and does not expose the hub credential', async () => {
		const fetch = vi.fn(async () => new Response(JSON.stringify({ rows: [] })));
		const response = await GET(event(fetch));
		expect(response.headers.get('cache-control')).toBe('private, no-store');
		expect(await response.text()).not.toContain(environment.SOMA_HUB_TOKEN);
	});
});

it('never queries a retired source table even when its retained registry history exists', async () => {
	const requested: string[] = [];
	const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
		const { table } = JSON.parse(String(init?.body));
		requested.push(table);
		if (table === 'txns_retired') throw new Error('retired source must not be queried');
		const rows =
			table === 'accounts'
				? [{ id: 'retired-account', source: 'retired', deleted_at: '2030-01-01T00:00:00.000Z' }]
				: [];
		return Response.json({ rows });
	});
	const response = await GET(event(fetch));
	expect(response.status).toBe(200);
	expect(requested).not.toContain('txns_retired');
	expect(await response.json()).toMatchObject({ accounts: [] });
});

const account = (id: string, source = 'bank') => ({
	id,
	bank: 'Example Bank',
	name: id,
	type: 'checking',
	source,
	currency: 'USD'
});
const transaction = (id: string, amount: number) => ({
	id,
	account_id: 'account-1',
	date: '2026-01-05',
	amount,
	status: 'posted'
});

it('loads only open card ledgers for widgets, so unrelated source failures cannot block refresh', async () => {
	const requested: string[] = [];
	const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
		const { table } = JSON.parse(String(init?.body));
		requested.push(table);
		const rows =
			table === 'accounts'
				? [
						{ ...account('card'), type: 'credit_card' },
						account('checking'),
						{ ...account('closed'), type: 'credit_card', is_closed: 1 },
						account('wallet', 'slow')
					]
				: table === 'scrape_runs'
					? [
							{
								source: 'bank',
								status: 'ok',
								reconciled: 1,
								finished_at: '2026-01-06T00:00:00.000Z',
								stated_balances: { card: -12 }
							}
						]
					: table === 'txns_bank'
						? [
								{ ...transaction('purchase', -12), account_id: 'card' },
								{ ...transaction('other', 100), account_id: 'checking' }
							]
						: null;
		if (rows === null) throw new Error('Unrelated source unavailable');
		return Response.json({ rows });
	});
	const response = await GET(event(fetch), true);
	const estate = (await response.json()) as Estate;
	expect(requested.sort()).toEqual([
		'accounts',
		'categories',
		'overlay',
		'scrape_runs',
		'shares',
		'txns_bank'
	]);
	expect(estate).toMatchObject({ categoriesUnavailable: true });
	expect(estate.accounts.map((a) => a.id)).toEqual(['card']);
	expect(estate.txns.map((t) => t.source_id)).toEqual(['purchase']);
	expect(estate.coverage).toMatchObject([{ account_id: 'card', status: 'verified' }]);
});

describe('hub pagination', () => {
	it('assembles all account and transaction pages using the same allowlisted request and destination', async () => {
		const requests: Record<string, unknown>[] = [];
		const fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
			expect(url).toBe('https://hub.example/v1/rows/pull');
			expect(init?.redirect).toBe('manual');
			expect(init?.headers).toEqual({
				'content-type': 'application/json',
				authorization: 'Bearer test-read-token'
			});
			const body = JSON.parse(String(init?.body));
			expect(body.since).toBe('');
			expect(body.limit).toBe(body.after ? 200 : undefined);
			requests.push(body);
			if (body.table === 'accounts') {
				if (!body.after)
					return Response.json({ rows: [account('account-1')], next_cursor: 'account-1' });
				expect(body.after).toBe('account-1');
				return Response.json({ rows: [account('account-2', 'second')], next_cursor: null });
			}
			if (body.table === 'txns_bank') {
				if (!body.after)
					return Response.json({ rows: [transaction('txn-1', 10)], next_cursor: 'txn-1' });
				if (body.after === 'txn-1')
					return Response.json({ rows: [transaction('txn-2', -3)], next_cursor: 'txn-2' });
				expect(body.after).toBe('txn-2');
				return Response.json({ rows: [transaction('txn-3', 2)], next_cursor: null });
			}
			return Response.json({ rows: [] });
		});
		const response = await GET(event(fetch));
		const estate = (await response.json()) as Estate;
		expect(estate.accounts.map((row: { id: string }) => row.id)).toEqual([
			'account-1',
			'account-2'
		]);
		expect(estate.txns.map((row: { amount: number }) => row.amount)).toEqual([10, -3, 2]);
		const bodies = requests;
		expect(bodies.some((body) => body.table === 'txns_second')).toBe(true);
		for (const table of ['accounts', 'txns_bank']) {
			const pages = bodies.filter((body) => body.table === table);
			for (const page of pages) expect(page.columns).toEqual(pages[0].columns);
		}
		expect(bodies.find((body) => body.table === 'txns_bank')?.columns).toEqual([
			'id',
			'account_id',
			'date',
			'amount',
			'status',
			'synthetic',
			'qty',
			'ticker',
			'deleted_at'
		]);
	});

	it.each([
		['non-string', { rows: [account('account-2')], next_cursor: 4 }],
		['empty cursor', { rows: [account('account-2')], next_cursor: '' }],
		['repeated cursor', { rows: [account('account-2')], next_cursor: 'cursor-2' }],
		['backward cursor', { rows: [account('account-2')], next_cursor: 'cursor-1' }],
		['empty continuing page', { rows: [], next_cursor: 'cursor-3' }],
		['missing rows', { next_cursor: null }],
		['malformed row', { rows: [null], next_cursor: null }]
	])('rejects the entire response for a %s after a valid first page', async (_label, badPage) => {
		let calls = 0;
		const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
			const { table } = JSON.parse(String(init?.body));
			if (table !== 'accounts') return Response.json({ rows: [] });
			calls++;
			if (calls === 1)
				return Response.json({ rows: [account('account-1')], next_cursor: 'cursor-2' });
			if (calls > 2) throw new Error('pagination should already have stopped');
			return Response.json(badPage);
		});
		await expect(GET(event(fetch))).rejects.toMatchObject({
			status: 502,
			body: { message: 'Finance data could not be loaded. Try refreshing.' }
		});
		expect(calls).toBe(2);
	});

	it('rejects later-page redirects without following a cursor as a URL', async () => {
		let calls = 0;
		const fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
			expect(url).toBe('https://hub.example/v1/rows/pull');
			expect(init?.redirect).toBe('manual');
			const body = JSON.parse(String(init?.body));
			if (body.table !== 'accounts') return Response.json({ rows: [] });
			calls++;
			if (calls === 1)
				return Response.json({
					rows: [account('account-1')],
					next_cursor: 'https://other.example/credential-trap'
				});
			expect(body.after).toBe('https://other.example/credential-trap');
			return new Response(null, { status: 302, headers: { location: 'https://other.example' } });
		});
		await expect(GET(event(fetch))).rejects.toMatchObject({ status: 502 });
		expect(calls).toBe(2);
	});

	it('accepts an empty terminal page and legacy complete responses', async () => {
		let calls = 0;
		const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body));
			if (body.table !== 'accounts') return Response.json({ rows: [] });
			calls++;
			return Response.json(
				body.after
					? { rows: [], next_cursor: null }
					: { rows: [account('account-1')], next_cursor: 'cursor-1' }
			);
		});
		expect(await (await GET(event(fetch))).json()).toMatchObject({
			accounts: [{ id: 'account-1' }]
		});
		expect(calls).toBe(2);
	});
});

// The hub supports complete-table responses when limit is omitted. Splitting a
// cold read into many serial pages can exceed both endpoint and browser deadlines.
it('loads a large complete table without forcing serial small-page round trips', async () => {
	const requests: string[] = [];
	const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body));
		requests.push(body.table);
		expect(body.limit).toBeUndefined();
		if (body.table === 'accounts') return Response.json({ rows: [account('account-1')] });
		if (body.table === 'txns_bank')
			return Response.json({
				rows: Array.from({ length: 1001 }, (_, i) => transaction(`txn-${i}`, 1))
			});
		return Response.json({ rows: [] });
	});
	const data = (await (await GET(event(fetch))).json()) as Estate;
	expect(data.txns).toHaveLength(1001);
	expect(requests.filter((table) => table === 'txns_bank')).toHaveLength(1);
});

it('reads asset evidence as a filtered provenance slice and never returns evidence keys', async () => {
	const bodies: Record<string, unknown>[] = [];
	const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body));
		bodies.push(body);
		const rows: Record<string, unknown[]> = {
			accounts: [account('account-1')],
			txns_bank: [transaction('leg', -25)],
			assets: [{ id: 'asset-1', kind: 'security_deposit', name: 'Deposit', currency: 'USD' }],
			asset_events: [
				{
					id: 'e1',
					asset_id: 'asset-1',
					kind: 'fund',
					date: '2026-01-05',
					amount: 2500,
					source: 'bank',
					source_id: 'leg',
					share_id: null
				}
			],
			provenance: [{ to_ref: 'e1', from_kind: 'takeout', from_ref: 'raw/secret-evidence-key' }]
		};
		return Response.json({ rows: rows[body.table] ?? [] });
	});
	const response = await GET(event(fetch));
	const text = await response.text();
	expect(text).not.toContain('secret-evidence-key');
	const estate = JSON.parse(text) as Estate;
	expect(estate.assets.map((a) => a.id)).toEqual(['asset-1']);
	expect(estate.txns.filter((t) => t.account_id === 'asset-1').map((t) => t.amount)).toEqual([25]);
	expect(bodies.find((b) => b.table === 'provenance')?.where).toEqual({
		to_kind: 'asset_events',
		rel: 'evidence_of'
	});
	const widgets: string[] = [];
	await GET(
		event(
			vi.fn(async (_url: unknown, init?: RequestInit) => {
				widgets.push(JSON.parse(String(init?.body)).table);
				return Response.json({ rows: [] });
			})
		),
		true
	);
	// Widgets read card categories (best-effort, for guidance) but never assets or evidence.
	expect(widgets.sort()).toEqual(['accounts', 'categories', 'overlay', 'scrape_runs', 'shares']);
});

it('returns a categorized redemption as points-paid spending outside every account', async () => {
	const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
		const rows: Record<string, unknown[]> = {
			accounts: [account('account-1')],
			categories: [{ id: 'dining', name: 'Dining', kind: 'spending', icon: 'tabler:x', sort: 1 }],
			reward_components: [{ id: 'rc', unit: 'points' }],
			reward_events: [
				{ id: 're', component_id: 'rc', kind: 'redeem', state: 'posted', event_date: '2026-08-27' }
			],
			redemption_valuations: [
				{ id: 'rv', event_id: 're', currency: 'USD', reward_value: '65.66', category: 'Dining' }
			]
		};
		return Response.json({ rows: rows[JSON.parse(String(init?.body)).table] ?? [] });
	});
	const estate = (await (await GET(event(fetch))).json()) as Estate;
	expect(estate.txns.filter((t) => t.fundedBy)).toEqual([
		expect.objectContaining({
			source: 'rewards',
			account_id: null,
			date: '2026-08-27',
			amount: -65.66,
			balanceAmount: null,
			category: 'Dining',
			fundedBy: 'points'
		})
	]);
});

describe('investment valuation', () => {
	const hub = (instrumentRows: unknown[] = [], observationRows: unknown[] = []) =>
		vi.fn(async (_url: unknown, init?: RequestInit) => {
			const { table } = JSON.parse(String(init?.body));
			const rows: Record<string, unknown[]> = {
				accounts: [{ ...account('broker', 'brokersrc'), type: 'brokerage' }],
				scrape_runs: [
					{
						source: 'brokersrc',
						status: 'ok',
						reconciled: 1,
						finished_at: '2026-01-06T00:00:00.000Z',
						stated_balances: { broker: 500, units: { broker: { VUG: 2 } } }
					}
				],
				txns_brokersrc: [
					{ ...transaction('deposit', 700), account_id: 'broker' },
					{ ...transaction('buy', -200), account_id: 'broker', qty: 2, ticker: 'VUG' }
				],
				investment_instruments: instrumentRows,
				investment_observations: observationRows
			};
			return Response.json({ rows: rows[table] ?? [] });
		});
	const prices = () => {
		const { db, sqlite } = sqliteD1('migrations-prices/0001_prices.sql');
		sqlite.exec(`INSERT INTO price_mappings (account_id, security_id, provider, symbol) VALUES ('broker', 'VUG', 'tiingo', 'VUG');
			INSERT INTO price_closes VALUES ('tiingo', 'VUG', '2026-01-05', '100', 'USD', 'raw-close', NULL, 'x'),
			('tiingo', 'VUG', '2026-01-06', '110.5', 'USD', 'raw-close', NULL, 'x')`);
		return db;
	};

	it('returns the cached-price valuation and verifies the account as of its price date', async () => {
		vi.useFakeTimers({ now: new Date('2026-01-06T20:00:00.000Z'), toFake: ['Date'] });
		const response = await GET(event(hub(), { ...environment, PRICES_DB: prices() } as never));
		vi.useRealTimers();
		const estate = (await response.json()) as Estate;
		expect(estate.valuations).toEqual([
			{
				account_id: 'broker',
				start: '2026-01-05',
				end: '2026-01-06',
				values: [700, 721],
				priceDates: ['2026-01-05', '2026-01-06'],
				gaps: []
			}
		]);
		expect(estate.coverage).toMatchObject([
			{ account_id: 'broker', status: 'verified', valuedAsOf: '2026-01-06', reasons: [] }
		]);
	});

	it('cross-checks observed units within the same instrument scope only', async () => {
		vi.useFakeTimers({ now: new Date('2026-01-06T20:00:00.000Z'), toFake: ['Date'] });
		const response = await GET(
			event(
				hub(
					[{ id: 'i1', account_id: 'broker', native_security_id: 'VUG' }],
					[
						{
							instrument_id: 'i1',
							metric: 'position_units',
							exact_amount: '3',
							value_status: 'reported',
							time_basis: 'observation_only',
							captured_at: '2026-01-06T06:00:00.000Z'
						}
					]
				),
				{ ...environment, PRICES_DB: prices() } as never
			)
		);
		vi.useRealTimers();
		const estate = (await response.json()) as Estate;
		expect(estate.valuations![0].values).toEqual([null, null]);
		expect(estate.coverage[0]).toMatchObject({
			status: 'investment-unvalued',
			reasons: [
				'Unavailable on 2026-01-06: Ledger units for VUG differ from the holdings observed on 2026-01-06',
				'No valued day yet'
			]
		});
	});

	it('keeps investments explicitly unvalued when the cache is missing', async () => {
		const response = await GET(event(hub()));
		const estate = (await response.json()) as Estate;
		expect(estate.valuations).toBeUndefined();
		expect(estate.coverage[0]).toMatchObject({ status: 'investment-unvalued' });
	});
});
