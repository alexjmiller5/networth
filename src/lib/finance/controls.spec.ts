import { describe, expect, it } from 'vitest';
import {
	buildView,
	readControls,
	writeControls,
	controlParams,
	toggleHidden,
	hasControlParams,
	pointsAt
} from './controls';

const min = '2026-01-01';
const max = '2026-03-31';
const restore = (saved: string | null = null, query = '') =>
	readControls({ getItem: () => saved }, new URLSearchParams(query), min, max);
const accounts = [{ id: 'account-1', name: 'Account', bank: 'Bank', type: 'checking' as const }];
const categories = [
	{ id: 'one', name: 'Category 1', kind: 'spending' as const, icon: 'tabler:bolt', sort: 10 },
	{ id: 'two', name: 'Category 2', kind: 'spending' as const, icon: 'tabler:home', sort: 20 }
];

describe('control persistence', () => {
	it.each(['null', '[]', '{bad', '{"bucket":"bogus","hidden":{"account":4}}'])(
		'recovers corrupt save %s per field',
		(raw) => {
			expect(restore(raw)).toMatchObject({
				bucket: 'day',
				groupBy: 'account',
				kind: 'bar',
				dateStart: min,
				dateEnd: max,
				hidden: { account: [] }
			});
		}
	);
	it('applies valid URL fields over saved ones and lets an empty hide override saved hiding', () => {
		const s = restore(
			JSON.stringify({ bucket: 'month', groupBy: 'bank', hidden: { account: ['a'] } }),
			'bucket=week&group=account&hide.account=[]&preset=7D'
		);
		expect(s).toMatchObject({
			bucket: 'week',
			groupBy: 'account',
			dateStart: '2026-03-25',
			hidden: { account: [] }
		});
	});
	it('roundtrips every control and every grouping, including punctuation in series names', () => {
		const s = restore(
			null,
			'preset=custom&start=2026-01-03&end=2026-02-04&flows=income&cum=0&chart=line'
		);
		s.hidden = { account: ['a'], bank: ['A, B & C'], type: ['checking'], category: ['Category 2'] };
		expect(restore(null, controlParams(s).toString())).toEqual(s);
	});
	it('survives denied storage access and protects the saved view when following a deep link', () => {
		expect(
			readControls(
				{
					getItem: () => {
						throw new Error('blocked');
					}
				},
				new URLSearchParams(),
				min,
				max
			)
		).toEqual(restore());
		const storage = {
			setItem: () => {
				throw new Error('blocked');
			}
		};
		expect(writeControls(storage, restore(), false)).toBe(false);
		let writes = 0;
		expect(
			writeControls(
				{
					setItem: () => {
						writes++;
					}
				},
				restore(),
				true
			)
		).toBe(false);
		expect(writes).toBe(0);
		expect(
			writeControls(
				{
					setItem: () => {
						writes++;
					}
				},
				restore(),
				true,
				true
			)
		).toBe(true);
		expect(writes).toBe(1);
		expect(hasControlParams(new URLSearchParams('start=2026-01-03'))).toBe(true);
	});
	it('does not erase other grouping selections and resets hiding the last applicable series', () => {
		const s = restore();
		s.hidden.bank = ['bank-1'];
		const hidden = toggleHidden(s.hidden, 'category', 'Category 1', ['Category 1']);
		expect(hidden).toMatchObject({ bank: ['bank-1'], category: [] });
	});
});

