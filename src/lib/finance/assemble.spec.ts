import { describe, expect, it } from 'vitest';
import { assemble, type EstateTables } from './assemble';
import { deriveBalances, flowSeries } from './series';

const tables: EstateTables = {
	accounts: [
		{
			id: 'chk',
			bank: 'Bank A',
			name: 'Checking',
			type: 'checking',
			source: 'bofa',
			currency: 'USD',
			deleted_at: null
		},
		{
			id: 'old',
			bank: 'Bank A',
			name: 'Closed',
			type: 'savings',
			deleted_at: '2026-01-01T00:00:00.000Z'
		}
	],
	categories: ['Dining', 'Rent', 'Security Deposit', 'Other'].map((name, sort) => ({
		id: `category-${sort}`,
		name,
		kind: 'spending',
		icon: 'tabler:tag',
		sort
	})),
	scrape_runs: [
		{
			id: 'run-1',
			source: 'bofa',
			finished_at: '2026-02-06T00:00:00.000Z',
			status: 'ok',
			reconciled: 1,
			stated_balances: JSON.stringify({ chk: -655.98 })
		}
	],
	venmo_statement_lines: [],
	overlay: [
		{
			source: 'bofa',
			source_id: 't1',
			category: 'Dining',
			internal: 0,
			excluded: 0,
			deleted_at: null
		},
		{
			source: 'bofa',
			source_id: 't2',
			category: null,
			internal: 1,
			excluded: null,
			deleted_at: null
		},
		{ source: 'bofa', source_id: 't3', category: null, internal: 0, excluded: 0, deleted_at: null },
		{
			source: 'bofa',
			source_id: 't4',
			category: 'Other',
			internal: 0,
			excluded: 1,
			deleted_at: null
		},
		{ source: 'bofa', source_id: 't1', category: 'Wrong', deleted_at: '2026-01-01T00:00:00.000Z' }
	],
	shares: [
		{
			source: 'bofa',
			source_id: 't3',
			amount: -40,
			category: 'Rent',
			date: '2026-02-01',
			deleted_at: null
		},
		{
			source: 'bofa',
			source_id: 't3',
			amount: -10,
			category: 'Security Deposit',
			date: '2026-02-01',
			deleted_at: null
		},
		{
			source: null,
			source_id: null,
			amount: -12.5,
			category: 'Dining',
			date: '2026-02-03',
			deleted_at: null
		}
	],
	points: [
		{
			program: 'Air',
			points: 100,
			est_value: 1.5,
			scraped_at: '2026-01-01T00:00:00.000Z',
			deleted_at: null
		},
		{
			program: 'Air',
			points: 120,
			est_value: null,
			scraped_at: '2026-02-01T00:00:00.000Z',
			deleted_at: null
		},
		{
			program: 'Rail',
			points: 5,
			est_value: 0.1,
			scraped_at: '2026-02-01T00:00:00.000Z',
			deleted_at: null
		}
	],
	txns: {
		bofa: [
			{ id: 't1', account_id: 'chk', date: '2026-02-02', amount: -20, deleted_at: null },
			{ id: 't2', account_id: 'chk', date: '2026-02-01', amount: -500, deleted_at: null },
			{ id: 't3', account_id: 'chk', date: '2026-02-01', amount: -150, deleted_at: null },
			{ id: 't4', account_id: 'chk', date: '2026-02-04', amount: 14.02, deleted_at: null },
			{
				id: 'gone',
				account_id: 'chk',
				date: '2026-02-05',
				amount: 999,
				deleted_at: '2026-02-06T00:00:00.000Z'
			}
		]
	}
};

