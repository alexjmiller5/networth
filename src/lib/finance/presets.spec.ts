import { describe, expect, it } from 'vitest';
import { addDays, getPresetRange, isDate, clampRange } from './presets';
import { dateRange } from './series';

describe('calendar windows', () => {
	it.each(['7D', '30D', '90D'] as const)(
		'%s contains exactly the labelled number of days',
		(preset) => {
			const { start, end } = getPresetRange(preset, '2020-01-01', '2026-09-09');
			expect(dateRange(start, end)).toHaveLength(Number.parseInt(preset));
		}
	);
	it('uses real calendar dates over leap years and DST boundaries', () => {
		expect(getPresetRange('1Y', '2020-01-01', '2024-02-29')).toEqual({
			start: '2023-03-01',
			end: '2024-02-29'
		});
		expect(addDays('2026-11-01', 1)).toBe('2026-11-02');
		expect(isDate('2026-02-30')).toBe(false);
		expect(isDate('2024-02-29')).toBe(true);
	});
	it('clamps custom windows and recovers invalid or reversed dates', () => {
		expect(clampRange('2020-01-01', '2030-01-01', '2026-01-01', '2026-09-09')).toEqual({
			start: '2026-01-01',
			end: '2026-09-09'
		});
		expect(clampRange('2026-08-01', '2026-07-01', '2026-01-01', '2026-09-09')).toEqual({
			start: '2026-07-01',
			end: '2026-08-01'
		});
		expect(clampRange('broken', '2026-02-30', '2026-01-01', '2026-09-09')).toEqual({
			start: '2026-01-01',
			end: '2026-09-09'
		});
	});
});
