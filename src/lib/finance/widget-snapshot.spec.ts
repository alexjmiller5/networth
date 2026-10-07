import { expect, it } from 'vitest';
import { widgetBalances } from './widget-snapshot';
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
