import { expect, it } from 'vitest';
import { tripFor, tripRegistry, AMBIGUOUS_TRIP, UNASSIGNED_TRIP } from './trips';
const trips = [
	{ id: 't1', name: 'Trip one', intervals: [{ start: '2026-01-01', end: '2026-01-03' }] },
	{ id: 't2', name: 'Trip two', intervals: [{ start: '2026-01-03', end: '2026-01-05' }] }
];
const row = {
	source: 'bank',
	source_id: 'x',
	account_id: 'a',
	date: '2026-01-03',
	amount: -10,
	category: 'Cost'
};
it('keeps each overlapping flow in one temporary bucket with reviewable candidates', () => {
	expect(tripFor(row, { trips, settlements: {} })).toEqual({
		key: AMBIGUOUS_TRIP,
		candidates: ['t1', 't2'],
		reason: 'Overlapping trips'
	});
	expect(tripFor({ ...row, date: '2026-01-01' }, { trips, settlements: {} }).key).toBe(
		'trip:id:t1'
	);
	expect(tripFor({ ...row, date: '2026-01-05' }, { trips, settlements: {} }).key).toBe(
		'trip:id:t2'
	);
	expect(tripFor({ ...row, date: '2026-01-06' }, { trips, settlements: {} }).key).toBe(
		UNASSIGNED_TRIP
	);
});
it('uses consistent valid settlement provenance ahead of dates and diagnoses conflicts', () => {
	expect(tripFor(row, { trips, settlements: { 'bank:x': ['t2', 't2'] } }).key).toBe('trip:id:t2');
	expect(
		tripFor({ ...row, date: '2026-02-01' }, { trips, settlements: { 'bank:x': ['t1'] } }).key
	).toBe('trip:id:t1');
	expect(tripFor(row, { trips, settlements: { 'bank:x': ['t1', 't2'] } }).key).toBe(AMBIGUOUS_TRIP);
	expect(tripFor(row, { trips, settlements: { 'bank:x': ['missing'] } }).key).toBe(AMBIGUOUS_TRIP);
});
it('deduplicates identical interval claims without guessing chronology from opaque landing IDs', () => {
	const claims = [
		{ notion_id: 't1', trip: 'Old label', start: '2026-01-01', end: '2026-01-03' },
		{ notion_id: 't1', trip: 'Retitled', start: '2026-01-01', end: '2026-01-03' },
		{ notion_id: 't1', trip: 'Retitled', start: '2026-01-02', end: '2026-01-04' }
	];
	const registry = tripRegistry([{ id: 't1', name: 'Current label' }], claims);
	expect(registry[0].name).toBe('Current label');
	expect(registry[0].intervals).toHaveLength(2);
	expect(tripFor(row, { trips: registry, settlements: {} }).reason).toBe('Conflicting trip dates');
	expect(() =>
		tripRegistry([{ id: 't1', name: 'Trip' }], [{ ...claims[0], end: '2026-02-30' }])
	).toThrow();
});

it('does not confuse a registered trip ID with a diagnostic bucket', () => {
	expect(
		tripFor(row, {
			trips: [{ id: 'ambiguous', name: 'Named trip', intervals: [] }],
			settlements: { 'bank:x': ['ambiguous'] }
		}).key
	).not.toBe(AMBIGUOUS_TRIP);
});
