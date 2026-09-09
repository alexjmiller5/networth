import { describe, expect, it } from 'vitest';
import {
	accumulate,
	bucketize,
	deriveBalances,
	differentiate,
	groupSeries,
	netTotals,
	flowsByCategory,
	flowSeries,
	flowPieces
} from './series';
import type { Account, Txn } from './types';

const accounts: Account[] = [
	{ id: 'a-check', bank: 'Bank A', name: 'Checking', type: 'checking' },
	{ id: 'a-save', bank: 'Bank A', name: 'Savings', type: 'savings' },
	{ id: 'b-check', bank: 'Bank B', name: 'Checking', type: 'checking' }
];

const txns: Txn[] = [
	{ account_id: 'a-check', date: '2026-01-01', amount: 100 }, // synthetic opening
	{ account_id: 'a-check', date: '2026-01-03', amount: -40 },
	{ account_id: 'a-save', date: '2025-12-20', amount: 500 }, // before window -> entry balance
	{ account_id: 'b-check', date: '2026-01-02', amount: 25 }
];

describe('deriveBalances', () => {
	it('omits missing and unvalued accounts instead of rendering invented zero balances', () => {
		const s = deriveBalances(
			[
				{ account_id: 'a-check', date: '2026-01-01', amount: 100, balanceAmount: 0 },
				{ account_id: 'a-save', date: '2026-01-01', amount: 200, balanceAmount: null },
				{ account_id: null, date: '2026-01-01', amount: -30, standalone: true }
			],
			accounts,
			'2026-01-01',
			'2026-01-01'
		);
		expect(s.series).toEqual([{ key: 'a-check', data: [0] }]);
	});
	it('running-sums signed txns per account, carrying pre-window txns as entry balance', () => {
		const s = deriveBalances(txns, accounts, '2026-01-01', '2026-01-04');
		expect(s.dates).toEqual(['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04']);
		expect(s.series.find((x) => x.key === 'a-check')!.data).toEqual([100, 100, 60, 60]);
		expect(s.series.find((x) => x.key === 'a-save')!.data).toEqual([500, 500, 500, 500]);
		expect(s.series.find((x) => x.key === 'b-check')!.data).toEqual([0, 25, 25, 25]);
	});
});

describe('groupSeries', () => {
	it('sums account balances into bank groups', () => {
		const s = deriveBalances(txns, accounts, '2026-01-01', '2026-01-04');
		const g = groupSeries(s, accounts, 'bank');
		expect(g.series.find((x) => x.key === 'Bank A')!.data).toEqual([600, 600, 560, 560]);
		expect(g.series.find((x) => x.key === 'Bank B')!.data).toEqual([0, 25, 25, 25]);
	});
});

describe('netTotals', () => {
	it('sums all series per date, debt subtracting', () => {
		expect(
			netTotals({
				dates: ['2026-01-01', '2026-01-02'],
				series: [
					{ key: 'checking', data: [100, 120] },
					{ key: 'card', data: [-30, -50] }
				]
			})
		).toEqual([70, 70]);
	});
});

describe('flowsByCategory', () => {
	it('sums SIGNED categorized non-internal txns per bucket - income up, spending down', () => {
		const flowTxns: Txn[] = [
			{ account_id: 'c', date: '2026-01-02', amount: -40, category: 'Dining' },
			{ account_id: 'c', date: '2026-01-03', amount: -10, category: 'Dining' },
			{ account_id: 'c', date: '2026-01-03', amount: -25, category: 'Groceries' },
			{ account_id: 'c', date: '2026-01-05', amount: -999, internal: true }, // card payment
			{ account_id: 'a', date: '2026-01-02', amount: 2750, category: 'Salary' },
			{ account_id: 'a', date: '2026-01-04', amount: -5 } // uncategorized
		];
		const s = flowsByCategory(flowTxns, '2026-01-01', '2026-01-07', 'week');
		expect(s.dates).toEqual(['2025-12-29', '2026-01-05']);
		expect(s.series[0]).toEqual({ key: 'Salary', data: [2750, 0] });
		expect(s.series[1]).toEqual({ key: 'Groceries', data: [-25, 0] });
		expect(s.series[2]).toEqual({ key: 'Dining', data: [-50, 0] });
		expect(s.series).toHaveLength(3);
	});

	it('spending mode keeps only outflows, flipped positive, under any key', () => {
		const flowTxns: Txn[] = [
			{ account_id: 'card-a', date: '2026-01-02', amount: -40, category: 'Dining' },
			{ account_id: 'card-a', date: '2026-01-03', amount: -10, category: 'Groceries' },
			{ account_id: 'check', date: '2026-01-02', amount: 2750, category: 'Salary' },
			{ account_id: 'card-a', date: '2026-01-05', amount: -999, internal: true }
		];
		const s = flowSeries(
			flowTxns,
			'2026-01-01',
			'2026-01-07',
			'week',
			(t) => t.account_id,
			'spending'
		);
		expect(s.series).toEqual([{ key: 'card-a', data: [50, 0] }]);
	});
});

describe('accumulate', () => {
	it('running-sums each series from the window start', () => {
		expect(
			accumulate({
				dates: ['d1', 'd2', 'd3'],
				series: [
					{ key: 'Dining', data: [50, 0, 25] },
					{ key: 'Salary', data: [2750, 0, 2750] }
				]
			})
		).toEqual({
			dates: ['d1', 'd2', 'd3'],
			series: [
				{ key: 'Dining', data: [50, 50, 75] },
				{ key: 'Salary', data: [2750, 2750, 5500] }
			]
		});
	});
});

