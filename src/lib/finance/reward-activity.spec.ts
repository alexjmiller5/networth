import { describe, expect, it } from 'vitest';
import { rewardActivity, rewardSeries } from './reward-activity';
const row = (patch = {}) => ({
	id: 'one',
	component_id: 'component',
	event_key: 'one',
	kind: 'earn' as const,
	state: 'posted' as const,
	event_date: '2030-01-02',
	units_delta: '0.1',
	supersedes_id: null,
	...patch
});
it('groups exact same-unit activity by date and kind without netting redemptions into earnings', () => {
	expect(
		rewardActivity(
			[
				row(),
				row({ id: 'two', event_key: 'two', units_delta: '0.2' }),
				row({ id: 'three', event_key: 'three', kind: 'redeem', units_delta: '-1' })
			],
			true
		)
	).toEqual([
		{ date: '2030-01-02', kind: 'earn', value: '0.3' },
		{ date: '2030-01-02', kind: 'redeem', value: '-1' }
	]);
});
it('excludes pending, unknown date and replaced observations', () => {
	expect(
		rewardActivity(
			[
				row({ state: 'pending' }),
				row({ id: 'replacement', supersedes_id: 'one', units_delta: '2' }),
				row({ id: 'undated', event_key: 'undated', event_date: null }),
				row({ id: 'pending', event_key: 'pending', state: 'pending', units_delta: '50' })
			],
			true
		)
	).toEqual([{ date: '2030-01-02', kind: 'earn', value: '2' }]);
});
it('withholds graph values if membership or correction history is uncertain', () => {
	expect(rewardActivity([row()], false)).toEqual([]);
	expect(
		rewardActivity(
			[
				row(),
				row({ id: 'fork-a', supersedes_id: 'one' }),
				row({ id: 'fork-b', supersedes_id: 'one' })
			],
			true
		)
	).toEqual([]);
});
it('rejects unlike components even when their unit labels might look alike', () => {
	expect(() =>
		rewardActivity([row(), row({ id: 'other', component_id: 'other' })], true)
	).toThrow();
});
describe('rewardSeries', () => {
	const balance = (patch = {}) => ({
		id: 'b1',
		basis: 'available',
		exact_amount: '100',
		scraped_at: '2030-01-09T10:00:00.000Z',
		source_date: null as string | null,
		source_as_of: null as string | null,
		supersedes_id: null as string | null,
		...patch
	});
	const component = (
		balances: ReturnType<typeof balance>[],
		events = [] as ReturnType<typeof row>[],
		diagnostics: string[] = []
	) => ({
		balances,
		events,
		diagnostics,
		balanceGroups: [...new Set(balances.map((b) => b.basis))].map((basis) => ({
			basis,
			status: 'captured'
		}))
	});
	it('plots balance observations at their source date, else their capture day, as closing levels', () => {
		const result = rewardSeries(
			component([
				balance(),
				balance({ id: 'b2', exact_amount: '120', scraped_at: '2030-01-10T10:00:00.000Z' }),
				balance({ id: 'p', basis: 'pending', exact_amount: '5', source_date: '2030-01-03' })
			]),
			'balances',
			'2030-01-01',
			'2030-01-14',
			'week'
		);
		expect(result.dates).toEqual(['2029-12-31', '2030-01-07', '2030-01-14']);
		expect(result.series).toEqual([
			{ key: 'available', data: [0, 120, 0] },
			{ key: 'pending', data: [5, 0, 0] }
		]);
	});
	it('drops superseded observations and bases whose selection is not trustworthy', () => {
		const rows = [balance(), balance({ id: 'fix', exact_amount: '90', supersedes_id: 'b1' })];
		expect(
			rewardSeries(component(rows), 'balances', '2030-01-09', '2030-01-09', 'day').series
		).toEqual([{ key: 'available', data: [90] }]);
		const conflicted = {
			...component(rows),
			balanceGroups: [{ basis: 'available', status: 'conflict' }]
		};
		expect(rewardSeries(conflicted, 'balances', '2030-01-09', '2030-01-09', 'day').series).toEqual(
			[]
		);
	});
	it('plots posted activity signed, earnings up and redemptions down, scaled for dollars', () => {
		const events = [
			row({ event_date: '2030-01-03', units_delta: '150' }),
			row({
				id: 'r',
				event_key: 'r',
				kind: 'redeem',
				units_delta: '-100',
				event_date: '2030-01-04'
			})
		];
		expect(
			rewardSeries(component([], events), 'activity', '2030-01-01', '2030-01-31', 'month', 0.01)
		).toEqual({
			dates: ['2030-01-01'],
			series: [
				{ key: 'earned', data: [1.5] },
				{ key: 'redeemed', data: [-1] }
			]
		});
		expect(
			rewardSeries(component([], events, ['x']), 'activity', '2030-01-01', '2030-01-31', 'month')
				.series
		).toEqual([]);
	});
});
