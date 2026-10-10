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

it('filters open, closed, or both across the chart, overview, groupings, and totals', () => {
	const registry = [...accounts, { ...accounts[0], id: 'closed', closed: true }];
	const rows = [
		{ account_id: 'account-1', date: min, amount: 100 },
		{ account_id: 'account-1', date: max, amount: -30, category: 'Category 1' },
		{ account_id: 'closed', date: max, amount: -10, category: 'Category 1' }
	];
	for (const presentation of ['chart', 'overview'] as const) {
		for (const [accountStatuses, spending, balance] of [
			[['open'], 30, 70],
			[['closed'], 10, -10],
			[['open', 'closed'], 40, 60]
		] as const) {
			const s = state({
				presentation,
				accountStatuses: [...accountStatuses],
				cumulativeChoice: true
			});
			expect(buildView(rows, registry, categories, s).total).toBe(balance);
			for (const groupBy of ['account', 'bank', 'type', 'asset', 'category'] as const) {
				const v = buildView(rows, registry, categories, {
					...s,
					groupBy,
					measure: 'activity',
					flows: ['spending']
				});
				expect(v.total).toBe(spending);
				expect(v.summary.filter((r) => r.value !== null).reduce((n, r) => n + r.value!, 0)).toBe(
					spending
				);
			}
			const v = buildView(rows, registry, categories, s);
			expect(v.keys.includes('closed')).toBe(s.accountStatuses.includes('closed'));
			expect(v.keys.includes('account-1')).toBe(s.accountStatuses.includes('open'));
		}
	}
});

it('persists status selections, migrates old saves, and recovers invalid selections', () => {
	expect(restore('{"includeClosed":false}').accountStatuses).toEqual(['open']);
	expect(restore('{"includeClosed":true}').accountStatuses).toEqual(['open', 'closed']);
	for (const saved of ['{}', '{"accountStatuses":[]}', '{"accountStatuses":["invalid"]}']) {
		expect(restore(saved).accountStatuses).toEqual(['open', 'closed']);
	}
	let saved = '';
	const s = state({ accountStatuses: ['closed'] });
	writeControls(
		{
			setItem: (_key, value) => {
				saved = value;
			}
		},
		s
	);
	expect(restore(saved).accountStatuses).toEqual(['closed']);
});

it('separates internal transfers from activity while showing allocation changes in balances', () => {
	const registry = [
		accounts[0],
		{ id: 'invest', name: 'Portfolio', bank: 'Broker', type: 'brokerage' as const }
	];
	const rows = [
		{ account_id: 'account-1', date: min, amount: 100, synthetic: true },
		{ account_id: 'account-1', date: max, amount: -40, internal: true, category: 'Transfer' },
		{ account_id: 'invest', date: max, amount: 40, internal: true, category: 'Transfer' },
		{ account_id: 'account-1', date: max, amount: -5, category: 'Category 1' },
		{
			account_id: 'account-1',
			date: max,
			amount: 10,
			category: 'Income',
			categoryKind: 'income' as const
		}
	];
	const balances = state({ measure: 'balances', groupBy: 'asset' });
	expect(buildView(rows, registry, categories, balances).summary).toEqual([
		{ key: 'cash', value: 65 },
		{ key: 'investments', value: 40 }
	]);
	for (const groupBy of ['account', 'bank', 'type', 'asset', 'category'] as const) {
		const activity = state({ measure: 'activity', groupBy });
		expect(buildView(rows, registry, categories, activity).total).toBe(5);
		for (const assetClasses of [['cash'], ['investments'], ['cash', 'investments']] as const) {
			const s = { ...activity, assetClassFilter: [...assetClasses] };
			expect(buildView(rows, registry, categories, s).total).toBe(
				assetClasses.some((c) => c === 'cash') ? 5 : 0
			);
		}
	}
	expect(
		buildView(rows, registry, categories, { ...balances, assetClassFilter: ['cash'] }).total
	).toBe(65);
	expect(
		buildView(rows, registry, categories, { ...balances, assetClassFilter: ['investments'] }).total
	).toBe(40);
	expect(buildView(rows, registry, categories, balances).total).toBe(105);
	const missing = [
		{
			account_id: 'invest',
			status: 'investment-unvalued' as const,
			basis: 'none' as const,
			asOf: null,
			firstTransaction: max,
			lastTransaction: max,
			transactionCount: 1,
			reasons: ['Missing prices']
		}
	];
	expect(
		buildView(
			rows,
			registry,
			categories,
			{ ...balances, assetClassFilter: ['investments'] },
			missing
		).summary
	).toEqual([{ key: 'investments', value: null }]);
});

