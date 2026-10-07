import { describe, expect, it } from 'vitest';
import { assembleInvestments, investmentIdentity, type InvestmentRow } from './investments';
const instrument = (patch: InvestmentRow = {}) => ({
	id: 'security',
	account_id: 'account',
	provider_source: 'provider',
	provider_account_id: null,
	provider_plan_id: 'plan',
	native_id_kind: 'plan_fund_code',
	native_security_id: '001',
	representation: 'security',
	native_label: 'Example fund',
	ticker: null,
	cusip: null,
	share_class: null,
	identity_observed_at: '2030-01-03T00:00:00.000Z',
	deleted_at: null,
	...patch
});
const observation = (patch: InvestmentRow = {}) => ({
	id: 'one',
	instrument_id: 'security',
	metric: 'unit_price',
	exact_amount: '12.5',
	currency: 'USD',
	value_status: 'reported',
	missing_reason: null,
	price_kind: 'nav',
	source_date: '2030-01-02',
	source_at: null,
	time_basis: 'nav_as_of',
	raw_time_label: null,
	quote_delay_seconds: null,
	captured_at: '2030-01-03T00:00:00.000Z',
	capture_key: 'capture',
	supersedes_id: null,
	deleted_at: null,
	...patch
});
const run = (rows: InvestmentRow[], complete = true, instruments = [instrument()]) =>
	assembleInvestments(instruments, rows, { complete, asOf: '2030-01-05' });
const groups = (rows: InvestmentRow[], complete = true) =>
	run(rows, complete).instruments[0].groups;
