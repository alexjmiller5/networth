import { describe, expect, it } from 'vitest';
import {
	selectRewardEventHeads,
	selectRedemptionValuationHeads,
	selectRewardTermHeads,
	type RewardEventVersion,
	type RedemptionValuationVersion
} from './reward-history';

const event = (id: string, patch: Partial<RewardEventVersion> = {}): RewardEventVersion => ({
	id,
	component_id: 'component-a',
	event_key: 'event-a',
	kind: 'earn',
	state: 'posted',
	supersedes_id: null,
	...patch
});
const codes = (group: { diagnostics: { code: string }[] }) => group.diagnostics.map((d) => d.code);

describe('reward event history', () => {
	it('selects one posted head from a pending chain and preserves exact observations', () => {
		const pending = {
			...event('pending', { state: 'pending' }),
			units_delta: null,
			observed_at: '2030-05-01'
		};
		const posted = {
			...event('posted', { supersedes_id: 'pending' }),
			units_delta: '25',
			observed_at: '2030-01-01'
		};
		const before = JSON.stringify([posted, pending]);
		const [result] = selectRewardEventHeads([posted, pending]);
		expect(result.head).toEqual(posted);
		expect(result.history).toEqual([pending, posted]);
		expect(result.diagnostics).toEqual([]);
		expect(JSON.stringify([posted, pending])).toBe(before);
	});
	it('keeps reversals and unlike components separate without matching amounts or dates', () => {
		const rows = [
			event('earned'),
			event('reversed', { event_key: 'reversal-a', kind: 'reversal' }),
			event('sibling', { component_id: 'component-b' })
		];
		expect(
			selectRewardEventHeads(rows)
				.map((g) => g.head?.id)
				.sort()
		).toEqual(['earned', 'reversed', 'sibling']);
		expect(selectRewardEventHeads([])).toEqual([]);
	});
	it('does not collide tuple identities containing separators or normalize Unicode', () => {
		const rows = [
			event('one', { component_id: 'a/b', event_key: 'c' }),
			event('two', { component_id: 'a', event_key: 'b/c' }),
			event('three', { event_key: 'é' }),
			event('four', { event_key: 'e\u0301' })
		];
		expect(
			selectRewardEventHeads(rows)
				.map((g) => g.head?.id)
				.sort()
		).toEqual(['four', 'one', 'three', 'two']);
	});
	it.each([
		['duplicate_id', [event('one'), event('one')]],
		[
			'fork',
			[
				event('one'),
				event('two', { supersedes_id: 'one' }),
				event('three', { supersedes_id: 'one' })
			]
		],
		['cycle', [event('one', { supersedes_id: 'two' }), event('two', { supersedes_id: 'one' })]],
		['cycle', [event('one', { supersedes_id: 'one' })]],
		['missing_predecessor', [event('one', { supersedes_id: 'absent' })]],
		['multiple_roots', [event('one'), event('two')]]
	] as const)('fails %s closed instead of selecting an arbitrary head', (code, rows) => {
		const [result] = selectRewardEventHeads(rows);
		expect(result.head).toBeNull();
		expect(codes(result)).toContain(code);
		expect(result.history).toHaveLength(rows.length);
	});
	it('isolates corruption and rejects cross-scope predecessors in both affected groups', () => {
		const rows = [
			event('one'),
			event('two', { event_key: 'other', supersedes_id: 'one' }),
			event('safe', { component_id: 'safe' })
		];
		const results = selectRewardEventHeads(rows);
		expect(results.filter((g) => g.head).map((g) => g.head?.id)).toEqual(['safe']);
		expect(results.filter((g) => !g.head).map(codes)).toEqual([
			['cross_scope_predecessor'],
			['cross_scope_predecessor']
		]);
	});
	it('does not resolve a duplicate predecessor ID using its first occurrence', () => {
		const rows = [
			event('duplicate'),
			event('duplicate', { component_id: 'other' }),
			event('child', { component_id: 'third', supersedes_id: 'duplicate' })
		];
		for (const result of selectRewardEventHeads(rows)) {
			expect(result.head).toBeNull();
			expect(codes(result)).toContain('duplicate_id');
		}
	});
	it('finds a disconnected cycle even when another branch has a plausible head', () => {
		const [result] = selectRewardEventHeads([
			event('head'),
			event('a', { supersedes_id: 'b' }),
			event('b', { supersedes_id: 'a' })
		]);
		expect(result.head).toBeNull();
		expect(codes(result)).toContain('cycle');
	});
});

