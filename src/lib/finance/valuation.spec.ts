import { describe, expect, it } from 'vitest';
import {
	priceKey,
	valueAccounts,
	valuedCoverage,
	type PriceBook,
	type PriceMapping
} from './valuation';
import type { Account, AccountCoverage, Txn } from './types';

const brokerage: Account = { id: 'b', bank: 'Bank', name: 'Brokerage', type: 'brokerage' };
const plan: Account = { id: 'p', bank: 'Plan', name: '401(k)', type: '401k' };
const checking: Account = { id: 'c', bank: 'Bank', name: 'Checking', type: 'checking' };
const cov = (account_id: string, basis: AccountCoverage['basis'] = 'money'): AccountCoverage => ({
	account_id,
	status: 'investment-unvalued',
	basis,
	asOf: '2026-01-09T00:00:00.000Z',
	firstTransaction: null,
	lastTransaction: null,
	transactionCount: 1,
	reasons: ['Investment market prices unavailable; cash or contributions are not market value']
});
const txn = (
	account_id: string,
	date: string,
	amount: number,
	qty?: number,
	ticker?: string
): Txn => ({
	account_id,
	date,
	amount,
	...(qty === undefined ? {} : { qty, ticker })
});
const map = (account_id: string, security_id: string, symbol = security_id): PriceMapping => ({
	account_id,
	security_id,
	provider: 'tiingo',
	symbol
});
const book = (entries: Record<string, [string, number, number?][]>): PriceBook =>
	new Map(
		Object.entries(entries).map(([key, points]) => [
			key,
			points.map(([date, price, split]) => ({ date, price, ...(split ? { split } : {}) }))
		])
	);
// 2026-01-05 is a Monday.
const prices = book({
	'tiingo:AAA': [
		['2026-01-05', 10],
		['2026-01-06', 11],
		['2026-01-09', 12]
	],
	'tiingo:BBB': [
		['2026-01-05', 100],
		['2026-01-06', 101],
		['2026-01-07', 102],
		['2026-01-08', 103],
		['2026-01-09', 104]
	]
});
const run = (over: Partial<Parameters<typeof valueAccounts>[0]> = {}) =>
	valueAccounts({
		accounts: [brokerage],
		txns: [
			txn('b', '2026-01-05', 1000),
			txn('b', '2026-01-05', -200, 20, 'AAA'),
			txn('b', '2026-01-06', -300, 3, 'BBB')
		],
		coverage: [cov('b')],
		mappings: [map('b', 'AAA'), map('b', 'BBB')],
		prices,
		observed: [],
		end: '2026-01-11',
		...over
	});