describe('assemble', () => {
	const e = assemble(tables);

	it.each([
		{ source: 'bofa', source_id: 'missing', amount: -10, category: 'Dining', date: '2026-02-01' },
		{ source: 'bofa', source_id: 't3', amount: 10, category: 'Dining', date: '2026-02-01' },
		{ source: 'bofa', source_id: 't3', amount: -151, category: 'Dining', date: '2026-02-01' },
		{ source: 'bofa', source_id: 't1', amount: -10, category: 'Dining', date: '2026-02-01' },
		{ source: null, source_id: null, amount: 0, category: 'Dining', date: '2026-02-01' }
	])('rejects orphaned, mis-signed, oversized, doubly categorized or zero shares', (share) => {
		expect(() => assemble({ ...tables, shares: [share] })).toThrow();
	});

	it('rejects aggregate shares beyond the parent amount', () => {
		const share = {
			source: 'bofa',
			source_id: 't3',
			amount: -100,
			category: 'Dining',
			date: '2026-02-01'
		};
		expect(() => assemble({ ...tables, shares: [share, share] })).toThrow();
	});

	it.each([{ id: '' }, { type: 'unknown-type' }, { source: null }])(
		'rejects missing account identity or unsupported types',
		(change) => {
			expect(() =>
				assemble({ ...tables, accounts: [{ ...tables.accounts[0], ...change }] })
			).toThrow();
		}
	);

	it('rejects duplicate accounts and transaction identities', () => {
		expect(() =>
			assemble({ ...tables, accounts: [tables.accounts[0], tables.accounts[0]] })
		).toThrow();
		expect(() =>
			assemble({
				...tables,
				shares: [],
				txns: { bofa: [tables.txns.bofa[0], tables.txns.bofa[0]] }
			})
		).toThrow();
	});

	it.each([
		{ destination: 'Venmo balance', effect: 5, status: 'verified' },
		{ destination: 'External bank', effect: 0, status: 'verified' },
		{ destination: null, effect: null, status: 'unverified' }
	])(
		'uses refund destination rather than assuming every refund is external',
		({ destination, effect, status }) => {
			const result = assemble({
				...tables,
				shares: [],
				overlay: [],
				accounts: [
					{
						id: 'wallet',
						source: 'venmo',
						bank: 'Wallet',
						name: 'Wallet',
						type: 'p2p',
						currency: 'USD'
					}
				],
				txns: { venmo: [{ id: 'refund', account_id: 'wallet', date: '2026-02-01', amount: 5 }] },
				venmo_statement_lines: [
					{ txn_id: 'refund', type: 'Refunded transaction', amount: 5, destination }
				],
				scrape_runs: [
					{
						source: 'venmo',
						finished_at: '2026-02-06T00:00:00.000Z',
						status: 'ok',
						reconciled: 1,
						stated_balances: { wallet: effect ?? 5 }
					}
				]
			});
			expect(result.txns[0].balanceAmount).toBe(effect);
			expect(result.coverage[0].status).toBe(status);
		}
	);

	it.each(['Venmo balance', 'External bank'])(
		'nets story-feed cancellations whose original debit is absent, regardless of destination',
		(destination) => {
			const result = assemble({
				...tables,
				shares: [],
				overlay: [],
				accounts: [
					{
						id: 'wallet',
						source: 'venmo',
						bank: 'Wallet',
						name: 'Wallet',
						type: 'p2p',
						currency: 'USD'
					}
				],
				txns: { venmo: [{ id: 'refund', account_id: 'wallet', date: '2026-02-01', amount: 5 }] },
				venmo_statement_lines: [
					{ txn_id: 'refund', type: 'Refunded transaction', amount: -5, destination }
				],
				scrape_runs: [
					{
						source: 'venmo',
						finished_at: '2026-02-06T00:00:00.000Z',
						status: 'ok',
						reconciled: 1,
						stated_balances: { wallet: 0 }
					}
				]
			});
			expect(result.txns[0].balanceAmount).toBe(0);
			expect(result.coverage[0].status).toBe('verified');
		}
	);

	it('keeps live accounts only', () => {
		expect(e.accounts).toEqual([
			{
				id: 'chk',
				bank: 'Bank A',
				name: 'Checking',
				type: 'checking',
				source: 'bofa',
				currency: 'USD'
			}
		]);
	});

	it('applies the live overlay: category, internal, excluded; drops deleted rows', () => {
		const by = new Map(e.txns.filter((t) => !t.standalone).map((t) => [t.amount, t]));
		expect(by.get(-20)).toMatchObject({ category: 'Dining', date: '2026-02-02' });
		expect(by.get(-20)?.internal).toBe(false);
		expect(by.get(-500)).toMatchObject({ internal: true });
		expect(by.get(-500)?.category).toBeUndefined();
		expect(by.get(14.02)).toMatchObject({ category: 'Other', excluded: true });
		expect(by.has(999)).toBe(false);
	});

	it('attaches shares to their parent and keeps the raw amount for balances', () => {
		const t3 = e.txns.find((t) => t.amount === -150)!;
		expect(t3.category).toBeUndefined();
		expect(t3.shares).toEqual([
			{ date: '2026-02-01', amount: -40, category: 'Rent', categoryKind: 'spending' },
			{ date: '2026-02-01', amount: -10, category: 'Security Deposit', categoryKind: 'spending' }
		]);
	});

	it('turns a standalone share (a friend paid) into a flow-only row with no account', () => {
		const s = e.txns.find((t) => t.standalone)!;
		expect(s).toMatchObject({
			account_id: null,
			date: '2026-02-03',
			amount: -12.5,
			category: 'Dining',
			balanceAmount: null
		});
	});

	it('sorts bank rows by date', () => {
		const dates = e.txns.filter((t) => !t.standalone).map((t) => t.date);
		expect(dates).toEqual([...dates].sort());
	});

	it('preserves points history and timestamps without inventing missing value estimates', () => {
		expect(e.points).toEqual([
			{ program: 'Air', points: 100, estValue: 1.5, scrapedAt: '2026-01-01T00:00:00.000Z' },
			{ program: 'Air', points: 120, estValue: null, scrapedAt: '2026-02-01T00:00:00.000Z' },
			{ program: 'Rail', points: 5, estValue: 0.1, scrapedAt: '2026-02-01T00:00:00.000Z' }
		]);
	});

	it.each([null, undefined, '', 'not-a-date', '2026-02-01', '2026-02-30T00:00:00.000Z'])(
		'rejects invalid points timestamps',
		(scraped_at) => {
			expect(() =>
				assemble({ ...tables, points: [{ ...tables.points[0], scraped_at }] })
			).toThrow();
		}
	);

	it('normalizes points timestamps with an explicit timezone to UTC', () => {
		const result = assemble({
			...tables,
			points: [{ ...tables.points[0], scraped_at: '2026-02-01T00:00:00-05:00' }]
		});
		expect(result.points[0].scrapedAt).toBe('2026-02-01T05:00:00.000Z');
	});

	it('verifies the actual ledger against its gate and does not expose stated balances', () => {
		expect(e.coverage).toEqual([
			{
				account_id: 'chk',
				status: 'verified',
				basis: 'money',
				asOf: '2026-02-06T00:00:00.000Z',
				firstTransaction: '2026-02-01',
				lastTransaction: '2026-02-04',
				transactionCount: 4,
				reasons: []
			}
		]);
		expect(JSON.stringify(e)).not.toContain('stated_balances');
		expect(e.txns.find((t) => t.source_id === 't1')).toMatchObject({
			balanceAmount: -20,
			synthetic: false,
			categoryKind: 'spending'
		});
	});

	it('does not trust a successful run when the ledger disagrees or its gate is missing', () => {
		for (const stated of [{ chk: 100 }, {}, { chk: null }, { chk: '0' }]) {
			const result = assemble({
				...tables,
				scrape_runs: [{ ...tables.scrape_runs[0], stated_balances: JSON.stringify(stated) }]
			});
			expect(result.coverage[0].status).toBe('unverified');
			expect(result.coverage[0].reasons.length).toBeGreaterThan(0);
			expect(
				deriveBalances(result.txns, result.accounts, '2026-02-01', '2026-02-06', result.coverage)
					.series
			).toEqual([]);
		}
	});

	it('uses the latest live run even when it fails after an older successful run', () => {
		const result = assemble({
			...tables,
			scrape_runs: [
				...tables.scrape_runs,
				{
					...tables.scrape_runs[0],
					id: 'run-2',
					finished_at: '2026-02-07T00:00:00.000Z',
					status: 'failed',
					reconciled: 0
				},
				{
					...tables.scrape_runs[0],
					id: 'deleted',
					finished_at: '2026-02-08T00:00:00.000Z',
					deleted_at: '2026-02-08T00:00:00.000Z'
				}
			]
		});
		expect(result.coverage[0]).toMatchObject({
			status: 'unverified',
			asOf: '2026-02-07T00:00:00.000Z'
		});
	});

	it('keeps missing accounts and unit-gated investments unavailable', () => {
		const result = assemble({
			...tables,
			overlay: [],
			shares: [],
			accounts: [
				{
					id: 'empty',
					source: 'bofa',
					bank: 'Bank A',
					name: 'Savings',
					type: 'savings',
					currency: 'USD'
				},
				{
					id: 'retirement',
					source: 'fidelity',
					bank: 'Bank B',
					name: 'Retirement',
					type: '401k',
					currency: 'USD'
				}
			],
			txns: {
				bofa: [],
				fidelity: [
					{
						id: 'contribution',
						account_id: 'retirement',
						date: '2026-02-01',
						amount: 200,
						qty: 2,
						ticker: 'FUND'
					}
				]
			},
			scrape_runs: [
				{
					source: 'fidelity',
					finished_at: '2026-02-06T00:00:00.000Z',
					status: 'ok',
					reconciled: 1,
					stated_balances: JSON.stringify({ units: { retirement: { FUND: 2.001 } } })
				}
			]
		});
		expect(result.coverage.map((c) => [c.status, c.basis])).toEqual([
			['missing', 'none'],
			['investment-unvalued', 'units']
		]);
		expect(result.txns[0]).toMatchObject({ amount: 200, balanceAmount: null });
		expect(result.coverage[1].reasons).toHaveLength(1);
		expect(
			deriveBalances(result.txns, result.accounts, '2026-02-01', '2026-02-06', result.coverage)
				.series
		).toEqual([]);
	});

	it.each([null, undefined, '', '  ', 'NaN', 'Infinity', '0x10', false, [], {}, NaN, Infinity])(
		'rejects invalid money instead of inventing zero: %j',
		(amount) => {
			expect(() =>
				assemble({ ...tables, txns: { bofa: [{ ...tables.txns.bofa[0], amount }] } })
			).toThrow();
		}
	);

	it('accepts finite decimal strings and genuine zero cash legs', () => {
		const result = assemble({
			...tables,
			shares: [],
			txns: {
				bofa: [
					{ ...tables.txns.bofa[0], amount: '-20.25' },
					{ ...tables.txns.bofa[1], amount: 0, qty: 2 }
				]
			}
		});
		expect(result.txns.map((t) => t.amount).sort((a, b) => a - b)).toEqual([-20.25, 0]);
	});

	it('uses share dates and excludes synthetic rows in assembled flows', () => {
		const result = assemble({
			...tables,
			txns: { bofa: tables.txns.bofa.map((t) => ({ ...t, synthetic: t.id === 't1' ? 1 : 0 })) },
			shares: tables.shares.map((s) => ({ ...s, date: '2026-03-01' }))
		});
		const flows = flowSeries(
			result.txns,
			'2026-03-01',
			'2026-03-01',
			'day',
			(t) => t.category,
			'spending'
		);
		expect(flows.series).toEqual([
			{ key: 'Rent', data: [40] },
			{ key: 'Dining', data: [12.5] },
			{ key: 'Security Deposit', data: [10] }
		]);
		expect(
			flowSeries(result.txns, '2026-02-02', '2026-02-02', 'day', (t) => t.category).series
		).toEqual([]);
	});

	it('adjusts Venmo balances from statement evidence while keeping externally funded spending', () => {
		const result = assemble({
			...tables,
			shares: [],
			accounts: [
				{
					id: 'wallet',
					source: 'venmo',
					bank: 'Wallet',
					name: 'Wallet',
					type: 'p2p',
					currency: 'USD'
				}
			],
			overlay: [{ source: 'venmo', source_id: 'external', category: 'Dining' }],
			txns: {
				venmo: [
					{ id: 'opening', account_id: 'wallet', date: '2026-01-01', amount: 100, synthetic: 1 },
					{ id: 'external', account_id: 'wallet', date: '2026-02-01', amount: -20 },
					{ id: 'refund', account_id: 'wallet', date: '2026-02-02', amount: 5 },
					{ id: 'wallet-spend', account_id: 'wallet', date: '2026-02-03', amount: -10 }
				]
			},
			venmo_statement_lines: [
				{ txn_id: 'external', type: 'Payment', amount: -20, funding_source: 'External bank' },
				// Linked statements can use opposite refund signs or show transfers net of fees.
				{
					txn_id: 'refund',
					type: 'Refunded transaction',
					amount: -5,
					destination: 'External bank'
				},
				{
					txn_id: 'wallet-spend',
					type: 'Instant Transfer',
					amount: -9.75,
					funding_source: 'Venmo balance'
				}
			],
			scrape_runs: [
				{
					source: 'venmo',
					finished_at: '2026-02-06T00:00:00.000Z',
					status: 'ok',
					reconciled: 1,
					stated_balances: { wallet: 90 }
				}
			]
		});
		expect(result.txns.map((t) => t.balanceAmount)).toEqual([100, 0, 0, -10]);
		expect(result.coverage[0].status).toBe('verified');
		expect(
			deriveBalances(result.txns, result.accounts, '2026-02-03', '2026-02-03', result.coverage)
				.series
		).toEqual([{ key: 'wallet', data: [90] }]);
		expect(
			flowSeries(result.txns, '2026-02-01', '2026-02-03', 'day', (t) => t.category, 'spending')
				.series
		).toEqual([{ key: 'Dining', data: [20, 0, 0] }]);
	});

	it('does not verify a Venmo balance without funding evidence even if naive summation matches', () => {
		const result = assemble({
			...tables,
			shares: [],
			overlay: [],
			accounts: [
				{
					id: 'wallet',
					source: 'venmo',
					bank: 'Wallet',
					name: 'Wallet',
					type: 'p2p',
					currency: 'USD'
				}
			],
			txns: { venmo: [{ id: 'unmatched', account_id: 'wallet', date: '2026-02-01', amount: -20 }] },
			scrape_runs: [
				{
					source: 'venmo',
					finished_at: '2026-02-06T00:00:00.000Z',
					status: 'ok',
					reconciled: 1,
					stated_balances: { wallet: -20 }
				}
			]
		});
		expect(result.coverage[0].status).toBe('unverified');
		expect(result.txns[0].balanceAmount).toBeNull();
	});
});