const redemption = (id: string, patch: Partial<RewardEventVersion> = {}) =>
	event(id, { kind: 'redeem', ...patch });
const valuation = (
	id: string,
	patch: Partial<RedemptionValuationVersion> = {}
): RedemptionValuationVersion => ({
	id,
	event_id: 'redeem-v1',
	basis: 'estimate',
	supersedes_id: null,
	...patch
});

describe('redemption valuation history', () => {
	it('replaces an estimate with an override in one chain while preserving frozen history', () => {
		const estimate = { ...valuation('estimate'), reward_value: '10' };
		const override = {
			...valuation('override', { basis: 'user_override', supersedes_id: 'estimate' }),
			reward_value: '12'
		};
		const [result] = selectRedemptionValuationHeads(
			[redemption('redeem-v1')],
			[override, estimate]
		);
		expect(result.history).toEqual([estimate, override]);
		expect(result.head).toEqual(override);
		expect(result.current).toEqual(override);
		expect(result.diagnostics).toEqual([]);
	});
	it('makes the old exact-event valuation historical without automatically rebasing', () => {
		const events = [
			redemption('redeem-v1'),
			redemption('redeem-v2', { supersedes_id: 'redeem-v1' })
		];
		const original = valuation('estimate');
		const [historical] = selectRedemptionValuationHeads(events, [original]);
		expect(historical.head).toEqual(original);
		expect(historical.current).toBeNull();
		expect(historical.history).toEqual([original]);
		const replacement = valuation('replacement', {
			event_id: 'redeem-v2',
			basis: 'provider_comparable',
			supersedes_id: 'estimate'
		});
		const [current] = selectRedemptionValuationHeads(events, [replacement, original]);
		expect(current.current).toEqual(replacement);
		expect(current.history).toEqual([original, replacement]);
	});
	it('never chooses a historical ancestor whose event matches if the valuation head binds an older event', () => {
		const events = [
			redemption('redeem-v1'),
			redemption('redeem-v2', { supersedes_id: 'redeem-v1' })
		];
		const currentEventValuation = valuation('first', { event_id: 'redeem-v2' });
		const historicalCorrection = valuation('second', { supersedes_id: 'first' });
		const [result] = selectRedemptionValuationHeads(events, [
			currentEventValuation,
			historicalCorrection
		]);
		expect(result.head?.id).toBe('second');
		expect(result.current).toBeNull();
	});
	it.each([
		[
			'fork',
			[
				valuation('estimate'),
				valuation('override', { basis: 'user_override', supersedes_id: 'estimate' }),
				valuation('provider', { basis: 'provider_comparable', supersedes_id: 'estimate' })
			]
		],
		['multiple_roots', [valuation('estimate'), valuation('override', { basis: 'user_override' })]],
		['duplicate_id', [valuation('same'), valuation('same', { basis: 'user_override' })]],
		['missing_predecessor', [valuation('one', { supersedes_id: 'absent' })]],
		[
			'cycle',
			[valuation('one', { supersedes_id: 'two' }), valuation('two', { supersedes_id: 'one' })]
		]
	] as const)('fails %s closed regardless of valuation basis', (code, rows) => {
		const [result] = selectRedemptionValuationHeads([redemption('redeem-v1')], rows);
		expect(result.head).toBeNull();
		expect(result.current).toBeNull();
		expect(result.history).toHaveLength(rows.length);
		expect(codes(result)).toContain(code);
	});
	it('rejects cross-redemption predecessors without suppressing unrelated valid groups', () => {
		const events = [
			redemption('redeem-v1'),
			redemption('other', { event_key: 'other' }),
			redemption('safe', { component_id: 'safe' })
		];
		const rows = [
			valuation('one'),
			valuation('two', { event_id: 'other', supersedes_id: 'one' }),
			valuation('safe-value', { event_id: 'safe' })
		];
		const results = selectRedemptionValuationHeads(events, rows);
		expect(results.filter((g) => g.current).map((g) => g.current?.id)).toEqual(['safe-value']);
		for (const result of results.filter((g) => !g.head))
			expect(codes(result)).toContain('cross_scope_predecessor');
	});
	it('retains missing event references and closes a predecessor chain they would extend', () => {
		const rows = [
			valuation('one'),
			valuation('two', { event_id: 'missing-event', supersedes_id: 'one' })
		];
		const results = selectRedemptionValuationHeads([redemption('redeem-v1')], rows);
		expect(results.every((g) => g.head === null && g.current === null)).toBe(true);
		expect(
			results
				.flatMap((g) => g.history)
				.map((v) => v.id)
				.sort()
		).toEqual(['one', 'two']);
		const unresolved = results.find((g) => g.scope === null)!;
		expect(codes(unresolved)).toContain('missing_event');
	});
	it('does not value a non-redemption event or an ambiguous event identity', () => {
		const [wrongKind] = selectRedemptionValuationHeads([event('redeem-v1')], [valuation('one')]);
		expect(wrongKind.head).toBeNull();
		expect(codes(wrongKind)).toContain('not_redemption');
		const [ambiguous] = selectRedemptionValuationHeads(
			[redemption('redeem-v1'), redemption('redeem-v1', { component_id: 'other' })],
			[valuation('one')]
		);
		expect(ambiguous.current).toBeNull();
		expect(codes(ambiguous)).toContain('ambiguous_event');
	});
	it('fails valuation selection closed when the event chain forks', () => {
		const events = [
			redemption('redeem-v1'),
			redemption('fork-a', { supersedes_id: 'redeem-v1' }),
			redemption('fork-b', { supersedes_id: 'redeem-v1' })
		];
		const [result] = selectRedemptionValuationHeads(events, [valuation('one')]);
		expect(result.head).toBeNull();
		expect(result.current).toBeNull();
		expect(codes(result)).toContain('invalid_event_history');
	});
	it('is input-order independent and never changes input rows', () => {
		const events = [
			redemption('redeem-v1'),
			redemption('redeem-v2', { supersedes_id: 'redeem-v1' })
		];
		const rows = [
			valuation('one'),
			valuation('two', { event_id: 'redeem-v2', supersedes_id: 'one' })
		];
		const before = JSON.stringify({ events, rows });
		expect(selectRedemptionValuationHeads([...events].reverse(), [...rows].reverse())).toEqual(
			selectRedemptionValuationHeads(events, rows)
		);
		expect(JSON.stringify({ events, rows })).toBe(before);
		expect(selectRedemptionValuationHeads(events, [])).toEqual([]);
	});
});

describe('selectRewardTermHeads', () => {
	const term = (id: string, supersedes_id: string | null = null, term_key = 'expiry:points') => ({
		id,
		program_id: 'program',
		component_id: 'points',
		term_key,
		supersedes_id
	});
	it('selects the corrected assertion and keeps separate term keys apart', () => {
		const groups = selectRewardTermHeads([
			term('a'),
			term('b', 'a'),
			term('c', null, 'cap:dining')
		]);
		expect(groups.map((g) => g.head?.id).sort()).toEqual(['b', 'c']);
	});
	it('withholds a head for forks instead of choosing one', () => {
		const [group] = selectRewardTermHeads([term('a'), term('b', 'a'), term('c', 'a')]);
		expect(group.head).toBeNull();
		expect(group.diagnostics[0].code).toBe('fork');
	});
});