describe('differentiate', () => {
	it('turns levels into per-bucket deltas, anchored on pre-window levels', () => {
		expect(
			differentiate(
				{
					dates: ['d1', 'd2', 'd3'],
					series: [{ key: 'a-check', data: [100, 160, 140] }]
				},
				new Map([['a-check', 90]])
			)
		).toEqual({
			dates: ['d1', 'd2', 'd3'],
			series: [{ key: 'a-check', data: [10, 60, -20] }]
		});
	});
});

describe('bucketize', () => {
	it('takes the CLOSING balance per bucket, never a sum', () => {
		const s = deriveBalances(txns, accounts, '2026-01-01', '2026-01-04');
		const m = bucketize(s, 'month');
		expect(m.dates).toEqual(['2026-01-01']);
		expect(m.series.find((x) => x.key === 'a-check')!.data).toEqual([60]);
	});
});

describe('flowPieces', () => {
	it('uses share dates and kinds independently of parent flags, matching the spending view', () => {
		const parent = {
			account_id: 'a-check',
			date: '2026-03-01',
			amount: -150,
			shares: [
				{ date: '2026-03-02', amount: -40, category: 'Rent', categoryKind: 'spending' as const }
			]
		};
		const rows = [
			parent,
			{ ...parent, synthetic: true },
			{ ...parent, internal: true },
			{ ...parent, excluded: true }
		];
		expect(flowPieces(rows)).toHaveLength(4);
		expect(
			flowSeries(rows, '2026-03-01', '2026-03-02', 'day', (t) => t.category, 'spending').series
		).toEqual([{ key: 'Rent', data: [0, 160] }]);
	});

	it('keeps refunds as spending reductions, income reversals as income reductions and transfers out', () => {
		const rows: Txn[] = [
			{
				account_id: 'c',
				date: '2026-03-01',
				amount: -100,
				category: 'Dining',
				categoryKind: 'spending'
			},
			{
				account_id: 'c',
				date: '2026-03-01',
				amount: 20,
				category: 'Dining',
				categoryKind: 'spending'
			},
			{
				account_id: 'c',
				date: '2026-03-01',
				amount: 500,
				category: 'Salary',
				categoryKind: 'income'
			},
			{
				account_id: 'c',
				date: '2026-03-01',
				amount: -50,
				category: 'Salary',
				categoryKind: 'income'
			},
			{
				account_id: 'c',
				date: '2026-03-01',
				amount: -1000,
				category: 'Settlement',
				categoryKind: 'transfer'
			},
			{
				account_id: 'c',
				date: '2026-03-01',
				amount: -10,
				category: 'Unsure',
				categoryKind: 'unknown'
			},
			{
				account_id: 'c',
				date: '2026-03-01',
				amount: 5,
				category: 'Unsure',
				categoryKind: 'unknown'
			}
		];
		expect(
			flowSeries(rows, '2026-03-01', '2026-03-01', 'day', (t) => t.category, 'spending').series
		).toEqual([
			{ key: 'Dining', data: [80] },
			{ key: 'Unsure', data: [10] }
		]);
		expect(
			flowSeries(rows, '2026-03-01', '2026-03-01', 'day', (t) => t.category, 'income').series
		).toEqual([
			{ key: 'Salary', data: [450] },
			{ key: 'Unsure', data: [5] }
		]);
		expect(
			flowSeries(rows, '2026-03-01', '2026-03-01', 'day', (t) => t.category).series.map(
				(s) => s.key
			)
		).not.toContain('Settlement');
	});
	it('expands a row into its shares (their category and amount), keeping the account', () => {
		const pieces = flowPieces([
			{
				account_id: 'a-check',
				date: '2026-03-01',
				amount: -150,
				shares: [
					{ amount: -40, category: 'Rent' },
					{ amount: -10, category: 'Security Deposit' }
				]
			}
		]);
		expect(pieces).toEqual([
			{
				account_id: 'a-check',
				date: '2026-03-01',
				amount: -40,
				category: 'Rent',
				shares: undefined
			},
			{
				account_id: 'a-check',
				date: '2026-03-01',
				amount: -10,
				category: 'Security Deposit',
				shares: undefined
			}
		]);
	});

	it('drops excluded rows and passes plain rows through', () => {
		const plain = { account_id: 'a-check', date: '2026-03-01', amount: -5, category: 'Dining' };
		expect(
			flowPieces([
				plain,
				{ ...plain, excluded: true },
				{ ...plain, internal: true },
				{ ...plain, synthetic: true }
			])
		).toEqual([plain]);
	});

	it('feeds flowSeries: shares replace the row in category flows, balances keep the raw amount', () => {
		const rows: Txn[] = [
			{
				account_id: 'a-check',
				date: '2026-03-01',
				amount: -150,
				shares: [{ amount: -40, category: 'Rent' }]
			},
			{ account_id: 'a-check', date: '2026-03-02', amount: 9, category: 'Cashback', excluded: true }
		];
		const flows = flowsByCategory(rows, '2026-03-01', '2026-03-02', 'day');
		expect(flows.series).toEqual([{ key: 'Rent', data: [-40, 0] }]);
		const bal = deriveBalances(rows, accounts, '2026-03-01', '2026-03-02');
		expect(bal.series.find((s) => s.key === 'a-check')?.data).toEqual([-150, -141]);
	});
});
