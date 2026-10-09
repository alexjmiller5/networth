import { describe, expect, it } from 'vitest';
import { assemble, type EstateTables } from './assemble';
import { deriveBalances, flowSeries } from './series';

it('reads closed status and effective names from account metadata, rejecting invalid timelines', () => {
	const t = structuredClone(tables);
	t.accounts[0].is_closed = 1;
	t.accounts[0].name_history = '[{"name":"Prior name","until":"2026-02-10"}]';
	expect(assemble(t).accounts[0]).toMatchObject({
		closed: true,
		nameHistory: [{ name: 'Prior name', until: '2026-02-10' }]
	});
	t.accounts[0].name_history = '[{"name":"Prior name","until":"2026-02-30"}]';
	expect(() => assemble(t)).toThrow('Invalid finance date');
	t.accounts[0].name_history =
		'[{"name":"One","until":"2026-03-01"},{"name":"Two","until":"2026-02-01"}]';
	expect(() => assemble(t)).toThrow('Invalid account name history');
});

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
				currency: 'USD',
				closed: false,
				nameHistory: [],
				logo: undefined
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

describe('per-account checkpoints', () => {
	it('retains an account checkpoint when a newer same-source run checks only its sibling', () => {
		const result = assemble({
			...tables,
			scrape_runs: [
				...tables.scrape_runs,
				{
					...tables.scrape_runs[0],
					id: 'sibling-run',
					finished_at: '2026-02-07T00:00:00.000Z',
					stated_balances: { sibling: 0 }
				}
			]
		});
		expect(result.coverage[0]).toMatchObject({
			status: 'verified',
			asOf: '2026-02-06T00:00:00.000Z'
		});
		expect(
			deriveBalances(result.txns, result.accounts, '2026-02-06', '2026-02-07', result.coverage)
				.series[0].data
		).toEqual([-655.98, -655.98]);
	});
	it('does not attach a sibling-only checkpoint date to an account with no evidence', () => {
		const result = assemble({
			...tables,
			scrape_runs: [{ ...tables.scrape_runs[0], stated_balances: { sibling: 0 } }]
		});
		expect(result.coverage[0]).toMatchObject({ status: 'unverified', asOf: null, basis: 'none' });
	});
	it('treats an explicit newer unusable account gate as unknown rather than falling back', () => {
		const result = assemble({
			...tables,
			scrape_runs: [
				...tables.scrape_runs,
				{
					...tables.scrape_runs[0],
					finished_at: '2026-02-07T00:00:00.000Z',
					stated_balances: { chk: null }
				}
			]
		});
		expect(result.coverage[0]).toMatchObject({
			status: 'unverified',
			asOf: '2026-02-07T00:00:00.000Z'
		});
	});
	it('orders account checkpoints by actual instant across timezone offsets', () => {
		const result = assemble({
			...tables,
			scrape_runs: [
				{ ...tables.scrape_runs[0], finished_at: '2026-02-06T03:00:00.000Z' },
				{
					...tables.scrape_runs[0],
					finished_at: '2026-02-05T23:00:00-05:00',
					stated_balances: { chk: 0 }
				}
			]
		});
		expect(result.coverage[0]).toMatchObject({
			status: 'unverified',
			asOf: '2026-02-05T23:00:00-05:00'
		});
	});
});