it('preserves exact decimals and separates native facts from cash or complete account valuation', () => {
	const result = run([observation({ exact_amount: '12345678901234567890.123456789' })]);
	expect(result.instruments[0].groups[0]).toMatchObject({
		status: 'available',
		selected: { exact_amount: '12345678901234567890.123456789' }
	});
	expect(result).not.toHaveProperty('total');
});
it('reproduces the pinned Unicode/null identity vector without normalizing source identifiers', async () => {
	expect(
		await investmentIdentity([
			'account-test',
			'provider-test',
			null,
			'plan-test',
			'plan_fund_code',
			'00é😀'
		])
	).toBe('ii_1092904f9f74bcbd67d17c1ed9213328003d4e35d079bbf5201da0896a2e728f');
	expect(await investmentIdentity(['a', 'p', 'x', null, 'ticker', 'A'])).not.toBe(
		await investmentIdentity(['b', 'p', 'x', null, 'ticker', 'A'])
	);
	await expect(investmentIdentity(['a', 'p', null, 'x', 'ticker', '\ud800'])).rejects.toThrow();
});
it('uses source chronology, not capture chronology', () => {
	const rows = [
		observation(),
		observation({
			id: 'older',
			source_date: '2030-01-01',
			captured_at: '2030-01-05T00:00:00.000Z',
			exact_amount: '9'
		})
	];
	expect(groups(rows)[0].selected?.id).toBe('one');
});
it('does not substitute future prices into an earlier view', () => {
	expect(groups([observation({ source_date: '2030-01-06' })])).toHaveLength(0);
});
it('keeps date-only, timestamp, unknown date, currency and source-clock groups distinct', () => {
	const rows = [
		observation(),
		observation({ id: 'instant', source_date: null, source_at: '2030-01-02T00:00:00.000Z' }),
		observation({ id: 'undated', source_date: null, time_basis: 'unknown' }),
		observation({ id: 'eur', currency: 'EUR' }),
		observation({ id: 'quote', price_kind: 'last', time_basis: 'quote_refresh' })
	];
	const selected = groups(rows);
	expect(selected).toHaveLength(5);
	expect(selected.find((g) => g.precision === 'undated')).toMatchObject({
		status: 'undated',
		selected: null
	});
});
it('uses a valid explicit correction and retains original observations', () => {
	const result = run([
		observation(),
		observation({ id: 'fixed', exact_amount: '14', supersedes_id: 'one' })
	]);
	expect(result.instruments[0].groups[0].selected?.id).toBe('fixed');
	expect(result.instruments[0].observations).toHaveLength(2);
});
describe('complete correction graph', () => {
	const invalid: [string, InvestmentRow[]][] = [
		['duplicate IDs', [observation(), observation()]],
		['missing predecessor', [observation({ supersedes_id: 'missing' })]],
		[
			'fork',
			[
				observation(),
				observation({ id: 'a', supersedes_id: 'one' }),
				observation({ id: 'b', supersedes_id: 'one' })
			]
		],
		[
			'cycle',
			[observation({ supersedes_id: 'two' }), observation({ id: 'two', supersedes_id: 'one' })]
		],
		[
			'cross-metric edge',
			[
				observation(),
				observation({
					id: 'units',
					metric: 'position_units',
					price_kind: null,
					currency: null,
					time_basis: 'holdings_as_of',
					supersedes_id: 'one'
				})
			]
		]
	];
	it.each(invalid)('fails closed on %s', (_, rows) => {
		const result = groups(rows);
		expect(result.length).toBeGreaterThan(0);
		expect(result.every((g) => g.status === 'invalid-history' && g.selected === null)).toBe(true);
	});
	it('fails closed when graph membership is incomplete', () =>
		expect(groups([observation()], false)[0]).toMatchObject({
			status: 'incomplete',
			selected: null
		}));
	it('invalidates both instruments touched by a cross-instrument edge', () => {
		const result = run(
			[observation(), observation({ id: 'other', instrument_id: 'second', supersedes_id: 'one' })],
			true,
			[instrument(), instrument({ id: 'second', native_security_id: '002' })]
		);
		expect(
			result.instruments.every((i) =>
				i.groups.every((g) => g.status === 'invalid-history' && g.selected === null)
			)
		).toBe(true);
	});
});
it.each([
	{ exact_amount: '13' },
	{ value_status: 'missing', exact_amount: null, missing_reason: 'Not reported' },
	{ quote_delay_seconds: 900 }
])('does not resolve same-source-time conflicts through later capture: %j', (patch) => {
	expect(
		groups([
			observation(),
			observation({ id: 'conflict', captured_at: '2030-01-04T00:00:00.000Z', ...patch })
		])[0]
	).toMatchObject({ status: 'conflict', selected: null });
});
it('permits deterministic ordering of identical source assertions', () => {
	expect(
		groups([
			observation(),
			observation({ id: 'repeat', captured_at: '2030-01-04T00:00:00.000Z' })
		])[0].selected?.id
	).toBe('repeat');
});
it('keeps explicit missing NAV distinct from reported zero', () => {
	expect(
		groups([
			observation({ exact_amount: null, value_status: 'missing', missing_reason: 'Source blank' })
		])[0]
	).toMatchObject({ status: 'missing', selected: { exact_amount: null } });
	expect(groups([observation({ exact_amount: '0' })])[0]).toMatchObject({
		status: 'available',
		selected: { exact_amount: '0' }
	});
});
it.each(['', '0.0', '-0', '1e3', '01', '1.20', '1.' + '1'.repeat(51), '1'.repeat(101)])(
	'rejects noncanonical or unsupported precision %s',
	(exact_amount) => expect(() => run([observation({ exact_amount })])).toThrow()
);
it.each([
	{ source_date: '2030-02-30' },
	{ source_at: '2030-01-01T00:00:00.000Z' },
	{ source_date: null, time_basis: 'nav_as_of' },
	{ currency: null },
	{ exact_amount: '-1' },
	{ price_kind: 'trade' },
	{ time_basis: 'holdings_as_of' },
	{ quote_delay_seconds: -1 },
	{ value_status: 'missing' },
	{ exact_amount: null },
	{ captured_at: '2030-01-01T25:00:00.000Z' }
])('rejects invalid native assertion %j', (patch) =>
	expect(() => run([observation(patch)])).toThrow()
);
it('custody cash has only a cash metric, never an added security position', () => {
	const cash = instrument({ representation: 'custody_cash' });
	expect(() => run([observation()], true, [cash])).toThrow();
	const result = run(
		[observation({ metric: 'cash_balance', price_kind: null, time_basis: 'cash_as_of' })],
		true,
		[cash]
	);
	expect(result.instruments[0].representation).toBe('custody_cash');
	expect(result).not.toHaveProperty('total');
});
it('unresolved instruments remain display-only', () => {
	expect(
		run([observation()], true, [instrument({ representation: 'unresolved' })]).instruments[0]
			.groups[0]
	).toMatchObject({ status: 'unresolved', selected: null });
});
it('does not treat deleted correction members as a valid complete history', () => {
	expect(
		groups([
			observation({ deleted_at: '2030-01-04T00:00:00.000Z' }),
			observation({ id: 'replacement', supersedes_id: 'one' })
		])[0]
	).toMatchObject({ status: 'invalid-history', selected: null });
});
