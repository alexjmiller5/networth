import { expect, it } from 'vitest';
import { matchesTransaction } from './transactionFilter';
import type { Txn } from './types';
const row: Txn = {
	account_id: 'a',
	date: '2026-01-01',
	amount: -12.5,
	name: 'Synthetic shop',
	payee: 'Merchant',
	memo: 'Receipt',
	bank_category: 'Retail',
	note: 'Shared meal',
	group: 'story-1',
	reviewed_at: '2026-01-02T00:00:00.000Z',
	pps: 2.5
};
it('filters catalog text, exact identities, signed numbers and explicit missing values', () => {
	expect(matchesTransaction(row, { field: 'name', operator: 'contains', value: 'SHOP' })).toBe(
		true
	);
	expect(matchesTransaction(row, { field: 'group', operator: 'equals', value: 'story' })).toBe(
		false
	);
	expect(matchesTransaction(row, { field: 'group', operator: 'equals', value: 'story-1' })).toBe(
		true
	);
	expect(matchesTransaction(row, { field: 'amount', operator: 'min', value: '-13' })).toBe(true);
	expect(matchesTransaction(row, { field: 'amount', operator: 'max', value: '-13' })).toBe(false);
	expect(matchesTransaction(row, { field: 'amount', operator: 'min', value: 'bad' })).toBe(false);
	expect(matchesTransaction(row, { field: 'reviewed_at', operator: 'missing', value: '' })).toBe(
		false
	);
	expect(
		matchesTransaction(
			{ ...row, reviewed_at: undefined },
			{ field: 'reviewed_at', operator: 'missing', value: '' }
		)
	).toBe(true);
	expect(
		matchesTransaction({ ...row, amount: 0 }, { field: 'amount', operator: 'missing', value: '' })
	).toBe(false);
	expect(matchesTransaction(row, { field: 'name', operator: 'contains', value: '' })).toBe(true);
});

it('compares numeric equality by value and does not confuse unreviewed with uncategorized', () => {
	expect(matchesTransaction(row, { field: 'pps', operator: 'equals', value: '2.50' })).toBe(true);
	expect(
		matchesTransaction(
			{ ...row, category: 'Reviewed category', reviewed_at: undefined },
			{ field: 'reviewed_at', operator: 'missing', value: '' }
		)
	).toBe(true);
	expect(
		matchesTransaction(
			{ ...row, category: 'Reviewed category', reviewed_at: undefined },
			{ field: 'category', operator: 'missing', value: '' }
		)
	).toBe(false);
});
