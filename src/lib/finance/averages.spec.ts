import { expect, it } from 'vitest';
import { averageValue, dateRange, rollingAverage, type StackedSeries } from './series';
import { buildView, readControls, writeControls } from './controls';

const dates = dateRange('2026-01-01', '2026-01-17');
const daily: StackedSeries = { dates, series: [{ key: 'a', data: dates.map((_, i) => i + 1) }] };

it('averages only the visible plotted totals, preserving zero, debt and unknowns', () => {
	expect(
		averageValue({
			dates: dates.slice(0, 2),
			series: [
				{ key: 'a', data: [10, -2] },
				{ key: 'b', data: [0, 2] }
			]
		})
	).toBe(5);
	expect(
		averageValue({
			dates: ['2026-01-01'],
			series: [
				{ key: 'a', data: [null] },
				{ key: 'b', data: [5] }
			]
		})
	).toBeNull();
	expect(averageValue({ dates: [], series: [] })).toBeNull();
	expect(averageValue({ dates: ['2026-01-01'], series: [] })).toBeNull();
});

it('uses fourteen calendar days and pre-window history, including the initial partial window', () => {
	const values = rollingAverage(daily, dates, 'day', dates[0], dates.at(-1)!);
	expect(values[0]).toBe(1);
	expect(values[13]).toBe(7.5);
	expect(values.at(-1)).toBe(10.5);
	expect(rollingAverage(daily, [dates.at(-1)!], 'day', dates.at(-1)!, dates.at(-1)!)).toEqual([
		10.5
	]);
	expect(daily.series[0].data).toEqual(dates.map((_, i) => i + 1));
});

it('samples daily means at the selected bucket end, scaling flows to selected calendar days', () => {
	for (const [bucket, label] of [
		['week', '2026-01-12'],
		['month', '2026-01-01'],
		['year', '2026-01-01']
	] as const) {
		expect(rollingAverage(daily, [label], bucket, '2026-01-14', '2026-01-17')).toEqual([10.5]);
		expect(rollingAverage(daily, [label], bucket, '2026-01-14', '2026-01-17', true)).toEqual([42]);
	}
});

it('does not substitute zero or bridge an unavailable selected series or missing calendar day', () => {
	const missing = {
		...daily,
		series: [...daily.series, { key: 'b', data: dates.map((_, i) => (i === 5 ? null : 0)) }]
	};
	expect(rollingAverage(missing, [dates.at(-1)!], 'day', dates[0], dates.at(-1)!)).toEqual([null]);
	const sparse = {
		dates: daily.dates.filter((_, i) => i !== 5),
		series: [{ key: 'a', data: daily.series[0].data.filter((_, i) => i !== 5) }]
	};
	expect(rollingAverage(sparse, [dates.at(-1)!], 'day', dates[0], dates.at(-1)!)).toEqual([null]);
});

it('persists the explicit overlay choice without resetting other controls', () => {
	const stored = { kind: 'area', bucket: 'month', showAverage: true, hideAmounts: true };
	const c = readControls({ getItem: () => JSON.stringify(stored) }, dates[0], dates.at(-1)!);
	expect(c.showAverage).toBe(true);
	expect(c.kind).toBe('area');
	expect(c.hideAmounts).toBe(true);
	let raw = '';
	writeControls(
		{
			setItem: (_, v) => {
				raw = v;
			}
		},
		c
	);
	expect(JSON.parse(raw).showAverage).toBe(true);
	expect(
		readControls({ getItem: () => '{"showAverage":"true"}' }, dates[0], dates.at(-1)!).showAverage
	).toBe(false);
});

it('composes hidden series, refunds and coarse flow totals without adding averages to money totals', () => {
	const c = readControls(undefined, dates[0], dates.at(-1)!);
	Object.assign(c, {
		activePreset: '',
		dateStart: '2026-01-14',
		dateEnd: '2026-01-17',
		bucket: 'month',
		measure: 'activity',
		flows: ['spending'],
		showAverage: true
	});
	const accounts = [
		{ id: 'a', name: 'Account', bank: 'Bank', type: 'checking' as const },
		{ id: 'b', name: 'Hidden', bank: 'Bank', type: 'checking' as const }
	];
	const rows = dates.flatMap((date) => [
		{ account_id: 'a', date, amount: -14, category: 'Food', categoryKind: 'spending' as const },
		{ account_id: 'b', date, amount: -100, category: 'Food', categoryKind: 'spending' as const }
	]);
	rows.push({
		account_id: 'a',
		date: '2026-01-17',
		amount: 14,
		category: 'Food',
		categoryKind: 'spending'
	});
	c.hidden.account = ['b'];
	const v = buildView(rows, accounts, [], c);
	expect(v.total).toBe(42);
	expect(v.average).toEqual([52]);
	expect(v.data.series).toHaveLength(1);
	expect(v.data.series[0].data).toEqual([42]);
});

it('averages closing levels and daily changes on their own units, retaining selected-window cumulative baselines', () => {
	const c = readControls(undefined, dates[0], dates.at(-1)!);
	Object.assign(c, {
		activePreset: '',
		dateStart: '2026-01-14',
		dateEnd: '2026-01-17',
		showAverage: true
	});
	const accounts = [{ id: 'a', name: 'Account', bank: 'Bank', type: 'checking' as const }];
	const rows = dates.map((date) => ({
		account_id: 'a',
		date,
		amount: 1,
		category: 'Income',
		categoryKind: 'income' as const
	}));
	const levels = buildView(rows, accounts, [], c);
	expect(levels.average).toEqual([7.5, 8.5, 9.5, 10.5]);
	expect(averageValue(levels.data)).toBe(15.5);
	expect(levels.total).toBe(17);
	c.cumulativeChoice = false;
	c.bucket = 'month';
	const delta = buildView(rows, accounts, [], c);
	expect(delta.average).toEqual([4]);
	expect(delta.total).toBe(4);
	c.measure = 'activity';
	c.flows = ['income'];
	c.cumulativeChoice = true;
	c.bucket = 'day';
	const running = buildView(rows, accounts, [], c);
	expect(running.average).toEqual([1, 1.5, 2, 2.5]);
	expect(running.total).toBe(4);
	c.kind = 'line';
	expect(buildView(rows, accounts, [], c).average).toEqual([]);
	expect(c.showAverage).toBe(true);
	c.kind = 'bar';
	expect(buildView(rows, accounts, [], c).average).toEqual(running.average);
});
