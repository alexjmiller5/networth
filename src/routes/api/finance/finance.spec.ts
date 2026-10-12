import { describe, expect, it, vi } from 'vitest';
import { GET } from './+server';
import type { Estate } from '$lib/finance/assemble';
import { sqliteD1 } from '$lib/server/sqlite-d1';
import { fakeHub } from '$lib/server/fake-hub';
import { TXN_COLUMNS } from '$lib/server/estate';

const environment = { SOMA_HUB_URL: 'https://hub.example', SOMA_HUB_TOKEN: 'test-read-token' };
const event = (fetch: typeof globalThis.fetch, env: object = environment) =>
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
			expect(url.startsWith(`${environment.SOMA_HUB_URL}/v1/`)).toBe(true);
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
		const response = await GET(event(fakeHub().fetch));
		expect(response.headers.get('cache-control')).toBe('private, no-store');
		expect(await response.text()).not.toContain(environment.SOMA_HUB_TOKEN);
	});
});

it('never queries a retired source table even when its retained registry history exists', async () => {
	const hub = fakeHub({
		accounts: [{ id: 'retired-account', source: 'retired', deleted_at: '2030-01-01T00:00:00.000Z' }]
	});
	const response = await GET(event(hub.fetch));
	expect(response.status).toBe(200);
	expect(hub.requests.flatMap((r) => (r.body.tables as string[]) ?? [])).not.toContain(
		'txns_retired'
	);
	expect(hub.pulls().map((p) => p.table)).not.toContain('txns_retired');
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

it('assembles every page of every source ledger with fixed ledger columns', async () => {
	const hub = fakeHub(
		{
			accounts: [account('account-1'), account('account-2', 'second')],
			txns_bank: Array.from({ length: 30 }, (_, i) => transaction(`txn-${i}`, i)),
			txns_second: []
		},
		{ batchRows: 26 }
	);
	const estate = (await (await GET(event(hub.fetch))).json()) as Estate;
	expect(estate.accounts.map((row) => row.id)).toEqual(['account-1', 'account-2']);
	expect(estate.txns.map((row) => row.amount).sort((a, b) => a - b)).toEqual(
		Array.from({ length: 30 }, (_, i) => i)
	);
	const ledger = hub.pulls().filter((p) => p.table === 'txns_bank');
	expect(ledger.length).toBeGreaterThan(1);
	for (const page of ledger) expect(page.columns).toEqual([...TXN_COLUMNS, 'hub_at']);
	expect(hub.pulls().some((p) => p.table === 'txns_second')).toBe(true);
});

it('loads a large ledger without one request per table or small page', async () => {
	const hub = fakeHub({
		accounts: [account('account-1')],
		txns_bank: Array.from({ length: 1001 }, (_, i) => transaction(`txn-${i}`, 1))
	});
	const data = (await (await GET(event(hub.fetch))).json()) as Estate;
	expect(data.txns).toHaveLength(1001);
	// Two cursor rounds (the estate, then the ledgers it names) and the evidence slice.
	expect(hub.requests).toHaveLength(5);
});

it('serves a quiet reload from its own cache with one hub request', async () => {
	const hub = fakeHub({
		accounts: [account('account-1')],
		txns_bank: [transaction('txn-1', 10)]
	});
	const env = {
		...environment,
		ESTATE_CACHE_DB: sqliteD1('migrations-estate-cache/0001_estate_cache.sql').db
	};
	const first = await (await GET(event(hub.fetch, env))).json();
	hub.requests.length = 0;
	expect(await (await GET(event(hub.fetch, env))).json()).toEqual(first);
	expect(hub.requests.map((r) => r.path)).toEqual(['/v1/cursor']);
});

it('reads asset evidence as a filtered provenance slice and never returns evidence keys', async () => {
	const hub = fakeHub({
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
		provenance: [
			{
				to_kind: 'asset_events',
				rel: 'evidence_of',
				to_ref: 'e1',
				from_kind: 'takeout',
				from_ref: 'raw/secret-evidence-key'
			}
		]
	});
	const response = await GET(event(hub.fetch));
	const text = await response.text();
	expect(text).not.toContain('secret-evidence-key');
	const estate = JSON.parse(text) as Estate;
	expect(estate.assets.map((a) => a.id)).toEqual(['asset-1']);
	expect(estate.txns.filter((t) => t.account_id === 'asset-1').map((t) => t.amount)).toEqual([25]);
	expect(hub.pulls().find((p) => p.table === 'provenance')?.where).toEqual({
		to_kind: 'asset_events',
		rel: 'evidence_of'
	});
});

it('returns a categorized redemption as points-paid spending outside every account', async () => {
	const hub = fakeHub({
		accounts: [account('account-1')],
		categories: [{ id: 'dining', name: 'Dining', kind: 'spending', icon: 'tabler:x', sort: 1 }],
		reward_components: [{ id: 'rc', unit: 'points' }],
		reward_events: [
			{ id: 're', component_id: 'rc', kind: 'redeem', state: 'posted', event_date: '2030-01-15' }
		],
		redemption_valuations: [
			{ id: 'rv', event_id: 're', currency: 'USD', reward_value: '43.21', category: 'Dining' }
		]
	});
	const estate = (await (await GET(event(hub.fetch))).json()) as Estate;
	expect(estate.txns.filter((t) => t.fundedBy)).toEqual([
		expect.objectContaining({
			source: 'rewards',
			account_id: null,
			date: '2030-01-15',
			amount: -43.21,
			balanceAmount: null,
			category: 'Dining',
			fundedBy: 'points'
		})
	]);
});

describe('investment valuation', () => {
	const hub = (
		instrumentRows: Record<string, unknown>[] = [],
		observationRows: Record<string, unknown>[] = []
	) =>
		fakeHub({
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
		}).fetch;
	const prices = () => {
		const { db, sqlite } = sqliteD1('migrations-prices/0001_prices.sql');
		sqlite.exec(`INSERT INTO price_mappings (account_id, security_id, provider, symbol) VALUES ('broker', 'VUG', 'tiingo', 'VUG');
			INSERT INTO price_closes VALUES ('tiingo', 'VUG', '2026-01-05', '100', 'USD', 'raw-close', NULL, 'x'),
			('tiingo', 'VUG', '2026-01-06', '110.5', 'USD', 'raw-close', NULL, 'x')`);
		return db;
	};

	it('returns the cached-price valuation and verifies the account as of its price date', async () => {
		vi.useFakeTimers({ now: new Date('2026-01-06T20:00:00.000Z'), toFake: ['Date'] });
		const response = await GET(event(hub(), { ...environment, PRICES_DB: prices() }));
		vi.useRealTimers();
		const estate = (await response.json()) as Estate;
		expect(estate.valuations).toEqual([
			{
				account_id: 'broker',
				start: '2026-01-05',
				end: '2026-01-06',
				values: [700, 721],
				priceDates: ['2026-01-05', '2026-01-06'],
				carried: [false, false],
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
				{ ...environment, PRICES_DB: prices() }
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

	it('still serves the estate when the native observations cannot be read', async () => {
		const estateOnly = hub();
		const fetch = (async (url: string, init: RequestInit) => {
			const body = JSON.parse(String(init.body));
			const tables = [
				...(body.tables ?? []),
				...(body.batch ?? []).map((p: { table: string }) => p.table)
			];
			return tables.includes('investment_observations')
				? new Response('unavailable', { status: 500 })
				: estateOnly(url, init);
		}) as typeof globalThis.fetch;
		const estate = (await (
			await GET(event(fetch, { ...environment, PRICES_DB: prices() }))
		).json()) as Estate;
		expect(estate.accounts.map((a) => a.id)).toEqual(['broker']);
		expect(estate.valuations).toBeUndefined();
	});
});
