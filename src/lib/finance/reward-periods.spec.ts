import { describe, expect, it } from 'vitest';
import { spendKind, statementEarnings, type LedgerRow, type PeriodEvent } from './reward-periods';

const txn = (patch: Partial<LedgerRow> = {}): LedgerRow => ({
	account_id: 'card',
	date: '2030-01-10',
	posted_date: '2030-01-10',
	amount: -100,
	name: 'SHOP',
	bank_category: null,
	category: 'Groceries',
	internal: false,
	...patch
});
const period = (patch: Partial<PeriodEvent> = {}): PeriodEvent => ({
	id: 'p1',
	component_id: 'c',
	event_key: 'p1',
	kind: 'earn',
	state: 'posted',
	event_date: '2030-01-22',
	units_delta: '2',
	supersedes_id: null,
	period_start: '2029-12-23',
	period_end_exclusive: '2030-01-23',
	details: {
		base_bonus: [
			{ kind: 'base', units: '1.2', native_label: 'Base' },
			{ kind: 'bonus', units: '0.8', native_label: 'Bonus' }
		]
	},
	...patch
});

describe('spendKind', () => {
	it('separates purchases from payments, reward credits, fees, cash advances and refunds', () => {
		expect(spendKind(txn())).toBe('purchase');
		expect(spendKind(txn({ amount: 25, internal: true, category: 'Transfer' }))).toBe('payment');
		expect(spendKind(txn({ amount: 30, category: 'Cashback' }))).toBe('reward');
		expect(spendKind(txn({ amount: 67, category: 'Transfer' }))).toBe('reward');
		expect(spendKind(txn({ amount: -0.2, bank_category: 'Finance: Service Charges/Fees' }))).toBe(
			'fee'
		);
		// Statement-PDF rows carry no bank label: the issuer's own fee wording identifies them.
		expect(spendKind(txn({ amount: -0.4, name: 'FOREIGN TRANSACTION FEE' }))).toBe('fee');
		expect(spendKind(txn({ amount: -0.1, name: 'INTEREST CHARGED ON BANK CASH ADVANCES' }))).toBe(
			'fee'
		);
		expect(spendKind(txn({ amount: -9.75, name: 'ATM - TRANSACTION FEE' }))).toBe('fee');
		// A merchant whose name contains "FEE" is still a purchase.
		expect(spendKind(txn({ amount: -7, name: 'LYFT   *CANCEL FEE' }))).toBe('purchase');
		expect(spendKind(txn({ category: 'Cash & ATM' }))).toBe('cash_advance');
		expect(spendKind(txn({ bank_category: 'Cash, Checks & Misc: ATM/Cash Withdrawals' }))).toBe(
			'cash_advance'
		);
		expect(spendKind(txn({ amount: 12, category: 'Dining' }))).toBe('refund');
	});
});