function closedInvestment(): EstateTables {
	return {
		accounts: [
			{
				id: 'investment',
				name: 'Closed investment',
				bank: 'Example',
				type: 'brokerage',
				source: 'example',
				currency: 'USD',
				is_closed: 1
			}
		],
		overlay: [],
		shares: [],
		categories: [],
		points: [],
		venmo_statement_lines: [],
		txns: {
			example: [
				{
					id: 'purchase',
					account_id: 'investment',
					date: '2030-01-01',
					amount: -100,
					ticker: 'FUND',
					qty: 1
				},
				{
					id: 'sale',
					account_id: 'investment',
					date: '2030-01-02',
					amount: 100,
					ticker: 'FUND',
					qty: -1
				}
			]
		},
		scrape_runs: [
			{
				source: 'example',
				finished_at: '2030-01-03T00:00:00.000Z',
				status: 'ok',
				reconciled: 1,
				stated_balances: { investment: 0, units: { investment: { FUND: 0 } } }
			}
		]
	};
}
describe('verified closed investment current zero', () => {
	it('verifies cash and flat positions without inventing historical market values', () => {
		const e = assemble(closedInvestment());
		expect(e.coverage[0]).toMatchObject({
			status: 'verified-closed-zero',
			currentBalance: 0,
			asOf: '2030-01-03T00:00:00.000Z'
		});
		expect(e.txns.every((t) => t.balanceAmount === null)).toBe(true);
		expect(
			deriveBalances(e.txns, e.accounts, '2030-01-01', '2030-01-03', e.coverage).series
		).toEqual([]);
	});
	it.each([
		'open',
		'missing cash',
		'missing units',
		'cash mismatch',
		'nonzero stated cash',
		'nonzero units',
		'failed',
		'newer transaction',
		'no history',
		'malformed units'
	])('does not invent zero with %s', (reason) => {
		const t = closedInvestment();
		const gate = t.scrape_runs[0].stated_balances as Record<string, unknown>;
		if (reason === 'open') t.accounts[0].is_closed = 0;
		if (reason === 'missing cash') delete gate.investment;
		if (reason === 'missing units') delete gate.units;
		if (reason === 'nonzero stated cash') gate.investment = 1;
		if (reason === 'cash mismatch') t.txns.example[1].amount = 99;
		if (reason === 'nonzero units') gate.units = { investment: { FUND: 1 } };
		if (reason === 'failed') t.scrape_runs[0].status = 'failed';
		if (reason === 'newer transaction') t.txns.example[1].date = '2030-01-04';
		if (reason === 'no history') t.txns.example = [];
		if (reason === 'malformed units') gate.units = { investment: null };
		expect(assemble(t).coverage[0].currentBalance).toBeUndefined();
	});
	it('accepts explicit no-positions evidence only with a flat ledger and verified cash', () => {
		const t = closedInvestment();
		t.scrape_runs[0].stated_balances = { investment: 0, units: { investment: {} } };
		expect(assemble(t).coverage[0].currentBalance).toBe(0);
		t.txns.example[1].qty = 0;
		expect(assemble(t).coverage[0].currentBalance).toBeUndefined();
	});
});

it('does not verify a closed zero when quantity evidence lacks an instrument identity', () => {
	const t = closedInvestment();
	t.scrape_runs[0].stated_balances = { investment: 0, units: { investment: {} } };
	t.txns.example = [
		{ id: 'unresolved-position', account_id: 'investment', date: '2030-01-01', amount: 0, qty: 1 }
	];
	expect(assemble(t).coverage[0].currentBalance).toBeUndefined();
});

