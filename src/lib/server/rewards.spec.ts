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
