import { deriveBalances, flowPieces } from './series';
import { cardGuidance, currentBalance, type Guidance, type Rewards } from './rewards';
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
			Number.isFinite(Date.parse(c.asOf)) &&
			c.asOf.slice(0, 10) <= date
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

export interface WidgetRewards {
	rewards: {
		id: string;
		program: string;
		label: string;
		unit: string;
		amount: string;
		asOf: string;
		/** True when the amount is the latest capture, not a source-dated balance. */
		captured: boolean;
		pending: string | null;
		usd: string | null;
		estimated: boolean;
	}[];
	expiry: {
		id: string;
		program: string;
		unit: string;
		status: 'scheduled' | 'none' | 'unknown';
		expiresOn: string | null;
		verified: boolean;
		reason: string;
	}[];
	caps: {
		id: string;
		program: string;
		status: 'available' | 'unavailable';
		unit: string | null;
		limit: string | null;
		used: string | null;
		remaining: string | null;
		resetsOn: string | null;
		reason: string | null;
	}[];
	/** Null when card categories could not be read; never an empty "no spend" guess. */
	guidance: Guidance | null;
}
/** Reward views for the widget: exact text, explicit unknowns, no evidence or source identity. */
export function widgetRewards(
	rewards: Rewards,
	accounts: Account[],
	txns: Txn[],
	today: string,
	categoriesAvailable = true
): WidgetRewards {
	const units = rewards.programs.flatMap((p) => {
		const own = p.components.filter((c) => c.role !== 'qualifying');
		// A program with several units names each one, so rows never repeat a label.
		return own.map((c) => ({ p, c, name: own.length > 1 ? `${p.label} · ${c.label}` : p.label }));
	});
	const order = { scheduled: 0, unknown: 1, none: 2 };
	const cards = accounts.filter((a) => a.type === 'credit_card' && !a.closed);
	const cardIds = new Set(cards.map((a) => a.id));
	const spending = flowPieces(txns).flatMap((t) => {
		const kind =
			!t.categoryKind || t.categoryKind === 'unknown'
				? t.amount < 0
					? 'spending'
					: 'income'
				: t.categoryKind;
		return t.account_id &&
			cardIds.has(t.account_id) &&
			t.category &&
			kind === 'spending' &&
			t.status !== 'pending'
			? [{ account_id: t.account_id, category: t.category, amount: -t.amount, date: t.date }]
			: [];
	});
	return {
		rewards: units
			.flatMap(({ c, name }) => {
				const available = currentBalance(c, 'available');
				// Nothing to redeem: an observed zero stays on the dashboard, not in this list.
				if (!available || available.amount === '0') return [];
				return [
					{
						id: c.id,
						program: name,
						label: c.label,
						unit: c.unit,
						amount: available.amount,
						asOf: available.asOf,
						captured: available.captured,
						pending: currentBalance(c, 'pending')?.amount ?? null,
						usd: c.dollar?.value ?? null,
						estimated: c.dollar?.estimated ?? false
					}
				];
			})
			.sort(
				(a, b) => Number(b.usd ?? -1) - Number(a.usd ?? -1) || a.program.localeCompare(b.program)
			),
		expiry: units
			.map(({ c, name }) => ({ id: c.id, program: name, unit: c.unit, ...c.expiry }))
			.sort(
				(a, b) =>
					order[a.status] - order[b.status] ||
					(a.expiresOn ?? '').localeCompare(b.expiresOn ?? '') ||
					a.program.localeCompare(b.program)
			),
		caps: rewards.programs
			.flatMap((p) => p.caps.map((cap) => ({ id: `${p.id}:${cap.key}`, program: p.label, ...cap })))
			.map(({ key: _key, ...cap }) => cap),
		guidance: !categoriesAvailable
			? null
			: cardGuidance({
					rewards,
					cards: cards.map((a) => ({ id: a.id, label: a.name })),
					spending,
					today
				})
	};
}