describe('statementEarnings', () => {
	it('rates observed period earnings against net posted purchases in the statement window', () => {
		const result = statementEarnings(
			[period()],
			[
				txn({ amount: -60 }),
				txn({ amount: -60, posted_date: '2029-12-23', date: '2029-12-20' }),
				txn({ amount: 20, category: 'Dining' }),
				txn({ amount: 500, internal: true, category: 'Transfer' }),
				txn({ amount: -1, name: 'FOREIGN TRANSACTION FEE' }),
				txn({ amount: 5, category: 'Cashback' })
			]
		);
		expect(result.status).toBe('available');
		expect(result.periods).toEqual([
			{
				id: 'p1',
				start: '2029-12-23',
				endExclusive: '2030-01-23',
				closing: '2030-01-22',
				earned: '2',
				parts: { base: '1.2', bonus: '0.8', other: null },
				spend: '100',
				rate: '0.02',
				reason: null
			}
		]);
		expect(result.t12m).toEqual({
			earned: '2',
			ratedEarned: '2',
			spend: '100',
			rate: '0.02',
			periods: 1,
			unrated: 0,
			from: '2029-12-23',
			to: '2030-01-22'
		});
		expect(result.asOf).toBe('2030-01-22');
	});

	it('windows by posting date: the first day counts, the exclusive end does not', () => {
		const result = statementEarnings(
			[period()],
			[
				txn({ amount: -50, posted_date: '2029-12-23' }),
				txn({ amount: -999, posted_date: '2030-01-23', date: '2030-01-21' }),
				txn({ amount: -999, posted_date: '2029-12-22' }),
				// Without a posting date the transaction date stands in.
				txn({ amount: -50, posted_date: null, date: '2030-01-22' })
			]
		);
		expect(result.periods[0].spend).toBe('100');
	});

	it('leaves a rate unavailable when its window holds no net purchases, without hiding earnings', () => {
		const result = statementEarnings(
			[
				period(),
				period({
					id: 'p2',
					event_key: 'p2',
					event_date: '2030-02-22',
					period_start: '2030-01-23',
					period_end_exclusive: '2030-02-23',
					units_delta: '5'
				})
			],
			[txn({ amount: -100 }), txn({ amount: 40, posted_date: '2030-02-01', category: 'Dining' })]
		);
		expect(result.periods[1]).toMatchObject({
			earned: '5',
			spend: '-40',
			rate: null,
			reason: 'No net posted purchases in this statement window.'
		});
		expect(result.t12m).toMatchObject({
			earned: '7',
			spend: '100',
			rate: '0.02',
			periods: 2,
			unrated: 1
		});
	});

	it('keeps only the twelve months up to the latest statement in the trailing figures', () => {
		const old = period({
			id: 'old',
			event_key: 'old',
			event_date: '2029-01-22',
			period_start: '2028-12-23',
			period_end_exclusive: '2029-01-23',
			units_delta: '50'
		});
		const edge = period({
			id: 'edge',
			event_key: 'edge',
			event_date: '2029-01-23',
			period_start: '2029-01-23',
			period_end_exclusive: '2029-01-24',
			units_delta: '1',
			details: { base_bonus: [{ kind: 'other', units: '1', native_label: 'Earned' }] }
		});
		const result = statementEarnings(
			[old, edge, period()],
			[
				txn({ posted_date: '2029-01-10', amount: -1000 }),
				txn({ posted_date: '2029-01-23', amount: -100 }),
				txn()
			]
		);
		expect(result.t12m).toMatchObject({
			earned: '3',
			spend: '200',
			periods: 2,
			from: '2029-01-23'
		});
		expect(result.periods.map((p) => p.id)).toEqual(['old', 'edge', 'p1']);
		expect(result.periods[1].parts).toEqual({ base: null, bonus: null, other: '1' });
	});

	it('names purchases that fall in no recorded statement period', () => {
		const result = statementEarnings(
			[
				period(),
				period({
					id: 'p3',
					event_key: 'p3',
					event_date: '2030-04-22',
					period_start: '2030-03-23',
					period_end_exclusive: '2030-04-23'
				})
			],
			[
				txn({ posted_date: '2029-12-01' }),
				txn(),
				txn({ posted_date: '2030-02-10' }),
				txn({ posted_date: '2030-04-01' }),
				txn({ posted_date: '2030-05-02' }),
				txn({ posted_date: '2030-06-02', amount: 30, internal: true })
			]
		);
		expect(result.diagnostics).toEqual([
			'Purchases before 2029-12-23 fall in no recorded statement.',
			'Purchases from 2030-01-23 to 2030-03-22 fall in no recorded statement.',
			'Purchases after 2030-04-22 have no statement earnings recorded yet.'
		]);
	});

	it('ignores pending, superseded and undated observations and needs a period to report', () => {
		expect(
			statementEarnings(
				[
					period({ state: 'pending' }),
					period({ id: 'x', event_key: 'x', period_start: null, period_end_exclusive: null })
				],
				[txn()]
			)
		).toMatchObject({
			status: 'unavailable',
			periods: [],
			t12m: null,
			asOf: null,
			diagnostics: ['No statement states earnings for this card.']
		});
		const corrected = statementEarnings(
			[period(), period({ id: 'p1b', supersedes_id: 'p1', units_delta: '3' })],
			[txn()]
		);
		expect(corrected.periods.map((p) => [p.id, p.earned, p.rate])).toEqual([['p1b', '3', '0.03']]);
	});

	it('withholds figures when correction history is uncertain', () => {
		const result = statementEarnings(
			[
				period(),
				period({ id: 'a', supersedes_id: 'p1' }),
				period({ id: 'b', supersedes_id: 'p1' })
			],
			[txn()]
		);
		expect(result).toMatchObject({
			status: 'unavailable',
			periods: [],
			diagnostics: ['Statement event history needs review.']
		});
	});

	it('nets a period whose refunds outweigh earnings without dividing a negative amount', () => {
		const result = statementEarnings(
			[period({ kind: 'adjust', units_delta: '-0.5', details: { base_bonus: [] } })],
			[txn({ amount: -10 }), txn({ amount: 30, category: 'Dining' })]
		);
		expect(result.periods[0]).toMatchObject({ earned: '-0.5', rate: null });
		// A window with exactly zero net purchases has no rate either.
		expect(statementEarnings([period()], [])).toMatchObject({
			periods: [{ spend: '0', rate: null }],
			t12m: { rate: null, unrated: 1 }
		});
	});
});