describe('noncash refundable assets', () => {
	const share = (
		id: string,
		source_id: string,
		amount: number,
		category: string,
		date: string
	) => ({
		id,
		source: 'bofa',
		source_id,
		amount,
		category,
		date,
		deleted_at: null
	});
	const event = (
		id: string,
		kind: string,
		date: string,
		amount: number,
		link: { source_id?: string; share_id?: string } = {}
	) => ({
		id,
		asset_id: 'asset-1',
		kind,
		date,
		amount,
		source: link.source_id ? 'bofa' : null,
		source_id: link.source_id ?? null,
		share_id: link.share_id ?? null,
		deleted_at: null
	});
	const evidence = (to_ref: string) => ({
		to_ref,
		from_kind: 'takeout',
		from_ref: `raw/${to_ref}`,
		deleted_at: null
	});
	const base: EstateTables = {
		...structuredClone(tables),
		categories: [
			...structuredClone(tables.categories),
			{ id: 'housing', name: 'Housing', kind: 'spending', icon: 'tabler:home', sort: 8 },
			{ id: 'sales', name: 'Sales', kind: 'income', icon: 'tabler:tag', sort: 9 }
		],
		shares: [
			share('fund-rent', 'f1', -200, 'Rent', '2026-03-01'),
			share('fund-dep', 'f1', -100, 'Housing', '2026-03-01'),
			share('back-dep', 'r1', 157, 'Housing', '2026-04-01'),
			share('back-sale', 'r1', 10, 'Sales', '2026-04-01')
		],
		overlay: [{ source: 'bofa', source_id: 'f2', category: 'Housing', internal: 0, excluded: 0 }],
		txns: {
			bofa: [
				{ id: 'f1', account_id: 'chk', date: '2026-03-01', amount: -300, deleted_at: null },
				{ id: 'f2', account_id: 'chk', date: '2026-03-02', amount: -50, deleted_at: null },
				{ id: 'r1', account_id: 'chk', date: '2026-04-01', amount: 170, deleted_at: null }
			]
		},
		assets: [
			{
				id: 'asset-1',
				kind: 'security_deposit',
				name: 'Deposit',
				currency: 'USD',
				deleted_at: null
			},
			{
				id: 'gone',
				kind: 'security_deposit',
				name: 'Old',
				currency: 'USD',
				deleted_at: '2026-01-01'
			}
		],
		asset_events: [
			event('e1', 'fund', '2026-03-01', 10000, { source_id: 'f1', share_id: 'fund-dep' }),
			event('e2', 'fund', '2026-03-02', 5000, { source_id: 'f2' }),
			event('e3', 'refund', '2026-04-01', 15000, { source_id: 'r1', share_id: 'back-dep' }),
			{ ...event('e4', 'fund', '2026-03-05', 999), deleted_at: '2026-03-06' }
		],
		asset_evidence: ['e1', 'e2', 'e3'].map(evidence)
	};
	const e = assemble(base);
	const flows = (mode: 'spending' | 'income') =>
		flowSeries(e.txns, '2026-03-01', '2026-04-01', 'month', (t) => t.category, mode).series;

	it('returns each live asset as a balance-only Deposits series, closed once fully returned', () => {
		expect(e.assets).toEqual([
			{
				id: 'asset-1',
				bank: 'Deposit',
				name: 'Deposit',
				type: 'security_deposit',
				currency: 'USD',
				closed: true
			}
		]);
		expect(e.accounts.map((a) => a.id)).not.toContain('asset-1');
		expect(e.coverage.map((c) => c.account_id)).not.toContain('asset-1');
		const ledger = e.txns.filter((t) => t.account_id === 'asset-1');
		expect(ledger.map((t) => [t.date, t.amount, t.balanceAmount, t.internal])).toEqual([
			['2026-03-01', 100, 100, true],
			['2026-03-02', 50, 50, true],
			['2026-04-01', -150, -150, true]
		]);
		const [series] = deriveBalances(e.txns, e.assets, '2026-02-28', '2026-04-02').series;
		expect(series.data.slice(0, 3)).toEqual([0, 100, 150]);
		expect(series.data.slice(-3)).toEqual([150, 0, 0]);
	});

	it('removes only linked principal from flows and leaves raw balances untouched', () => {
		expect(flows('spending')).toEqual([
			{ key: 'Rent', data: [200, 0] },
			{ key: 'Housing', data: [0, -7] }
		]);
		expect(flows('income')).toEqual([{ key: 'Sales', data: [0, 10] }]);
		const [chk] = deriveBalances(e.txns, e.accounts, '2026-04-01', '2026-04-01').series;
		expect(chk.data).toEqual([-180]);
		expect(e.txns.find((t) => t.source_id === 'f1')?.amount).toBe(-300);
	});

	it('keeps an evidenced forfeit as a balance change with no cash leg', () => {
		const t = structuredClone(base);
		t.asset_events = [
			event('e1', 'fund', '2026-03-01', 10000, { source_id: 'f1', share_id: 'fund-dep' }),
			event('lost', 'forfeit', '2026-03-09', 4000)
		];
		t.asset_evidence = ['e1', 'lost'].map(evidence);
		const out = assemble(t);
		expect(out.assets[0].closed).toBe(false);
		const ledger = out.txns.filter((r) => r.account_id === 'asset-1');
		expect(ledger.map((r) => [r.date, r.amount])).toEqual([
			['2026-03-01', 100],
			['2026-03-09', -40]
		]);
	});

	it.each([
		['missing evidence', (t: EstateTables) => (t.asset_evidence = [])],
		['refund beyond funding', (t: EstateTables) => (t.asset_events![2].amount = 15001)],
		['unknown share', (t: EstateTables) => (t.asset_events![0].share_id = 'nope')],
		['share of another row', (t: EstateTables) => (t.asset_events![0].source_id = 'r1')],
		['principal beyond its share', (t: EstateTables) => (t.asset_events![0].amount = 10001)],
		['raw link on a split row', (t: EstateTables) => (t.asset_events![0].share_id = null)],
		['missing raw row', (t: EstateTables) => (t.asset_events![1].source_id = 'nope')],
		['forfeit with a cash leg', (t: EstateTables) => (t.asset_events![1].kind = 'forfeit')],
		['unknown event kind', (t: EstateTables) => (t.asset_events![1].kind = 'interest')],
		['unknown asset kind', (t: EstateTables) => (t.assets![0].kind = 'loan')],
		['currency mismatch', (t: EstateTables) => (t.assets![0].currency = 'EUR')],
		['fractional minor units', (t: EstateTables) => (t.asset_events![1].amount = 50.5)]
	])('rejects %s', (_name, mutate) => {
		const t = structuredClone(base);
		mutate(t);
		expect(() => assemble(t)).toThrow();
	});
});

