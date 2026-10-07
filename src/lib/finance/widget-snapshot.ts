import { deriveBalances } from './series';
import type { Account, AccountCoverage, Txn } from './types';
export interface WidgetBalance {
	id: string;
	label: string;
	currency: string | null;
	amount: string | null;
	kind: 'owed' | 'credit' | 'zero' | 'unavailable';
	asOf: string | null;
	availability: 'verified' | 'unavailable';
}
/** Narrow display projection. Source transactions and diagnostics never leave in the snapshot. */
export function widgetBalances(
	accounts: Account[],
	txns: Txn[],
	coverage: AccountCoverage[],
	date: string
): WidgetBalance[] {
	if (
		new Set(accounts.map((a) => a.id)).size !== accounts.length ||
		new Set(coverage.map((c) => c.account_id)).size !== coverage.length
	)
		throw new Error('Ambiguous widget account identity');
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(date).toISOString().slice(0, 10) !== date)
		throw new Error('Invalid snapshot date');
	const cards = accounts.filter((a) => a.type === 'credit_card' && !a.closed);
	const checks = new Map(coverage.map((c) => [c.account_id, c]));
	const eligible = coverage.filter(
		(c) =>
			c.status === 'verified' &&
			c.basis === 'money' &&
			c.asOf !== null &&
			Number.isFinite(Date.parse(c.asOf))
	);
	const amounts = new Map(
		deriveBalances(txns, cards, date, date, eligible).series.map((s) => [s.key, s.data[0]])
	);
	return cards.map((a) => {
		const check = checks.get(a.id);
		const currency = a.currency && /^[A-Z]{3}$/.test(a.currency) ? a.currency : null;
		const value = amounts.get(a.id);
		const known = currency !== null && value !== undefined && Number.isFinite(value);
		return {
			id: a.id,
			label: a.name,
			currency,
			amount: known ? Math.abs(value!).toFixed(2) : null,
			kind: known ? (value! < 0 ? 'owed' : value! > 0 ? 'credit' : 'zero') : 'unavailable',
			asOf: check?.asOf ?? null,
			availability: known ? 'verified' : 'unavailable'
		};
	});
}
