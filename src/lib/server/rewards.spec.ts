import { expect, it, vi } from 'vitest';
import { loadRewards, readRewardValues } from './rewards';
import { sqliteD1 } from './sqlite-d1';
import { fakeHub } from './fake-hub';
const rows: Record<string, Record<string, unknown>[]> = {
	reward_programs: [{ id: 'p', label: 'Example', provider: 'Example', account_id: 'card' }],
	reward_components: [
		{
			id: 'c',
			program_id: 'p',
			component_key: 'k',
			label: 'Points',
			unit: 'points',
			role: 'redeemable',
			currency: null
		}
	],
	reward_events: ['a', 'b'].map((id) => ({
		id,
		component_id: 'c',
		event_key: id,
		kind: 'earn',
		state: 'posted',
		event_date: '2030-01-02',
		occurred_at: null,
		posted_date: null,
		units_delta: '30',
		observed_at: '2030-01-03T00:00:00.000Z',
		supersedes_id: null
	})),
	points_balances: [],
	reward_terms: [],
	redemption_valuations: []
};
// Spend links are `txn -> reward_events` evidence edges in provenance.
const link = (id: string, from_ref: string, to_ref: string) => ({
	id,
	from_ref,
	to_ref,
	from_kind: 'txn',
	to_kind: 'reward_events',
	rel: 'evidence_of'
});
const hub = (edges: Record<string, unknown>[]) =>
	fakeHub({
		...rows,
		provenance: [...edges, { ...link('other', 'bank:t1', 'a'), rel: 'imported_from' }]
	});
const input = (fetch: typeof globalThis.fetch, estate = vi.fn()) => ({
	source: { hub: 'https://hub.example', token: 'synthetic', fetch },
	db: undefined,
	today: '2030-05-10',
	estate
});
it('reads every reward table and the links slice in one cursor round', async () => {
	const fake = hub([]);
	await loadRewards(input(fake.fetch));
	expect(fake.requests.filter((r) => r.path === '/v1/cursor')).toHaveLength(1);
	expect(fake.pulls().find((p) => p.table === 'provenance')?.where).toEqual({
		to_kind: 'reward_events',
		from_kind: 'txn',
		rel: 'evidence_of'
	});
});
it('uses links only for earn events', async () => {
	const saved = rows.reward_events;
	rows.reward_events = [];
	const estate = vi.fn();
	try {
		await loadRewards(input(hub([link('e1', 'bank:t1', 'a')]).fetch, estate));
	} finally {
		rows.reward_events = saved;
	}
	expect(estate).not.toHaveBeenCalled();
});
it('does not read the ledger when no spend is linked', async () => {
	const estate = vi.fn();
	const view = await loadRewards(input(hub([]).fetch, estate));
	expect(estate).not.toHaveBeenCalled();
	expect(view).toMatchObject({
		valuesUnavailable: true,
		typedUnavailable: false,
		today: '2030-05-10'
	});
	expect(view.programs[0].components[0].earningRate.status).toBe('unavailable');
});
it('turns cited ledger rows into proved spend and drops partly unresolved events', async () => {
	const estate = vi.fn(async () => ({
		accounts: [
			{ id: 'card', bank: 'b', name: 'Card', type: 'credit_card' as const, currency: 'USD' }
		],
		txns: [{ source: 'bank', source_id: 't1', account_id: 'card', date: '2030-01-02', amount: -20 }]
	}));
	const view = await loadRewards(
		input(
			hub([link('e1', 'bank:t1', 'a'), link('e2', 'bank:missing', 'b'), link('e3', 'bank:t1', 'b')])
				.fetch,
			estate
		)
	);
	expect(view.programs[0].components[0].earningRate).toMatchObject({
		status: 'available',
		rate: '1.5',
		earned: '30',
		spend: '20',
		events: 1
	});
});
it('reads owner values from the dashboard store only', async () => {
	const { db, sqlite } = sqliteD1('migrations/0002_reward_values.sql');
	sqlite.exec("INSERT INTO reward_values (program_id, value_per_unit) VALUES ('p', '0.015')");
	expect(await readRewardValues(db)).toEqual({
		values: [{ program_id: 'p', value_per_unit: '0.015', revision: 1 }],
		unavailable: false
	});
	expect(await readRewardValues(undefined)).toEqual({ values: [], unavailable: true });
	const view = await loadRewards({ ...input(hub([]).fetch), db });
	expect(view.programs[0].value).toEqual({ value_per_unit: '0.015', revision: 1 });
});
it('rates statement periods against the card ledger, leaving pending rows and payments out', async () => {
	const period = {
		...rows.reward_events[0],
		id: 'statement',
		event_key: 'statement',
		units_delta: '3',
		event_date: '2030-01-22',
		period_start: '2029-12-23',
		period_end_exclusive: '2030-01-23',
		details: JSON.stringify({ schema_version: 1, base_bonus: [] })
	};
	const txn = (id: string, amount: number, extra: Record<string, unknown> = {}) => ({
		id,
		account_id: 'card',
		date: '2030-01-05',
		posted_date: '2030-01-06',
		amount,
		name: 'SHOP',
		bank_category: null,
		status: 'Posted',
		...extra
	});
	const fake = fakeHub({
		...rows,
		reward_events: [period],
		provenance: [],
		accounts: [{ id: 'card', source: 'bank', currency: 'USD' }],
		overlay: [
			{ id: 'o1', source: 'bank', source_id: 'pay', category: 'Transfer', internal: 1 },
			{ id: 'o2', source: 'bank', source_id: 'moved', category: null, internal: 1 }
		],
		txns_bank: [
			txn('buy', -150),
			txn('pending', -999, { status: 'Pending' }),
			txn('pay', 500),
			txn('moved', -300),
			txn('fee', -2, { name: 'FOREIGN TRANSACTION FEE' }),
			txn('other-card', -999, { account_id: 'elsewhere' })
		]
	});
	const estate = vi.fn();
	const component = (await loadRewards(input(fake.fetch, estate))).programs[0].components[0];
	expect(estate).not.toHaveBeenCalled();
	expect(component.statements).toMatchObject({
		status: 'available',
		periods: [{ earned: '3', spend: '150', rate: '0.02' }]
	});
	expect(component.earningRate).toMatchObject({ basis: 'statements', rate: '0.02', spend: '150' });
	expect(fake.pulls().find((p) => p.table === 'txns_bank')?.columns).toEqual(
		expect.arrayContaining(['posted_date', 'name', 'bank_category', 'status'])
	);
});
it('says why when the card ledger cannot be read', async () => {
	const fake = fakeHub({
		...rows,
		reward_events: [
			{ ...rows.reward_events[0], period_start: '2029-12-23', period_end_exclusive: '2030-01-23' }
		],
		provenance: [],
		accounts: [{ id: 'card', source: 'BAD SOURCE', currency: 'USD' }],
		overlay: []
	});
	const component = (await loadRewards(input(fake.fetch))).programs[0].components[0];
	expect(component.statements).toMatchObject({
		status: 'unavailable',
		diagnostics: ['Card purchases could not be read. Try refreshing.']
	});
});
