import { expect, it } from 'vitest';
import { assembleRewards, type RewardRow } from './rewards';
const program = { id: 'program', label: 'Example rewards', provider: 'Example', account_id: null };
const component = {
	id: 'points',
	program_id: 'program',
	component_key: 'points',
	label: 'Redeemable points',
	unit: 'points',
	role: 'redeemable',
	currency: null
};
const event = (patch: RewardRow = {}) => ({
	id: 'earn',
	component_id: 'points',
	event_key: 'earned-1',
	kind: 'earn',
	state: 'posted',
	event_date: '2030-01-02',
	occurred_at: null,
	posted_date: null,
	units_delta: '0.1',
	observed_at: '2030-01-03T00:00:00.000Z',
	details: { schema_version: 1 },
	supersedes_id: null,
	...patch
});
const snapshot = (patch: RewardRow = {}) => ({
	id: 'balance',
	program: 'Legacy label',
	points: 100,
	est_value: null,
	scraped_at: '2030-01-03T00:00:00.000Z',
	component_id: 'points',
	exact_amount: '100',
	basis: 'available',
	source_date: '2030-01-02',
	source_as_of: null,
	period_start: null,
	period_end_exclusive: null,
	supersedes_id: null,
	...patch
});
const run = (
	events: RewardRow[] = [],
	snapshots: RewardRow[] = [],
	complete = true,
	components: RewardRow[] = [component]
) => assembleRewards([program], components, events, snapshots, { complete });
it('sums only known posted event heads with exact decimal arithmetic', () => {
	const view = run(
		[
			event(),
			event({ id: 'two', event_key: 'earned-2', units_delta: '0.2' }),
			event({ id: 'spend', event_key: 'redeemed', kind: 'redeem', units_delta: '-2' })
		],
		[snapshot()]
	);
	expect(view.programs[0].components[0]).toMatchObject({
		earned: '0.3',
		redeemed: '2',
		balanceGroups: [{ selected: { exact_amount: '100' } }]
	});
	expect(view.programs[0]).not.toHaveProperty('total');
});
it('never derives earning or cashback from balance differences', () => {
	const view = run(
		[],
		[
			snapshot(),
			snapshot({ id: 'new', exact_amount: '150', points: 150, source_date: '2030-01-03' })
		]
	);
	expect(view.programs[0].components[0]).toMatchObject({ earned: null, redeemed: null });
});
it('keeps pending earnings and available balance separate', () => {
	expect(
		run([event({ state: 'pending', units_delta: '10' })], [snapshot()]).programs[0].components[0]
	).toMatchObject({ earned: null, pendingEarned: '10', redeemed: null });
});
it('counts one explicit pending-to-posted correction', () => {
	const result = run([
		event({ state: 'pending' }),
		event({ id: 'posted', supersedes_id: 'earn', state: 'posted' })
	]);
	expect(result.programs[0].components[0]).toMatchObject({ earned: '0.1', pendingEarned: null });
});
it.each(['fork', 'incomplete', 'unknown amount'])('withholds event totals on %s', (reason) => {
	const rows =
		reason === 'fork'
			? [
					event(),
					event({ id: 'a', supersedes_id: 'earn' }),
					event({ id: 'b', supersedes_id: 'earn' })
				]
			: [event(reason === 'unknown amount' ? { units_delta: null } : {})];
	const result = run(rows, [], reason !== 'incomplete').programs[0].components[0];
	expect(result.earned).toBeNull();
	expect(result.diagnostics.length).toBeGreaterThan(0);
});
it('keeps legacy untyped snapshots visible without guessing units from their program label', () => {
	const result = run(
		[],
		[
			{
				id: 'legacy',
				program: 'Example rewards',
				points: 32,
				scraped_at: '2030-01-03T00:00:00.000Z'
			}
		]
	);
	expect(result.legacyBalances).toHaveLength(1);
	expect(result.programs[0].components[0].balanceGroups).toHaveLength(0);
});
it('separates date-only, instant and undated balance observations', () => {
	const result = run(
		[],
		[
			snapshot(),
			snapshot({ id: 'instant', source_date: null, source_as_of: '2030-01-02T00:00:00.000Z' }),
			snapshot({ id: 'undated', source_date: null })
		]
	).programs[0].components[0];
	expect(result.balanceGroups).toHaveLength(3);
	expect(result.balanceGroups.find((g) => g.precision === 'undated')).toMatchObject({
		selected: null,
		status: 'undated'
	});
});
it('rejects conflicting same-time snapshots instead of choosing the newest capture', () => {
	const result = run(
		[],
		[
			snapshot(),
			snapshot({
				id: 'conflict',
				exact_amount: '101',
				points: 101,
				scraped_at: '2030-01-04T00:00:00.000Z'
			})
		]
	);
	expect(result.programs[0].components[0].balanceGroups[0]).toMatchObject({
		selected: null,
		status: 'conflict'
	});
});
it('does not select a partial or broken balance correction graph', () => {
	expect(
		run([], [snapshot({ supersedes_id: 'missing' })]).programs[0].components[0].balanceGroups[0]
	).toMatchObject({ selected: null, status: 'invalid-history' });
	expect(run([], [snapshot()], false).programs[0].components[0].balanceGroups[0]).toMatchObject({
		selected: null,
		status: 'incomplete'
	});
});
it('keeps currencies and unlike units separate', () => {
	const result = run(
		[event(), event({ id: 'cash', component_id: 'cash', units_delta: '10' })],
		[],
		true,
		[
			component,
			{
				...component,
				id: 'cash',
				component_key: 'usd',
				unit: 'USD',
				role: 'cash_reward',
				currency: 'USD'
			}
		]
	);
	expect(result.programs[0].components.map((c) => c.earned)).toEqual(['0.1', '10']);
});
it.each([
	{ units_delta: '1.0' },
	{ units_delta: '1e3' },
	{ units_delta: '-1' },
	{ kind: 'redeem', units_delta: '1' },
	{ event_date: '2030-02-30' },
	{ component_id: 'missing' }
])('rejects invalid event %j', (patch) => expect(() => run([event(patch)])).toThrow());
it('does not expose raw receipt identity or evidence fields', () => {
	const result = run([
		event({
			details: {
				schema_version: 1,
				native_identity: { account: 'private-number' },
				source_url: 'private-url'
			}
		})
	]);
	expect(JSON.stringify(result)).not.toMatch(/private-number|private-url|native_identity/);
});
it('accepts a guarded typed replacement while retaining its matching untyped predecessor', () => {
	const legacy = {
		id: 'legacy',
		program: 'Legacy label',
		points: 100,
		scraped_at: '2030-01-03T00:00:00.000Z'
	};
	const result = run([], [legacy, snapshot({ supersedes_id: 'legacy' })]);
	expect(result.legacyBalances).toHaveLength(1);
	expect(result.programs[0].components[0].balanceGroups[0].selected?.id).toBe('balance');
});
it('does not accept a legacy replacement with changed original facts', () => {
	const legacy = {
		id: 'legacy',
		program: 'Another label',
		points: 100,
		scraped_at: '2030-01-03T00:00:00.000Z'
	};
	expect(
		run([], [legacy, snapshot({ supersedes_id: 'legacy' })]).programs[0].components[0]
			.balanceGroups[0]
	).toMatchObject({ status: 'invalid-history', selected: null });
});
it('rejects two typed successors of one legacy observation', () => {
	const legacy = {
		id: 'legacy',
		program: 'Legacy label',
		points: 100,
		scraped_at: '2030-01-03T00:00:00.000Z'
	};
	const result = run(
		[],
		[
			legacy,
			snapshot({ supersedes_id: 'legacy' }),
			snapshot({ id: 'other', supersedes_id: 'legacy' })
		]
	);
	expect(result.programs[0].components[0].balanceGroups[0]).toMatchObject({
		status: 'invalid-history',
		selected: null
	});
});
