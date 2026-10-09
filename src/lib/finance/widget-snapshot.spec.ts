import { describe, expect, it } from 'vitest';
import { widgetBalances, widgetRewards } from './widget-snapshot';
import { assembleRewards } from './rewards';
import type { Account, AccountCoverage, Txn } from './types';
const account: Account = {
	id: 'card-a',
	bank: 'Example issuer',
	name: 'Example card',
	type: 'credit_card',
	currency: 'USD'
};
const coverage: AccountCoverage = {
	account_id: 'card-a',
	status: 'verified',
	basis: 'money',
	asOf: '2030-01-02T10:00:00Z',
	firstTransaction: '2030-01-01',
	lastTransaction: '2030-01-01',
	transactionCount: 1,
	reasons: []
};
const txn: Txn = { account_id: 'card-a', date: '2030-01-01', amount: -12.34 };
it('uses the existing verified balance selector, preserving each account source date and liability meaning', () => {
	const credit = { ...account, id: 'card-b', name: 'Credit card' };
	const out = widgetBalances(
		[account, credit],
		[txn, { ...txn, account_id: credit.id, amount: 2.5 }],
		[coverage, { ...coverage, account_id: credit.id, asOf: '2030-01-01T09:00:00Z' }],
		'2030-01-03'
	);
	expect(out).toEqual([
		{
			id: 'card-a',
			label: 'Example card',
			currency: 'USD',
			amount: '12.34',
			kind: 'owed',
			asOf: coverage.asOf,
			availability: 'verified'
		},
		{
			id: 'card-b',
			label: 'Credit card',
			currency: 'USD',
			amount: '2.50',
			kind: 'credit',
			asOf: '2030-01-01T09:00:00Z',
			availability: 'verified'
		}
	]);
});
it('never synthesizes a zero from missing, unverified, unit-only or undated coverage', () => {
	for (const c of [
		[],
		[{ ...coverage, status: 'unverified' as const }],
		[{ ...coverage, basis: 'units' as const }],
		[{ ...coverage, asOf: null }]
	]) {
		expect(widgetBalances([account], [txn], c, '2030-01-03')[0]).toMatchObject({
			amount: null,
			kind: 'unavailable',
			availability: 'unavailable'
		});
	}
	expect(widgetBalances([account], [], [coverage], '2030-01-03')[0].amount).toBeNull();
	expect(
		widgetBalances([{ ...account, currency: undefined }], [txn], [coverage], '2030-01-03')[0].amount
	).toBeNull();
});
it('shows evidenced zero distinctly and omits closed or noncard accounts', () => {
	expect(
		widgetBalances([account], [{ ...txn, amount: 0 }], [coverage], '2030-01-03')[0]
	).toMatchObject({ amount: '0.00', kind: 'zero', availability: 'verified' });
	expect(
		widgetBalances(
			[
				{ ...account, closed: true },
				{ ...account, id: 'bank', type: 'checking' }
			],
			[txn],
			[coverage],
			'2030-01-03'
		)
	).toEqual([]);
});
it('rejects ambiguous identities instead of selecting the last row', () => {
	expect(() => widgetBalances([account, account], [txn], [coverage], '2030-01-03')).toThrow();
	expect(() => widgetBalances([account], [txn], [coverage, coverage], '2030-01-03')).toThrow();
});

