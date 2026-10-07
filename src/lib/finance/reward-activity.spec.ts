import { expect, it } from 'vitest';
import { rewardActivity } from './reward-activity';
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
