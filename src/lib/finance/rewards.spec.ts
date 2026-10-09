import { describe, expect, it } from 'vitest';
import {
	assembleRewards,
	cardGuidance,
	currentBalance,
	quarterOf,
	type RewardRow
} from './rewards';
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
		selected: { id: 'undated' },
		status: 'captured'
	});
});
it('shows the latest undated capture as a capture, never as a source-dated balance', () => {
	const groups = (rows: RewardRow[]) => run([], rows).programs[0].components[0].balanceGroups;
	const undated = (patch: RewardRow) => snapshot({ source_date: null, ...patch });
	expect(
		groups([
			undated({ id: 'old', exact_amount: '5', points: 5, scraped_at: '2030-01-01T00:00:00.000Z' }),
			undated({ id: 'new', exact_amount: '7', points: 7, scraped_at: '2030-01-05T00:00:00.000Z' })
		])
	).toMatchObject([{ status: 'captured', precision: 'undated', selected: { id: 'new' } }]);
	expect(
		groups([undated({ id: 'a' }), undated({ id: 'b', exact_amount: '9', points: 9 })])[0]
	).toMatchObject({ status: 'conflict', selected: null });
	const both = run(
		[],
		[
			snapshot(),
			undated({ id: 'later', scraped_at: '2030-02-01T00:00:00.000Z', exact_amount: '1', points: 1 })
		]
	).programs[0].components[0];
	expect(currentBalance(both, 'available')).toMatchObject({
		amount: '100',
		asOf: '2030-01-02',
		captured: false
	});
	expect(
		currentBalance(run([], [undated({})]).programs[0].components[0], 'available')
	).toMatchObject({ amount: '100', asOf: '2030-01-03T00:00:00.000Z', captured: true });
	expect(currentBalance(run([], []).programs[0].components[0], 'available')).toBeNull();
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
it('rejects currency components with missing or different native currency before displaying totals', () => {
	for (const patch of [
		{ unit: 'USD', currency: null },
		{ unit: 'points', currency: 'USD' },
		{ unit: 'USD', currency: 'EUR' }
	]) {
		expect(() => run([event()], [], true, [{ ...component, ...patch }])).toThrow(
			'Invalid reward data'
		);
	}
	const result = run([], [], true, [{ ...component, unit: 'MQD', role: 'qualifying' }]);
	expect(result.programs[0].components[0]).toMatchObject({ unit: 'MQD', currency: null });
	expect(
		run([], [], true, [{ ...component, unit: 'USD', currency: 'USD', role: 'cash_reward' }])
			.programs[0].components[0].currency
	).toBe('USD');
});

const TODAY = '2030-05-10';
const term = (patch: RewardRow = {}, payload: RewardRow = {}) => ({
	id: 'term',
	program_id: 'program',
	component_id: 'points',
	term_key: 'expiry:points',
	kind: 'expiry',
	authority: 'provider',
	applicability: 'account_observed',
	effective_from: null,
	effective_until: null,
	source_as_of: null,
	observed_at: '2030-01-03T00:00:00.000Z',
	supersedes_id: null,
	...patch,
	payload: {
		schema_version: 1,
		product_label: null,
		conditions: ['Example condition.'],
		uncertainty: null,
		component_or_lot_key: null,
		type: 'no_scheduled_expiry',
		expires_on: null,
		duration: null,
		duration_unit: null,
		qualifying_activity: [],
		last_qualifying_activity: null,
		activation_date: null,
		closure_caveat: null,
		...payload
	}
});
const withTerms = (
	terms: RewardRow[],
	extra: Partial<Parameters<typeof assembleRewards>[4]> = {}
) =>
	assembleRewards([program], [component], [], [], { complete: true, today: TODAY, terms, ...extra })
		.programs[0];
describe('expiry clock', () => {
	const clock = (...terms: RewardRow[]) => withTerms(terms).components[0].expiry;
	it('is unknown without published terms, never a guessed date', () =>
		expect(clock()).toMatchObject({ status: 'unknown', expiresOn: null }));
	it('reports a public no-expiry policy as unverified for the account', () =>
		expect(clock(term({ applicability: 'public_unverified' }))).toMatchObject({
			status: 'none',
			verified: false
		}));
	it('prefers an account-observed deadline over public policy', () =>
		expect(
			clock(
				term(
					{ id: 'public', applicability: 'public_unverified' },
					{ type: 'inactivity', duration: 24, duration_unit: 'month' }
				),
				term(
					{ id: 'account', term_key: 'expiry:points:account' },
					{ type: 'provider_deadline', expires_on: '2031-08-24' }
				)
			)
		).toMatchObject({ status: 'scheduled', expiresOn: '2031-08-24', verified: true }));
	it('runs an inactivity clock only from a stated qualifying activity date', () => {
		expect(
			clock(
				term(
					{},
					{
						type: 'inactivity',
						duration: 24,
						duration_unit: 'month',
						last_qualifying_activity: '2030-01-31'
					}
				)
			)
		).toMatchObject({ status: 'scheduled', expiresOn: '2032-01-31' });
		expect(
			clock(
				term(
					{},
					{
						type: 'inactivity',
						duration: 1,
						duration_unit: 'month',
						last_qualifying_activity: '2030-01-31'
					}
				)
			)
		).toMatchObject({ expiresOn: '2030-02-28' });
		expect(
			clock(
				term(
					{},
					{
						type: 'inactivity',
						duration: 365,
						duration_unit: 'day',
						last_qualifying_activity: '2030-01-01'
					}
				)
			)
		).toMatchObject({ expiresOn: '2031-01-01' });
		expect(
			clock(term({}, { type: 'inactivity', duration: 24, duration_unit: 'month' }))
		).toMatchObject({
			status: 'unknown',
			reason: expect.stringMatching(/qualifying activity/)
		});
		expect(
			clock(
				term(
					{ applicability: 'public_unverified' },
					{
						type: 'inactivity',
						duration: 24,
						duration_unit: 'month',
						last_qualifying_activity: '2030-01-31'
					}
				)
			)
		).toMatchObject({ status: 'unknown' });
	});
	it('needs lot dates for fixed-duration expiry', () =>
		expect(
			clock(term({}, { type: 'fixed_duration', duration: 3, duration_unit: 'year' }))
		).toMatchObject({
			status: 'unknown',
			reason: expect.stringMatching(/lot/)
		}));
	it('ignores terms outside their effective interval and withholds conflicts', () => {
		expect(clock(term({ effective_from: '2030-06-01' }))).toMatchObject({ status: 'unknown' });
		expect(clock(term({ effective_until: '2030-05-10' }))).toMatchObject({ status: 'unknown' });
		expect(
			clock(
				term({ id: 'a' }),
				term(
					{ id: 'b', term_key: 'other' },
					{ type: 'provider_deadline', expires_on: '2031-01-01' }
				)
			)
		).toMatchObject({ status: 'unknown', reason: expect.stringMatching(/Conflicting/) });
		expect(
			clock(
				term({ id: 'a' }, { type: 'provider_deadline', expires_on: '2031-03-01' }),
				term(
					{ id: 'b', term_key: 'lot-2' },
					{ type: 'provider_deadline', expires_on: '2030-12-01' }
				)
			)
		).toMatchObject({ status: 'scheduled', expiresOn: '2030-12-01' });
	});
	it('follows term corrections and ignores past provider deadlines', () => {
		expect(
			clock(
				term({ id: 'old' }, { type: 'provider_deadline', expires_on: '2031-01-01' }),
				term(
					{ id: 'new', supersedes_id: 'old' },
					{ type: 'provider_deadline', expires_on: '2031-02-01' }
				)
			)
		).toMatchObject({ expiresOn: '2031-02-01' });
		expect(clock(term({}, { type: 'provider_deadline', expires_on: '2030-05-09' }))).toMatchObject({
			status: 'unknown'
		});
	});
});
describe('cap headroom', () => {
	const cap = (patch: RewardRow = {}, payload: RewardRow = {}) =>
		term(
			{ id: 'cap', kind: 'cap', term_key: 'cap:bonus', component_id: null, ...patch },
			{
				shared_cap_key: 'bonus',
				basis: 'spend',
				limit: '2500',
				unit: 'USD',
				period_kind: 'calendar_quarter',
				period_start: null,
				period_end_exclusive: null,
				reset_timezone: null,
				observed_usage: '600.5',
				...payload
			}
		);
	const caps = (...rows: RewardRow[]) => withTerms(rows).caps;
	it('subtracts observed usage exactly and resets at the period end', () =>
		expect(caps(cap())).toMatchObject([
			{
				key: 'bonus',
				status: 'available',
				limit: '2500',
				used: '600.5',
				remaining: '1899.5',
				resetsOn: '2030-07-01'
			}
		]));
	it('never shows negative headroom', () =>
		expect(caps(cap({}, { observed_usage: '3000' }))[0].remaining).toBe('0'));
	it('withholds headroom without observed usage, a stated limit or the current period', () => {
		expect(
			caps(cap({ applicability: 'public_unverified' }, { observed_usage: null }))[0]
		).toMatchObject({
			status: 'unavailable',
			remaining: null,
			reason: expect.stringMatching(/usage/)
		});
		expect(caps(cap({}, { limit: null }))[0]).toMatchObject({ status: 'unavailable' });
		expect(
			caps(
				cap(
					{},
					{
						period_kind: 'billing_cycle',
						period_start: '2030-03-01',
						period_end_exclusive: '2030-04-01'
					}
				)
			)[0]
		).toMatchObject({ status: 'unavailable', reason: expect.stringMatching(/period/) });
		expect(caps(cap({}, { period_kind: 'rolling' }))[0]).toMatchObject({ status: 'unavailable' });
	});
	it('uses calendar years and explicit current periods', () => {
		expect(caps(cap({}, { period_kind: 'calendar_year' }))[0].resetsOn).toBe('2031-01-01');
		expect(
			caps(
				cap(
					{},
					{
						period_kind: 'billing_cycle',
						period_start: '2030-04-20',
						period_end_exclusive: '2030-05-20'
					}
				)
			)[0]
		).toMatchObject({ status: 'available', resetsOn: '2030-05-20' });
	});
});
describe('earning rate', () => {
	const earn = (id: string, units: string, patch: RewardRow = {}) =>
		event({ id, event_key: id, units_delta: units, ...patch });
	const rate = (
		events: RewardRow[],
		links: { event_id: string; amount: string; currency: string }[],
		complete = true
	) =>
		assembleRewards([program], [component], events, [], { complete, today: TODAY, links })
			.programs[0].components[0].earningRate;
	it('divides observed earned units by the card spend linked to them', () =>
		expect(
			rate(
				[earn('a', '100'), earn('b', '50'), earn('unlinked', '999')],
				[
					{ event_id: 'a', amount: '60', currency: 'USD' },
					{ event_id: 'b', amount: '40', currency: 'USD' }
				]
			)
		).toMatchObject({
			status: 'available',
			rate: '1.5',
			earned: '150',
			spend: '100',
			currency: 'USD',
			events: 2
		}));
	it('is unavailable without linked spend, never zero', () =>
		expect(rate([earn('a', '100')], [])).toMatchObject({
			status: 'unavailable',
			rate: null,
			reason: expect.stringMatching(/linked/)
		}));
	it('excludes pending earnings and refuses mixed or incomplete inputs', () => {
		expect(
			rate(
				[earn('a', '100', { state: 'pending' })],
				[{ event_id: 'a', amount: '10', currency: 'USD' }]
			).status
		).toBe('unavailable');
		expect(
			rate(
				[earn('a', '1'), earn('b', '1')],
				[
					{ event_id: 'a', amount: '10', currency: 'USD' },
					{ event_id: 'b', amount: '10', currency: 'EUR' }
				]
			).reason
		).toMatch(/currenc/);
		expect(
			rate([earn('a', '1')], [{ event_id: 'a', amount: '10', currency: 'USD' }], false).status
		).toBe('unavailable');
		expect(rate([earn('a', '1')], [{ event_id: 'a', amount: '-10', currency: 'USD' }]).status).toBe(
			'unavailable'
		);
	});
	it('counts a linked earlier version once through its corrected head', () =>
		expect(
			rate(
				[
					earn('a', '100', { state: 'pending', event_key: 'k' }),
					earn('b', '120', { event_key: 'k', supersedes_id: 'a' })
				],
				[{ event_id: 'a', amount: '60', currency: 'USD' }]
			)
		).toMatchObject({ rate: '2', earned: '120', events: 1 }));
});
describe('dollar value and redemptions', () => {
	const cash = {
		...component,
		id: 'cash',
		component_key: 'cash',
		unit: 'USD',
		role: 'cash_reward',
		currency: 'USD'
	};
	const assemble = (
		values: { program_id: string; value_per_unit: string; revision: number }[],
		rows: RewardRow[],
		components = [component, cash]
	) =>
		assembleRewards([program], components, [], rows, { complete: true, today: TODAY, values })
			.programs[0];
	it('uses exact cash amounts and labels owner-valued points as estimates', () => {
		const result = assemble(
			[{ program_id: 'program', value_per_unit: '0.015', revision: 1 }],
			[
				snapshot({ exact_amount: '7702', points: 7702 }),
				snapshot({ id: 'c', component_id: 'cash', exact_amount: '17.8', points: 17.8 })
			]
		);
		expect(result.value).toEqual({ value_per_unit: '0.015', revision: 1 });
		expect(result.components.map((c) => c.dollar)).toEqual([
			{ value: '115.53', estimated: true },
			{ value: '17.8', estimated: false }
		]);
	});
	it('never values points without an owner value or a qualifying counter', () => {
		expect(assemble([], [snapshot()]).components[0].dollar).toBeNull();
		const qualifying = { ...component, unit: 'MQD', role: 'qualifying' };
		expect(
			assemble(
				[{ program_id: 'program', value_per_unit: '1', revision: 1 }],
				[snapshot({ basis: 'qualifying' })],
				[qualifying]
			).components[0].dollar
		).toBeNull();
	});
	it('freezes a valuation to its exact redemption head', () => {
		const redeem = event({ id: 'r', event_key: 'r', kind: 'redeem', units_delta: '-9379' });
		const valuation = {
			id: 'v',
			event_id: 'r',
			basis: 'provider_comparable',
			comparable_amount: '65.66',
			currency: 'USD',
			comparable_scope: 'gross_benefit',
			reward_value: '65.66',
			rate_at_redemption: '0.007000746348224757',
			units_consumed: '9379',
			valued_at: '2030-01-04T00:00:00.000Z',
			supersedes_id: null
		};
		const view = assembleRewards([program], [component], [redeem], [], {
			complete: true,
			today: TODAY,
			valuations: [valuation]
		});
		expect(view.programs[0].components[0].redemptions).toMatchObject([
			{
				event: { id: 'r', units_delta: '-9379' },
				valuation: { reward_value: '65.66', basis: 'provider_comparable' }
			}
		]);
		const corrected = assembleRewards(
			[program],
			[component],
			[redeem, { ...redeem, id: 'r2', units_delta: '-9000', supersedes_id: 'r' }],
			[],
			{ complete: true, today: TODAY, valuations: [valuation] }
		);
		expect(corrected.programs[0].components[0].redemptions).toMatchObject([
			{ event: { id: 'r2' }, valuation: null }
		]);
	});
});
describe('card guidance', () => {
	const card = (id: string, cash = true) => ({
		program: { id: `p-${id}`, label: `Program ${id}`, provider: 'Example', account_id: id },
		component: {
			id: `c-${id}`,
			program_id: `p-${id}`,
			component_key: 'k',
			label: 'Rewards',
			unit: cash ? 'USD' : 'points',
			role: cash ? 'cash_reward' : 'redeemable',
			currency: cash ? 'USD' : null
		}
	});
	const earning = (
		id: string,
		key: string,
		category: string | null,
		numerator: string,
		extra: RewardRow = {},
		patch: RewardRow = {}
	) =>
		term(
			{
				id: `${id}-${key}`,
				program_id: `p-${id}`,
				component_id: `c-${id}`,
				term_key: key,
				kind: 'earning',
				...patch
			},
			{
				basis: 'spend',
				basis_currency: 'USD',
				exclusions: [],
				numerator,
				denominator: '1',
				numerator_unit: 'x',
				denominator_unit: 'USD',
				rounding: null,
				category_key: category,
				base_or_bonus: category ? 'bonus' : 'base',
				required_tier_key: null,
				required_election_key: null,
				cap_key: null,
				posting_lag: null,
				...extra
			}
		);
	const guide = (
		cards: ReturnType<typeof card>[],
		terms: RewardRow[],
		values: { program_id: string; value_per_unit: string; revision: number }[] = []
	) =>
		cardGuidance({
			rewards: assembleRewards(
				cards.map((c) => c.program),
				cards.map((c) => c.component),
				[],
				[],
				{ complete: true, today: TODAY, terms, values }
			),
			cards: cards
				.map((c) => ({ id: c.program.account_id, label: `Card ${c.program.account_id}` }))
				.concat({ id: 'loose', label: 'Unlinked card' }),
			spending: [
				{ account_id: 'a', category: 'Dining', amount: 40, date: '2030-05-01' },
				{ account_id: 'b', category: 'Dining', amount: 20, date: '2030-05-01' },
				{ account_id: 'a', category: 'Groceries', amount: 100, date: '2030-05-01' }
			],
			today: TODAY
		});
	it("orders this quarter's categories by posted spend and marks unknown cards", () => {
		const result = guide([card('a'), card('b')], []);
		expect(result).toMatchObject({ periodStart: '2030-04-01', periodEnd: '2030-07-01' });
		expect(result.categories.map((c) => [c.category, c.spent])).toEqual([
			['Groceries', '100'],
			['Dining', '60']
		]);
		expect(result.categories[0].cards.every((c) => c.status === 'unknown')).toBe(true);
		expect(result.categories[0].pick).toBeNull();
	});
	it('picks the best verified rate only when every card is known', () => {
		const terms = [
			earning('a', 'base', null, '0.01'),
			earning('b', 'base', null, '0.01'),
			earning('b', 'dining', 'Dining', '0.03')
		];
		const twoCards = guide([card('a'), card('b')], terms);
		expect(twoCards.categories.find((c) => c.category === 'Dining')!.pick).toBeNull();
		const known = cardGuidance({
			...guideInput(terms),
			cards: [
				{ id: 'a', label: 'A' },
				{ id: 'b', label: 'B' }
			]
		});
		const dining = known.categories.find((c) => c.category === 'Dining')!;
		expect(dining.cards).toMatchObject([
			{ id: 'a', status: 'rate', rate: '0.01', estimated: false },
			{ id: 'b', status: 'rate', rate: '0.03', estimated: false }
		]);
		expect(dining.pick).toBe('b');
		expect(known.categories.find((c) => c.category === 'Groceries')!.pick).toBeNull();
	});
	it('ranks points only through an owner value, labelled as an estimate', () => {
		const terms = [earning('a', 'base', null, '0.02'), earning('p', 'base', null, '3')];
		const input = (values: { program_id: string; value_per_unit: string; revision: number }[]) => ({
			...guideInput(terms, [card('a'), card('p', false)], values),
			cards: [
				{ id: 'a', label: 'A' },
				{ id: 'p', label: 'P' }
			]
		});
		expect(cardGuidance(input([])).categories[0].pick).toBeNull();
		const valued = cardGuidance(input([{ program_id: 'p-p', value_per_unit: '0.01', revision: 1 }]))
			.categories[0];
		expect(valued.cards[1]).toMatchObject({
			status: 'rate',
			rate: '3',
			value: '0.03',
			estimated: true
		});
		expect(valued.pick).toBe('p');
	});
	it('withholds unverified, capped-unknown and conflicting rules', () => {
		const only = (terms: RewardRow[]) =>
			cardGuidance({
				...guideInput(terms, [card('a')]),
				cards: [{ id: 'a', label: 'A' }]
			}).categories.find((c) => c.category === 'Dining')!.cards[0];
		expect(
			only([earning('a', 'base', null, '0.01', {}, { applicability: 'public_unverified' })]).status
		).toBe('unknown');
		expect(
			only([
				earning('a', 'base', null, '0.01'),
				earning('a', 'dining', 'Dining', '0.03', { cap_key: 'q' })
			]).status
		).toBe('unknown');
		expect(
			only([
				earning('a', 'base', null, '0.01'),
				earning('a', 'd1', 'Dining', '0.03'),
				earning('a', 'd2', 'Dining', '0.04')
			]).status
		).toBe('conflict');
		const capped = (usage: string) => [
			earning('a', 'base', null, '0.01'),
			earning('a', 'dining', 'Dining', '0.03', { cap_key: 'q' }),
			term(
				{ id: 'cap-a', program_id: 'p-a', component_id: null, kind: 'cap', term_key: 'cap:q' },
				{
					shared_cap_key: 'q',
					basis: 'spend',
					limit: '2500',
					unit: 'USD',
					period_kind: 'calendar_quarter',
					period_start: null,
					period_end_exclusive: null,
					reset_timezone: null,
					observed_usage: usage
				}
			)
		];
		expect(only(capped('100'))).toMatchObject({ status: 'rate', rate: '0.03', headroom: '2400' });
		expect(only(capped('2500'))).toMatchObject({ status: 'rate', rate: '0.01', headroom: '0' });
		expect(
			only([
				earning('a', 'base', null, '0.01'),
				earning('a', 'dining', 'Dining', '0.05', { required_election_key: 'choice' })
			]).rate
		).toBe('0.01');
		expect(
			only([
				earning('a', 'base', null, '0.01'),
				earning('a', 'dining', 'Dining', '0.05', { required_election_key: 'choice' }),
				term(
					{ id: 'el', program_id: 'p-a', component_id: null, kind: 'election', term_key: 'choice' },
					{ category_key: 'Dining', enrollment: 'enrolled' }
				)
			]).rate
		).toBe('0.05');
	});
	function guideInput(
		terms: RewardRow[],
		cards = [card('a'), card('b')],
		values: { program_id: string; value_per_unit: string; revision: number }[] = []
	) {
		return {
			rewards: assembleRewards(
				cards.map((c) => c.program),
				cards.map((c) => c.component),
				[],
				[],
				{ complete: true, today: TODAY, terms, values }
			),
			spending: [
				{ account_id: 'a', category: 'Dining', amount: 40, date: '2030-05-01' },
				{ account_id: 'b', category: 'Dining', amount: 20, date: '2030-05-01' },
				{ account_id: 'a', category: 'Groceries', amount: 100, date: '2030-05-01' },
				{ account_id: 'a', category: 'Groceries', amount: 5, date: '2030-03-31' }
			],
			today: TODAY
		};
	}
});
it('finds the calendar quarter of a date', () => {
	expect(quarterOf('2030-12-31')).toEqual({ start: '2030-10-01', end: '2031-01-01' });
	expect(quarterOf('2030-01-01')).toEqual({ start: '2030-01-01', end: '2030-04-01' });
});
it('withholds clocks and headroom when term history is incomplete', () => {
	const view = assembleRewards([program], [component], [], [], {
		complete: false,
		today: TODAY,
		terms: [term({}, { type: 'provider_deadline', expires_on: '2031-01-01' })]
	}).programs[0];
	expect(view.components[0].expiry.status).toBe('unknown');
	expect(view.components[0].earningRate.status).toBe('unavailable');
});
it('ignores an owner value whose program no longer exists', () =>
	expect(
		assembleRewards([program], [component], [], [], {
			complete: true,
			today: TODAY,
			values: [{ program_id: 'retired', value_per_unit: '1', revision: 1 }]
		}).programs[0].value
	).toBeNull());
