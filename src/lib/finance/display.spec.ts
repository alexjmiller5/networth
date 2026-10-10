import { describe, expect, it } from 'vitest';
import {
	formatMoney,
	formatMoneyTick,
	formatUnits,
	formatCoverage,
	valuationLabel
} from './display';

describe('local amount concealment', () => {
	it('hides positive, negative, zero and large balances in every numeric display', () => {
		for (const value of [0, -0, 42.37, -987.65, 1234567.89]) {
			expect(formatMoney(value, true)).toBe('Hidden');
			expect(formatMoneyTick(value, true)).toBe('');
			expect(formatUnits(value, true)).toBe('Hidden');
		}
	});
	it('restores exact normal formatting without changing values', () => {
		expect(formatMoney(1234.56, false)).toBe('$1,234.56');
		expect(formatMoney(-0, false)).toBe('$0.00');
		expect(formatMoneyTick(1234, false)).toBe('$1.2k');
		expect(formatUnits(12345, false)).toBe('12,345');
	});
});

it('conceals zeroes expressed in coverage labels and reasons as well as numeric values', () => {
	const c = {
		account_id: 'a',
		status: 'verified-closed-zero' as const,
		basis: 'money' as const,
		currentBalance: 0 as const,
		asOf: null,
		firstTransaction: null,
		lastTransaction: null,
		transactionCount: 1,
		reasons: ['Current cash and positions verify zero; historical market values remain unavailable']
	};
	expect(formatCoverage(c, true).label).toBe('Verified closed account');
	expect(formatCoverage(c, true).details).not.toMatch(/zero|0/i);
	expect(formatCoverage(c, false).label).toBe('Verified current zero');
	expect(formatCoverage(c, false).details).toContain('zero');
});

it('labels an investment value with its price date, and a carried NAV with its age', () => {
	const v = {
		account_id: 'p',
		start: '2026-01-09',
		end: '2026-01-21',
		values: [...Array(12).fill(100), null],
		priceDates: [...Array(12).fill('2026-01-09'), null],
		carried: [...Array(5).fill(false), ...Array(7).fill(true), false],
		gaps: []
	};
	expect(valuationLabel(v, '2026-01-09')).toBe('Market value as of 2026-01-09');
	expect(valuationLabel(v, '2026-01-14')).toBe('As of 2026-01-09 · NAV 5 days old');
	expect(valuationLabel(v, '2026-01-21')).toBeUndefined();
	expect(valuationLabel(v, '2026-01-08')).toBeUndefined();
	expect(
		valuationLabel(
			{ ...v, priceDates: ['2026-01-09', '2026-01-09'], values: [1, 1], carried: [false, true] },
			'2026-01-10'
		)
	).toBe('As of 2026-01-09 · NAV 1 day old');
	expect(
		formatCoverage(
			{
				account_id: 'p',
				status: 'carried',
				basis: 'units',
				asOf: null,
				firstTransaction: null,
				lastTransaction: null,
				transactionCount: 1,
				reasons: ['NAV from 2026-01-09 carried forward, 12 days old']
			},
			false
		).label
	).toBe('Carried NAV');
});