describe('page chart view', () => {
	it('counts omitted uncategorized pieces within dates, direction and account filters, never unknown catalog categories', () => {
		const rows = [
			{ account_id: 'account-1', date: min, amount: -8 },
			{ account_id: 'account-2', date: min, amount: -4 },
			{ account_id: 'account-1', date: min, amount: 2 },
			{ account_id: 'account-1', date: '2025-12-31', amount: -2 },
			{ account_id: 'account-1', date: min, amount: -1, synthetic: true },
			{ account_id: 'account-1', date: min, amount: -1, excluded: true },
			{ account_id: 'account-1', date: min, amount: -1, internal: true },
			{
				account_id: 'account-1',
				date: min,
				amount: -1,
				category: 'Category 1',
				categoryKind: 'unknown' as const
			}
		];
		const state = restore(null, 'flows=spending&hide.account=["account-2"]');
		expect(buildView(rows, accounts, categories, state).uncategorized).toBe(1);
		state.groupBy = 'category';
		expect(buildView(rows, accounts, categories, state).uncategorized).toBe(2);
		state.flows = ['income'];
		expect(buildView(rows, accounts, categories, state).uncategorized).toBe(1);
	});
	it('counts shares and friend-paid spending under every grouping while balances stay raw', () => {
		const txns = [
			{ account_id: 'account-1', date: min, amount: 100 },
			{
				account_id: 'account-1',
				date: '2026-02-01',
				amount: -60,
				shares: [{ amount: -20, date: '2026-02-01', category: 'Category 1' }]
			},
			{ account_id: '', date: '2026-02-02', amount: -5, category: 'Category 2', standalone: true }
		];
		const s = restore(null, 'flows=spending&bucket=month');
		const view = buildView(txns, accounts, categories, s);
		expect(view.total).toBe(25);
		expect(view.keys).toContain('friend-paid');
		expect(view.applicable).toContain('account-1');
		expect(buildView(txns, accounts, categories, restore()).total).toBe(40);
		s.groupBy = 'category';
		s.hidden.category = ['Category 2'];
		expect(buildView(txns, accounts, categories, s).total).toBe(20);
		expect(buildView(txns, accounts, categories, { ...s, cumulativeChoice: true }).total).toBe(20);
	});
	it('keeps all catalog categories in canonical order, including those with no rows', () => {
		const catalog = Array.from({ length: 30 }, (_, i) => ({
			id: `c${i}`,
			name: `Category ${i}`,
			kind: 'spending' as const,
			icon: 'tabler:bolt',
			sort: i
		}));
		const s = restore(null, 'group=category&flows=spending');
		const view = buildView(
			[{ account_id: 'account-1', date: min, amount: -3, category: 'Category 29' }],
			accounts,
			catalog.reverse(),
			s
		);
		expect(view.keys).toHaveLength(30);
		expect(view.keys[0]).toBe('Category 0');
		expect(view.keys.at(-1)).toBe('Category 29');
		expect(view.applicable).toEqual(['Category 29']);
	});
	it('uses the selected closing level or the sum of displayed bucket changes for the headline', () => {
		const rows = [
			{ account_id: 'account-1', date: '2025-12-31', amount: 100 },
			{ account_id: 'account-1', date: min, amount: -10 },
			{ account_id: 'account-1', date: '2026-02-01', amount: 20 }
		];
		expect(buildView(rows, accounts, categories, restore()).total).toBe(110);
		expect(buildView(rows, accounts, categories, restore(null, 'cum=0')).total).toBe(10);
	});
	it('keeps unverified and unvalued accounts out of balance totals while preserving their filter entries', () => {
		const accts = [accounts[0], { ...accounts[0], id: 'account-2' }];
		const rows = accts.map((a) => ({ account_id: a.id, date: min, amount: 100 }));
		const coverage = [
			{
				account_id: 'account-1',
				status: 'verified' as const,
				basis: 'money' as const,
				asOf: max,
				firstTransaction: min,
				lastTransaction: max,
				transactionCount: 1,
				reasons: []
			},
			{
				account_id: 'account-2',
				status: 'investment-unvalued' as const,
				basis: 'units' as const,
				asOf: max,
				firstTransaction: min,
				lastTransaction: max,
				transactionCount: 1,
				reasons: ['No valuation']
			}
		];
		const view = buildView(rows, accts, categories, restore(), coverage);
		expect(view.total).toBe(100);
		expect(view.keys).toEqual(['account-1', 'account-2']);
		expect(view.applicable).toEqual(['account-1']);
	});
	it('keeps valid zero balances selectable', () => {
		const rows = [
			{ account_id: 'account-1', date: min, amount: 100 },
			{ account_id: 'account-1', date: min, amount: -100 }
		];
		expect(buildView(rows, accounts, categories, restore()).applicable).toEqual(['account-1']);
	});
	it('shows only the most recent points snapshot no later than the selected date, without inventing a value', () => {
		const rows = [
			{ program: 'Program', points: 100, estValue: null, scrapedAt: '2026-01-02T12:00:00Z' },
			{ program: 'Program', points: 200, estValue: 2, scrapedAt: '2026-03-01T12:00:00Z' }
		];
		expect(pointsAt(rows, '2026-02-01')).toEqual([rows[0]]);
		expect(pointsAt(rows, '2026-01-01')).toEqual([]);
	});
});