it('persists asset filters and restores the previous balance or activity interpretation', () => {
	expect(restore().measure).toBe('balances');
	expect(state({ flows: ['spending'] }).measure).toBe('activity');
	expect(state({ groupBy: 'category' }).measure).toBe('activity');
	expect(state({ assetClassFilter: [] }).assetClassFilter).toEqual([
		'cash',
		'investments',
		'deposits'
	]);
	const s = state({ measure: 'activity', assetClassFilter: ['investments'], groupBy: 'asset' });
	let saved = '';
	writeControls(
		{
			setItem: (_key, value) => {
				saved = value;
			}
		},
		s
	);
	expect(restore(saved)).toEqual(s);
});

it('filters bank ledgers separately from stored value, and preserves the selection', () => {
	const registry = [...accounts, { ...accounts[0], id: 'wallet', type: 'stored_value' as const }];
	const rows = registry.map((a) => ({ account_id: a.id, date: min, amount: 10 }));
	for (const [balanceSources, ids] of [
		[['accounts'], ['account-1']],
		[['rewards'], ['wallet']],
		[
			['accounts', 'rewards'],
			['account-1', 'wallet']
		]
	] as const) {
		const s = state({ balanceSources: [...balanceSources] });
		const view = buildView(rows, registry, categories, s);
		expect(view.accountIds).toEqual([...ids]);
		expect(view.total).toBe(ids.length * 10);
		let saved = '';
		writeControls(
			{
				setItem: (_key, value) => {
					saved = value;
				}
			},
			s
		);
		expect(restore(saved).balanceSources).toEqual([...balanceSources]);
	}
});

it('shows refundable deposits as their own asset class, outside activity and coverage', () => {
	const registry = [
		accounts[0],
		{ id: 'dep', name: 'Deposit', bank: 'Deposit', type: 'security_deposit' as const }
	];
	const rows = [
		{ account_id: 'account-1', date: min, amount: 100 },
		{ account_id: 'account-1', date: '2026-02-01', amount: -60, category: 'Category 1' },
		{ account_id: 'dep', date: '2026-02-01', amount: 60, internal: true },
		{ account_id: 'dep', date: '2026-03-01', amount: -60, internal: true },
		{ account_id: 'account-1', date: '2026-03-01', amount: 60, category: 'Category 1' }
	];
	const coverage = [
		{
			account_id: 'account-1',
			status: 'verified' as const,
			basis: 'money' as const,
			asOf: `${max}T00:00:00.000Z`,
			firstTransaction: min,
			lastTransaction: '2026-03-01',
			transactionCount: 3,
			reasons: []
		}
	];
	const at = (dateEnd: string, extra = {}) =>
		buildView(
			rows,
			registry,
			categories,
			state({
				presentation: 'overview',
				groupBy: 'asset',
				activePreset: '',
				dateStart: min,
				dateEnd,
				...extra
			}),
			coverage
		);
	expect(at('2026-02-15').summary).toEqual([
		{ key: 'cash', value: 40 },
		{ key: 'deposits', value: 60 }
	]);
	expect(at('2026-02-15').total).toBe(100);
	expect(at(max).summary).toEqual([
		{ key: 'cash', value: 100 },
		{ key: 'deposits', value: 0 }
	]);
	const cashOnly = at('2026-02-15', { assetClassFilter: ['cash', 'investments'] });
	expect(cashOnly.keys).toEqual(['cash']);
	expect(cashOnly.total).toBe(40);
	const activity = at(max, { measure: 'activity', flows: ['spending'] });
	expect(activity.applicable).toEqual(['cash']);
	expect(activity.uncategorized).toBe(0);
});

