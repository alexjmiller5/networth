import { expect, it, vi } from 'vitest';
import { loadRewards, readRewardValues } from './rewards';
import { sqliteD1 } from './sqlite-d1';
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
function hub(edges: Record<string, unknown>[]) {
	return vi.fn<typeof fetch>(async (_url, init) => {
		const body = JSON.parse(String(init?.body));
		if (body.table === 'provenance') {
			expect(body.where).toEqual({
				to_kind: 'reward_events',
				from_kind: 'txn',
				rel: 'evidence_of'
			});
			return Response.json({ rows: edges });
		}
		return Response.json({ rows: rows[body.table] ?? [] });
	});
}
const input = (fetch: typeof globalThis.fetch, estate = vi.fn()) => ({
	hub: 'https://hub.example',
	token: 'synthetic',
	fetch,
	db: undefined,
	today: '2030-05-10',
	estate
});
it('reads links and valuations only when earn or redeem events exist', async () => {
	const fetch = hub([]);
	const saved = rows.reward_events;
	rows.reward_events = [];
	try {
		await loadRewards(input(fetch));
	} finally {
		rows.reward_events = saved;
	}
	const tables = fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).table);
	expect(tables.sort()).toEqual([
		'points_balances',
		'reward_components',
		'reward_events',
		'reward_programs',
		'reward_terms'
	]);
});
it('does not read the ledger when no spend is linked', async () => {
	const estate = vi.fn();
	const view = await loadRewards(input(hub([]), estate));
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
			hub([
				{ id: 'e1', from_ref: 'bank:t1', to_ref: 'a', deleted_at: null },
				{ id: 'e2', from_ref: 'bank:missing', to_ref: 'b', deleted_at: null },
				{ id: 'e3', from_ref: 'bank:t1', to_ref: 'b', deleted_at: null }
			]),
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
	const view = await loadRewards({ ...input(hub([])), db });
	expect(view.programs[0].value).toEqual({ value_per_unit: '0.015', revision: 1 });
});
