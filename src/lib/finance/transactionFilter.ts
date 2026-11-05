import type { Txn } from './types';

export const TRANSACTION_FIELDS = {
	name: 'Description',
	payee: 'Payee',
	memo: 'Memo',
	bank_category: 'Bank category',
	origin: 'Share origin',
	counterparty: 'Counterparty ID',
	note: 'Note',
	group: 'Expense group',
	reviewed_at: 'Ledger review confirmed at',
	source: 'Source',
	source_id: 'Source record',
	account_id: 'Account ID',
	category: 'Category',
	categoryKind: 'Category kind',
	status: 'Status',
	date: 'Activity date',
	posted_date: 'Posted date',
	scraped_at: 'Captured at',
	amount: 'Signed owned amount',
	qty: 'Ledger quantity',
	ticker: 'Ticker',
	pps: 'Price per share',
	rewards: 'Rewards',
	points: 'Points',
	fundedBy: 'Funded by'
} as const;
export const FILTER_OPERATORS = {
	contains: 'Contains',
	equals: 'Equals',
	min: 'At least',
	max: 'At most',
	missing: 'Is missing',
	present: 'Is present'
} as const;
export interface TransactionFilter {
	field: keyof typeof TRANSACTION_FIELDS;
	operator: keyof typeof FILTER_OPERATORS;
	value: string;
}
export function matchesTransaction(row: Txn, filter: TransactionFilter): boolean {
	const value = row[filter.field];
	const missing = value == null || value === '';
	if (filter.operator === 'missing') return missing;
	if (filter.operator === 'present') return !missing;
	if (!filter.value.trim()) return true;
	if (missing) return false;
	if (filter.operator === 'min' || filter.operator === 'max') {
		const threshold = Number(filter.value);
		return (
			typeof value === 'number' &&
			Number.isFinite(threshold) &&
			(filter.operator === 'min' ? value >= threshold : value <= threshold)
		);
	}
	if (filter.operator === 'equals' && typeof value === 'number')
		return Number.isFinite(Number(filter.value)) && value === Number(filter.value);
	const actual = String(value).toLocaleLowerCase();
	const wanted = filter.value.toLocaleLowerCase();
	return filter.operator === 'equals' ? actual === wanted : actual.includes(wanted);
}