it('never reports a source checkpoint from the future as current verified money', () => {
	expect(
		widgetBalances(
			[account],
			[txn],
			[{ ...coverage, asOf: '2030-02-01T10:00:00Z' }],
			'2030-01-03'
		)[0]
	).toMatchObject({ amount: null, availability: 'unavailable' });
});
describe('widgetRewards', () => {
	const today = '2030-05-10';
	const rewards = assembleRewards(
		[
			{ id: 'p1', label: 'Miles', provider: 'Air', account_id: null },
			{ id: 'p2', label: 'Card cash', provider: 'Bank', account_id: 'card-a' }
		],
		[
			{
				id: 'm',
				program_id: 'p1',
				component_key: 'm',
				label: 'Miles',
				unit: 'miles',
				role: 'redeemable',
				currency: null
			},
			{
				id: 'q',
				program_id: 'p1',
				component_key: 'q',
				label: 'Status',
				unit: 'MQD',
				role: 'qualifying',
				currency: null
			},
			{
				id: 'c',
				program_id: 'p2',
				component_key: 'c',
				label: 'Cash',
				unit: 'USD',
				role: 'cash_reward',
				currency: 'USD'
			}
		],
		[],
		[
			{
				id: 'b1',
				program: 'Miles',
				points: 5000,
				scraped_at: '2030-05-01T00:00:00.000Z',
				component_id: 'm',
				exact_amount: '5000',
				basis: 'available',
				source_date: null,
				source_as_of: null,
				period_start: null,
				period_end_exclusive: null,
				supersedes_id: null
			},
			{
				id: 'b2',
				program: 'Card cash',
				points: 12.5,
				scraped_at: '2030-05-02T00:00:00.000Z',
				component_id: 'c',
				exact_amount: '12.5',
				basis: 'available',
				source_date: '2030-04-30',
				source_as_of: null,
				period_start: null,
				period_end_exclusive: null,
				supersedes_id: null
			},
			{
				id: 'b3',
				program: 'Miles',
				points: 10,
				scraped_at: '2030-05-01T00:00:00.000Z',
				component_id: 'q',
				exact_amount: '10',
				basis: 'qualifying',
				source_date: null,
				source_as_of: null,
				period_start: null,
				period_end_exclusive: null,
				supersedes_id: null
			}
		],
		{
			complete: true,
			today,
			values: [{ program_id: 'p1', value_per_unit: '0.012', revision: 1 }],
			terms: [
				{
					id: 't',
					program_id: 'p2',
					component_id: 'c',
					term_key: 'expiry',
					kind: 'expiry',
					applicability: 'public_unverified',
					effective_from: null,
					effective_until: null,
					source_as_of: null,
					supersedes_id: null,
					payload: { schema_version: 1, type: 'no_scheduled_expiry' }
				}
			]
		}
	);
	const txns: Txn[] = [
		{
			account_id: 'card-a',
			date: '2030-05-03',
			amount: -30,
			category: 'Dining',
			categoryKind: 'spending'
		},
		{
			account_id: 'card-a',
			date: '2030-05-04',
			amount: 5,
			category: 'Dining',
			categoryKind: 'spending'
		},
		{
			account_id: 'card-a',
			date: '2030-05-04',
			amount: 100,
			category: 'Payment',
			categoryKind: 'transfer'
		},
		{
			account_id: 'card-a',
			date: '2030-05-05',
			amount: -9,
			category: 'Groceries',
			categoryKind: 'spending',
			status: 'pending'
		},
		{
			account_id: 'checking',
			date: '2030-05-05',
			amount: -50,
			category: 'Groceries',
			categoryKind: 'spending'
		}
	];
	const out = widgetRewards(
		rewards,
		[account, { ...account, id: 'checking', type: 'checking' }],
		txns,
		today
	);
	it('projects available rewards with capture labels and owner-valued estimates, no qualifying counters', () =>
		expect(out.rewards).toEqual([
			{
				id: 'm',
				program: 'Miles',
				label: 'Miles',
				unit: 'miles',
				amount: '5000',
				asOf: '2030-05-01T00:00:00.000Z',
				captured: true,
				pending: null,
				usd: '60',
				estimated: true
			},
			{
				id: 'c',
				program: 'Card cash',
				label: 'Cash',
				unit: 'USD',
				amount: '12.5',
				asOf: '2030-04-30',
				captured: false,
				pending: null,
				usd: '12.5',
				estimated: false
			}
		]));
	it('names units of multi-unit programs and leaves observed zeros out of available rewards', () => {
		const two = assembleRewards(
			[{ id: 'p', label: 'Theater', provider: 'T', account_id: null }],
			[
				{
					id: 'pts',
					program_id: 'p',
					component_key: 'pts',
					label: 'Points',
					unit: 'points',
					role: 'redeemable',
					currency: null
				},
				{
					id: 'usd',
					program_id: 'p',
					component_key: 'usd',
					label: 'Rewards',
					unit: 'USD',
					role: 'cash_reward',
					currency: 'USD'
				}
			],
			[],
			[
				{
					id: 'a',
					program: 'Theater',
					points: 0,
					scraped_at: '2030-05-01T00:00:00.000Z',
					component_id: 'usd',
					exact_amount: '0',
					basis: 'available',
					source_date: null,
					source_as_of: null,
					period_start: null,
					period_end_exclusive: null,
					supersedes_id: null
				},
				{
					id: 'b',
					program: 'Theater',
					points: 40,
					scraped_at: '2030-05-01T00:00:00.000Z',
					component_id: 'pts',
					exact_amount: '40',
					basis: 'available',
					source_date: null,
					source_as_of: null,
					period_start: null,
					period_end_exclusive: null,
					supersedes_id: null
				}
			],
			{ complete: true, today }
		);
		const view = widgetRewards(two, [], [], today);
		expect(view.rewards.map((r) => r.program)).toEqual(['Theater · Points']);
		expect(view.expiry.map((e) => e.program)).toEqual(['Theater · Points', 'Theater · Rewards']);
	});
	it('lists expiry clocks with unknown kept explicit', () =>
		expect(out.expiry.map((e) => [e.id, e.status, e.verified])).toEqual([
			['m', 'unknown', false],
			['c', 'none', false]
		]));
	it('withholds guidance when card categories are unavailable', () =>
		expect(widgetRewards(rewards, [account], txns, today, false).guidance).toBeNull());
	it('guides from posted card spend only, with unknown cards marked', () =>
		expect(out.guidance).toMatchObject({
			periodStart: '2030-04-01',
			categories: [
				{
					category: 'Dining',
					spent: '25',
					pick: null,
					cards: [{ id: 'card-a', status: 'unknown' }]
				}
			]
		}));
});