describe('investment valuation', () => {
	it('values signed positions at dated raw closes plus custody cash', () => {
		const [v] = run({
			prices: book({
				'tiingo:AAA': [
					['2026-01-05', 10],
					['2026-01-06', 11]
				],
				'tiingo:BBB': [['2026-01-06', 101]]
			}),
			end: '2026-01-06'
		});
		expect(v).toMatchObject({ account_id: 'b', start: '2026-01-05', end: '2026-01-06' });
		// Day 1: 20 x 10 + 800 cash. Day 2: 20 x 11 + 3 x 101 + 500 cash.
		expect(v.values).toEqual([1000, 1023]);
		expect(v.priceDates).toEqual(['2026-01-05', '2026-01-06']);
		expect(v.gaps).toEqual([]);
	});

	it('keeps days without a current close missing instead of carrying a stale price', () => {
		const [v] = run();
		// Jan 7-8 are market days (BBB closed) with no AAA close: unavailable, not stale-priced.
		expect(v.values).toEqual([1000, 1023, null, null, 1052, 1052, 1052]);
		expect(v.gaps).toEqual([
			{
				start: '2026-01-07',
				end: '2026-01-08',
				reason: 'Latest tiingo price for AAA is from 2026-01-06'
			}
		]);
		// The weekend carries Friday's close, labelled with that price date.
		expect(v.priceDates.slice(-2)).toEqual(['2026-01-09', '2026-01-09']);
	});

	it('stops bridging a close after the age limit even without newer market days', () => {
		const [v] = run({ end: '2026-01-14' });
		expect(v.values.slice(-3)).toEqual([1052, 1052, null]);
		expect(v.gaps.at(-1)).toMatchObject({ start: '2026-01-14', end: '2026-01-14' });
		const [quiet] = run({ end: '2026-01-13' });
		expect(quiet.values.at(-1)).toBe(1052);
	});

	it('marks an account unavailable when any holding has no price source, without touching others', () => {
		const [b, p] = run({
			accounts: [brokerage, plan],
			txns: [
				txn('b', '2026-01-05', 1000),
				txn('b', '2026-01-05', -200, 20, 'AAA'),
				txn('b', '2026-01-06', -300, 3, 'ZZZ'),
				txn('p', '2026-01-06', 202, 2, 'BBB')
			],
			coverage: [cov('b'), cov('p', 'units')],
			mappings: [map('b', 'AAA'), map('p', 'BBB')],
			end: '2026-01-06'
		});
		expect(b.values).toEqual([1000, null]);
		expect(b.gaps[0].reason).toBe('No price source for ZZZ');
		// Units-only plans expose no custody cash: contributions are not added on top of units.
		expect(p.values).toEqual([202]);
	});

	it('never joins another account’s mapping or a NAV observation across accounts', () => {
		const navs = book({ 'netbenefits:p:FUND': [['2026-01-06', 50]] });
		const [v] = run({
			accounts: [plan],
			txns: [txn('p', '2026-01-06', 100, 2, 'FUND')],
			coverage: [cov('p', 'units')],
			mappings: [{ account_id: 'p', security_id: 'FUND', provider: 'netbenefits', symbol: null }],
			prices: navs,
			end: '2026-01-06'
		});
		expect(v.values).toEqual([100]);
		expect(
			priceKey({ account_id: 'q', security_id: 'FUND', provider: 'netbenefits', symbol: null })
		).not.toBe('netbenefits:p:FUND');
		const [other] = run({
			accounts: [plan],
			txns: [txn('p', '2026-01-06', 100, 2, 'FUND')],
			coverage: [cov('p', 'units')],
			mappings: [map('b', 'FUND')],
			prices: book({ 'tiingo:FUND': [['2026-01-06', 50]] }),
			end: '2026-01-06'
		});
		expect(other.values).toEqual([null]);
	});

	it('blocks every day when ledger units disagree with observed holdings or a gate failed', () => {
		const [observed] = run({
			observed: [{ account_id: 'b', security_id: 'AAA', date: '2026-01-06', units: 21 }]
		});
		expect(observed.values.every((x) => x === null)).toBe(true);
		expect(observed.gaps[0].reason).toBe(
			'Ledger units for AAA differ from the holdings observed on 2026-01-06'
		);
		const ok = run({
			observed: [{ account_id: 'b', security_id: 'AAA', date: '2026-01-06', units: 20 }]
		});
		expect(ok[0].values[0]).toBe(1000);
		const gate = run({
			coverage: [{ ...cov('b'), reasons: ['Investment quantities do not match the unit gate'] }]
		});
		expect(gate[0].values.every((x) => x === null)).toBe(true);
		expect(run({ coverage: [{ ...cov('b'), basis: 'none' }] })[0].gaps[0].reason).toBe(
			'No reconciliation checkpoint'
		);
	});

	it('values a split only when the ledger multiplies units on the provider ex-date', () => {
		const split = book({
			'tiingo:VUG': [
				['2026-01-05', 480],
				['2026-01-06', 80, 6],
				['2026-01-07', 81]
			]
		});
		const base = {
			coverage: [cov('b', 'units')],
			mappings: [map('b', 'VUG')],
			prices: split,
			end: '2026-01-07'
		};
		const aligned = run({
			...base,
			txns: [txn('b', '2026-01-05', 0, 6, 'VUG'), txn('b', '2026-01-06', 0, 30, 'VUG')]
		});
		expect(aligned[0].values).toEqual([2880, 2880, 2916]);
		const late = run({
			...base,
			txns: [txn('b', '2026-01-05', 0, 6, 'VUG'), txn('b', '2026-01-07', 0, 30, 'VUG')]
		});
		expect(late[0].values).toEqual([2880, null, 2916]);
		expect(late[0].gaps[0].reason).toBe(
			'VUG split on 2026-01-06 but the ledger records it on 2026-01-07'
		);
		const missing = run({ ...base, txns: [txn('b', '2026-01-05', 0, 6, 'VUG')] });
		expect(missing[0].values).toEqual([2880, null, null]);
	});

	it('never values a negative position', () => {
		const [v] = run({ txns: [txn('b', '2026-01-05', 100, -1, 'AAA')], end: '2026-01-05' });
		expect(v.values).toEqual([null]);
		expect(v.gaps[0].reason).toBe('Negative AAA position');
	});

	it('skips non-investment accounts and accounts that start after the end date', () => {
		expect(run({ accounts: [checking], txns: [txn('c', '2026-01-05', 10)] })).toEqual([]);
		expect(run({ end: '2026-01-04' })).toEqual([]);
	});

	it('verifies coverage only when the end date is priced, and explains unavailable days', () => {
		const [v] = run();
		expect(valuedCoverage([cov('b')], [v])[0]).toMatchObject({
			status: 'verified',
			valuedAsOf: '2026-01-09',
			reasons: []
		});
		const [stale] = run({ end: '2026-01-08' });
		expect(valuedCoverage([cov('b')], [stale])[0]).toMatchObject({
			status: 'investment-unvalued',
			reasons: [
				'Unavailable on 2026-01-08: Latest tiingo price for AAA is from 2026-01-06',
				'Last valued 2026-01-06'
			]
		});
		const closed = {
			...cov('b'),
			status: 'verified-closed-zero' as const,
			currentBalance: 0 as const
		};
		expect(valuedCoverage([closed], [v])[0]).toMatchObject({
			status: 'verified-closed-zero',
			reasons: [
				'Current cash and positions verify zero',
				'Some historical market values are unavailable'
			]
		});
		expect(valuedCoverage([cov('x')], [v])[0]).toEqual(cov('x'));
	});
});