describe('points-paid consumption', () => {
	const base = (): EstateTables => ({
		...structuredClone(tables),
		reward_components: [{ id: 'rc', unit: 'points', deleted_at: null }],
		reward_events: [
			{
				id: 're',
				component_id: 'rc',
				kind: 'redeem',
				state: 'posted',
				event_date: '2026-02-03',
				supersedes_id: null,
				deleted_at: null
			}
		],
		redemption_valuations: [
			{
				id: 'rv',
				event_id: 're',
				currency: 'USD',
				reward_value: '65.66',
				category: 'Dining',
				supersedes_id: null,
				deleted_at: null
			}
		]
	});
	const paid = (t: EstateTables) => assemble(t).txns.filter((r) => r.source === 'rewards');

	it('counts a categorized redemption as points-funded spending and never as a balance', () => {
		expect(paid(base())).toEqual([
			{
				source: 'rewards',
				source_id: 'rv',
				account_id: null,
				date: '2026-02-03',
				amount: -65.66,
				balanceAmount: null,
				category: 'Dining',
				categoryKind: 'spending',
				fundedBy: 'points',
				standalone: true,
				synthetic: false,
				internal: false,
				excluded: false
			}
		]);
		const e = assemble(base());
		const plain = assemble(tables);
		expect(deriveBalances(e.txns, e.accounts, '2026-02-01', '2026-02-06')).toEqual(
			deriveBalances(plain.txns, plain.accounts, '2026-02-01', '2026-02-06')
		);
		expect(flowSeries(e.txns, '2026-02-03', '2026-02-03', 'day', (t) => t.category).series).toEqual(
			[{ key: 'Dining', data: [-78.16] }]
		);
	});

	it('skips uncategorized, retired, superseded, stale and non-dollar redemptions', () => {
		const t = base();
		t.redemption_valuations![0].category = null;
		expect(paid(t)).toEqual([]);
		for (const change of [
			(t: EstateTables) => (t.redemption_valuations![0].deleted_at = '2026-03-01T00:00:00.000Z'),
			(t: EstateTables) => (t.redemption_valuations![0].currency = 'EUR'),
			(t: EstateTables) =>
				t.reward_events!.push({ ...t.reward_events![0], id: 're2', supersedes_id: 're' }),
			(t: EstateTables) =>
				t.redemption_valuations!.push({
					...t.redemption_valuations![0],
					id: 'rv2',
					reward_value: '60',
					supersedes_id: 'rv'
				})
		]) {
			const next = base();
			change(next);
			expect(paid(next).map((r) => r.amount)).toEqual(
				next.redemption_valuations!.length > 1 ? [-60] : []
			);
		}
	});

	it('rejects a categorized redemption with an unknown category, missing event or bad money', () => {
		for (const change of [
			(t: EstateTables) => (t.redemption_valuations![0].category = 'Nope'),
			(t: EstateTables) => (t.reward_events![0].deleted_at = '2026-03-01T00:00:00.000Z'),
			(t: EstateTables) => (t.reward_events![0].kind = 'earn'),
			(t: EstateTables) => (t.redemption_valuations![0].reward_value = 'lots')
		]) {
			const t = base();
			change(t);
			expect(() => assemble(t)).toThrow();
		}
	});
});