it('adds Deposits to legacy saves that selected every asset class, keeping narrowed ones', () => {
	expect(restore('{"assetClasses":["cash","investments"]}').assetClassFilter).toEqual([
		'cash',
		'investments',
		'deposits'
	]);
	expect(restore('{"assetClasses":["cash"]}').assetClassFilter).toEqual(['cash']);
	expect(restore('{}').assetClassFilter).toEqual(['cash', 'investments', 'deposits']);
	expect(state({ assetClassFilter: ['cash', 'investments'] }).assetClassFilter).toEqual([
		'cash',
		'investments'
	]);
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

it('never calls a subtotal verified when it includes a carried plan NAV', () => {
	const plan = { id: 'plan', name: '401(k)', bank: 'Plan', type: '401k' as const };
	const valuation = (carried: boolean) => ({
		account_id: 'plan',
		start: max,
		end: max,
		values: [100],
		priceDates: [max],
		carried: [carried],
		gaps: []
	});
	const s = state({ measure: 'balances', activePreset: '', dateStart: min, dateEnd: max });
	const rows = [
		{ account_id: 'plan', date: max, amount: 100, qty: 1, ticker: 'FUND' },
		{ account_id: 'account-1', date: max, amount: 5 }
	];
	const view = (carried: boolean, hidden: string[] = []) =>
		buildView(
			rows,
			[plan, ...accounts],
			categories,
			{ ...s, hidden: { ...s.hidden, account: hidden } },
			[
				{
					account_id: 'account-1',
					status: 'verified',
					basis: 'money',
					asOf: max,
					firstTransaction: max,
					lastTransaction: max,
					transactionCount: 1,
					reasons: []
				}
			],
			[valuation(carried)]
		);
	expect(view(false).title).toBe('Verified balance subtotal');
	expect(view(true).title).toBe('Balance subtotal with carried NAV');
	expect(view(true).total).toBe(105);
	expect(view(true, ['plan']).title).toBe('Verified balance subtotal');
});

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
				hidden: { account: ['a'], bank: [], type: [], asset: [], category: [] }
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
		s.hidden = {
			account: ['a'],
			bank: ['A, B & C'],
			type: ['checking'],
			asset: [],
			category: ['Category 2']
		};
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
		const registry = [...accounts, { ...accounts[0], id: 'account-2' }];
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
			hidden: { account: ['account-2'], bank: [], type: [], asset: [], category: [] }
		});
		expect(buildView(rows, registry, categories, selection).uncategorized).toBe(1);
		selection.groupBy = 'category';
		expect(buildView(rows, registry, categories, selection).uncategorized).toBe(2);
		selection.flows = ['income'];
		expect(buildView(rows, registry, categories, selection).uncategorized).toBe(1);
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
	it('shows points-paid spending as its own rewards series and only with rewards selected', () => {
		const txns = [
			{ account_id: 'account-1', date: min, amount: 100 },
			{
				account_id: null,
				date: '2026-02-02',
				amount: -65.66,
				category: 'Category 1',
				standalone: true,
				fundedBy: 'points'
			}
		];
		const s = state({ flows: ['spending'], bucket: 'month' });
		const view = buildView(txns, accounts, categories, s);
		expect(view.keys).toContain('rewards-paid');
		expect(view.keys).not.toContain('friend-paid');
		expect(view.total).toBe(65.66);
		expect(
			buildView(txns, accounts, categories, { ...s, balanceSources: ['accounts'] }).total
		).toBe(0);
		expect(buildView(txns, accounts, categories, restore()).total).toBe(100);
		s.groupBy = 'category';
		expect(buildView(txns, accounts, categories, s).summary).toContainEqual({
			key: 'Category 1',
			value: 65.66
		});
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

it('shows verified closed zero only in current balance overview, never backfills chart history', () => {
	const registry = [
		{
			id: 'closed-investment',
			name: 'Closed investment',
			bank: 'Example',
			type: 'brokerage' as const,
			closed: true
		}
	];
	const coverage = [
		{
			account_id: 'closed-investment',
			status: 'verified-closed-zero' as const,
			basis: 'money' as const,
			currentBalance: 0 as const,
			asOf: '2026-01-03T00:00:00.000Z',
			firstTransaction: '2026-01-01',
			lastTransaction: '2026-01-02',
			transactionCount: 2,
			reasons: []
		}
	];
	const current = state({
		presentation: 'overview',
		dateStart: '2026-01-01',
		dateEnd: '2026-01-03'
	});
	expect(buildView([], registry, [], current, coverage).summary).toEqual([
		{ key: 'closed-investment', value: 0 }
	]);
	for (const patch of [
		{ presentation: 'chart' as const },
		{ dateEnd: '2026-01-02' },
		{ measure: 'activity' as const }
	]) {
		const v = buildView([], registry, [], { ...current, ...patch }, coverage);
		expect(v.data.series).toEqual([]);
		expect(v.summary[0].value).toBeNull();
	}
});

it('allows hiding cash while keeping a verified closed zero visible in Overview', () => {
	const registry = [
		...accounts,
		{
			id: 'closed',
			name: 'Closed investment',
			bank: 'Example',
			type: 'brokerage' as const,
			closed: true
		}
	];
	const coverage = [
		{
			account_id: 'account-1',
			status: 'verified' as const,
			basis: 'money' as const,
			asOf: max,
			firstTransaction: min,
			lastTransaction: min,
			transactionCount: 1,
			reasons: []
		},
		{
			account_id: 'closed',
			status: 'verified-closed-zero' as const,
			currentBalance: 0 as const,
			basis: 'money' as const,
			asOf: max,
			firstTransaction: min,
			lastTransaction: min,
			transactionCount: 1,
			reasons: []
		}
	];
	const current = state({ presentation: 'overview' });
	const v = buildView(
		[{ account_id: 'account-1', date: min, amount: 100 }],
		registry,
		[],
		current,
		coverage
	);
	expect(v.applicable).toContain('closed');
	expect(toggleHidden(current.hidden, 'account', 'account-1', v.applicable).account).toEqual([
		'account-1'
	]);
});

it('persists local amount concealment independently of filters and restores it before display', () => {
	expect(restore().hideAmounts).toBe(false);
	const c = state({ hideAmounts: true, accountStatuses: ['closed'] });
	let saved = '';
	writeControls(
		{
			setItem: (_key, value) => {
				saved = value;
			}
		},
		c
	);
	expect(restore(saved)).toMatchObject({ hideAmounts: true, accountStatuses: ['closed'] });
	expect(restore('{"hideAmounts":"true"}').hideAmounts).toBe(false);
});

describe('initial date horizon', () => {
	it('starts at 90 days while retaining an explicit saved longer preset', () => {
		const fresh = readControls(undefined, '2020-01-01', '2026-10-06');
		expect([fresh.activePreset, fresh.dateStart, fresh.dateEnd]).toEqual([
			'90D',
			'2026-07-09',
			'2026-10-06'
		]);
		const saved = readControls(
			{ getItem: () => JSON.stringify({ activePreset: 'ALL', bucket: 'month' }) },
			'2020-01-01',
			'2026-10-06'
		);
		expect([saved.activePreset, saved.dateStart, saved.bucket]).toEqual([
			'ALL',
			'2020-01-01',
			'month'
		]);
	});
});
