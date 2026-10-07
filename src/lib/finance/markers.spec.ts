import { describe, expect, it } from 'vitest';
import { bucketize } from './series';
import {
	parseMarker,
	visibleMarkers,
	markerBuckets,
	markerText,
	assignLane,
	markerLabelBounds
} from './markers';

const point = {
	id: '00000000-0000-4000-8000-000000000001',
	revision: 1,
	date: '2030-01-15',
	end: null,
	title: 'Example event'
};

describe('marker inputs', () => {
	it('accepts calendar points and inclusive ranges while trimming only the title', () => {
		expect(parseMarker({ date: '2024-02-29', end: null, title: ' Event ' })).toEqual({
			date: '2024-02-29',
			end: null,
			title: 'Event'
		});
		expect(parseMarker({ date: '2030-01-01', end: '2030-01-01', title: 'One day' }).end).toBe(
			'2030-01-01'
		);
	});
	it.each([
		{ date: '2030-02-29' },
		{ date: '0000-01-01' },
		{ date: '2030-13-01' },
		{ date: '2030-1-01' },
		{ end: '2029-12-31' },
		{ end: '2030-01-01T00:00:00Z' },
		{ title: ' ' },
		{ title: 'x'.repeat(201) },
		{ title: 'x\u0000' },
		{ title: '\ud800' },
		{ command: 'unexpected' }
	])('rejects malformed marker %#', (patch) => {
		expect(() =>
			parseMarker({ date: '2030-01-01', end: null, title: 'Example', ...patch })
		).toThrow();
	});
});

describe('calendar markers', () => {
	it('preserves point markers in the actual Networth monthly chart buckets', () => {
		const data = bucketize({ dates: ['2030-01-15', '2030-02-15'], series: [] }, 'month');
		expect(markerBuckets(point, data.dates, 'month')).toEqual({ start: 0, end: 0 });
	});
	it('filters exact date windows before bucketing and includes overlapping ranges', () => {
		const range = { ...point, id: 'range', date: '2029-12-01', end: '2030-02-01' };
		expect(visibleMarkers([point, range], '2030-01-16', '2030-01-20')).toEqual([range]);
		expect(visibleMarkers([point], '2030-01-15', '2030-01-15')).toEqual([point]);
	});
	it('maps partial weeks and months and clamps crossing ranges to available buckets', () => {
		expect(markerBuckets(point, ['2030-01-14', '2030-01-21'], 'week')).toEqual({
			start: 0,
			end: 0
		});
		expect(markerBuckets(point, ['2030-01', '2030-02'], 'month')).toEqual({ start: 0, end: 0 });
		expect(
			markerBuckets(
				{ ...point, date: '2029-12-01', end: '2030-03-01' },
				['2030-01', '2030-02'],
				'month'
			)
		).toEqual({ start: 0, end: 1 });
		expect(markerBuckets(point, ['2030-02'], 'month')).toBeNull();
	});
	it('conceals free-text even if it contains money, preserving dates', () => {
		expect(markerText({ ...point, title: 'Amount $100' }, true)).toBe('2030-01-15: Hidden marker');
		expect(markerText(point, false)).toBe('2030-01-15: Example event');
	});
	it('keeps labels within narrow charts and separates overlapping labels', () => {
		expect(markerLabelBounds(20, 200, 10, 90)).toEqual({ left: 10, width: 80 });
		expect(assignLane([{ lane: 0, left: 10, right: 80 }], 20, 90)).toBe(1);
		expect(assignLane([{ lane: 0, left: 10, right: 80 }], 90, 100)).toBe(0);
	});
});
