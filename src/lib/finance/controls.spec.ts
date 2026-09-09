import { describe, expect, it } from 'vitest';
import {
	buildView,
	readControls,
	writeControls,
	clearControlParams,
	toggleHidden,
	pointsAt
} from './controls';
import { accountLabel } from './controls';

it('labels a converted account by the dates shown without changing its identity', () => {
	const a = {
		id: 'card',
		name: 'Current card',
		bank: 'Bank',
		type: 'credit_card' as const,
		nameHistory: [{ name: 'Original card', until: '2026-02-10' }]
	};
	expect(accountLabel(a, '2026-02-09')).toBe('Original card');
	expect(accountLabel(a, '2026-02-10')).toBe('Current card');
	expect(accountLabel(a, '2026-02-01', '2026-03-01')).toBe('Original card / Current card');
});

it('keeps overview and closed-account preferences, excluding closed ledgers from every grouping', () => {
	const s = state({ presentation: 'overview', includeClosed: false, cumulativeChoice: false });
	expect(s).toMatchObject({ presentation: 'overview', includeClosed: false });
	const registry = [...accounts, { ...accounts[0], id: 'closed', closed: true }];
	const rows = [
		{ account_id: 'account-1', date: min, amount: 100 },
		{ account_id: 'account-1', date: max, amount: -30, category: 'Category 1' },
		{ account_id: 'closed', date: max, amount: -10, category: 'Category 1' }
	];
	expect(buildView(rows, registry, categories, s).total).toBe(70);
	for (const groupBy of ['account', 'bank', 'type', 'category'] as const) {
		const v = buildView(rows, registry, categories, { ...s, groupBy, flows: ['spending'] });
		expect(v.total).toBe(30);
		expect(v.summary.filter((r) => r.value !== null).reduce((n, r) => n + r.value!, 0)).toBe(30);
		expect(v.keys).not.toContain('closed');
	}
	expect(buildView(rows, registry, categories, { ...s, includeClosed: true }).total).toBe(60);
	expect(s.cumulativeChoice).toBe(false);
});

it('shows missing balances as unavailable instead of zero in the overview', () => {
	const v = buildView([], accounts, categories, state({ presentation: 'overview' }), []);
	expect(v.summary).toEqual([{ key: 'account-1', value: null }]);
});

const min = '2026-01-01';
const max = '2026-03-31';
const restore = (saved: string | null = null) => readControls({ getItem: () => saved }, min, max);
const state = (saved: Partial<ReturnType<typeof restore>>) => restore(JSON.stringify(saved));
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
	it('restores saved preferences', () => {
		expect(
			state({
				bucket: 'month',
				groupBy: 'bank',
				hidden: { account: ['a'], bank: [], type: [], category: [] }
			})
		).toMatchObject({
			bucket: 'month',
			groupBy: 'bank',
			dateStart: min,
			hidden: { account: ['a'] }
		});
	});
	it('removes every control parameter from existing links while preserving unrelated parameters', () => {
		const params = new URLSearchParams(
			'preset=7D&start=2026-01-01&end=2026-03-31&bucket=week&group=bank&chart=line&flows=spending&cum=1&hide=a&hide.account=[]&hide.bank=[]&hide.type=[]&hide.category=[]&keep=yes'
		);
		expect(clearControlParams(params).toString()).toBe('keep=yes');
		expect(params.get('preset')).toBe('7D');
		expect(clearControlParams(new URLSearchParams()).toString()).toBe('');
	});
	it('roundtrips every control and grouping through local storage', () => {
		const s = state({
			activePreset: '',
			dateStart: '2026-01-03',
			dateEnd: '2026-02-04',
			flows: ['income'],
			cumulativeChoice: false,
			kind: 'line'
		});
		s.hidden = { account: ['a'], bank: ['A, B & C'], type: ['checking'], category: ['Category 2'] };
		let saved = '';
		expect(
			writeControls(
				{
					setItem: (key, value) => {
						expect(key).toBe('networth-ui');
						saved = value;
					}
				},
				s
			)
		).toBe(true);
		expect(restore(saved)).toEqual(s);
	});
	it('reapplies a saved relative preset as new data arrives', () => {
		const saved = JSON.stringify({ activePreset: '7D', dateStart: min, dateEnd: max });
		expect(readControls({ getItem: () => saved }, min, '2026-04-05')).toMatchObject({
			activePreset: '7D',
			dateStart: '2026-03-30',
			dateEnd: '2026-04-05'
		});
	});
	it('survives denied or unavailable storage access', () => {
		expect(
			readControls(
				{
					getItem: () => {
						throw new Error('blocked');
					}
				},
				min,
				max
			)
		).toEqual(restore());
		expect(readControls(undefined, min, max)).toEqual(restore());
		expect(
			writeControls(
				{
					setItem: () => {
						throw new Error('blocked');
					}
				},
				restore()
			)
		).toBe(false);
		expect(writeControls(undefined, restore())).toBe(false);
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
		const selection = state({
			flows: ['spending'],
			hidden: { account: ['account-2'], bank: [], type: [], category: [] }
		});
		expect(buildView(rows, accounts, categories, selection).uncategorized).toBe(1);
		selection.groupBy = 'category';
		expect(buildView(rows, accounts, categories, selection).uncategorized).toBe(2);
		selection.flows = ['income'];
		expect(buildView(rows, accounts, categories, selection).uncategorized).toBe(1);
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
		const s = state({ flows: ['spending'], bucket: 'month' });
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
		const s = state({ groupBy: 'category', flows: ['spending'] });
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
		expect(buildView(rows, accounts, categories, state({ cumulativeChoice: false })).total).toBe(
			10
		);
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
