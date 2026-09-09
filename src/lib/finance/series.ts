// Pure selectors: raw txns -> chart-ready balance series.
// Balances are LEVELS derived by running-summing signed txns per account
// (the estate's derive-from-txns rule), so bucketing takes each bucket's
// LAST value, never a sum.

import type { Account, AccountCoverage, AssetClass, GroupBy, Txn } from './types';
import { addDays } from './presets';

export interface StackedSeries {
	dates: string[];
	series: { key: string; data: number[] }[];
}

export type Bucket = 'day' | 'week' | 'month';

/** Every YYYY-MM-DD from start to end inclusive (UTC arithmetic - dates are labels). */
export function dateRange(start: string, end: string): string[] {
	const dates: string[] = [];
	for (let t = Date.parse(start); t <= Date.parse(end); t += 86_400_000) {
		dates.push(new Date(t).toISOString().slice(0, 10));
	}
	return dates;
}

/** Daily balance per account over [start, end]: cumulative signed txns,
 * including txns before the window (they set the entry balance). */
export function deriveBalances(
	txns: Txn[],
	accounts: Account[],
	start: string,
	end: string,
	coverage?: AccountCoverage[]
): StackedSeries {
	const dates = dateRange(start, end);
	const index = new Map(dates.map((d, i) => [d, i]));
	const ledger = txns.filter(
		(t) => !t.standalone && t.account_id != null && t.balanceAmount !== null
	);
	const present = new Set(ledger.map((t) => t.account_id));
	const verified =
		coverage && new Set(coverage.filter((c) => c.status === 'verified').map((c) => c.account_id));
	accounts = accounts.filter((a) => present.has(a.id) && (!verified || verified.has(a.id)));
	const series = accounts.map((a) => ({
		key: a.id,
		data: new Array<number>(dates.length).fill(0)
	}));
	const row = new Map(series.map((s) => [s.key, s.data]));

	const opening = new Map<string, number>();
	const deltas = new Map<string, number[]>();
	for (const t of ledger) {
		const amount = t.balanceAmount === undefined ? t.amount : t.balanceAmount!;
		const account = t.account_id!;
		if (t.date < start) {
			opening.set(account, (opening.get(account) ?? 0) + amount);
		} else if (t.date <= end) {
			const d = deltas.get(account) ?? new Array<number>(dates.length).fill(0);
			d[index.get(t.date)!] += amount;
			deltas.set(account, d);
		}
	}
	for (const a of accounts) {
		const data = row.get(a.id)!;
		const delta = deltas.get(a.id);
		let bal = opening.get(a.id) ?? 0;
		for (let i = 0; i < dates.length; i++) {
			if (delta) bal += delta[i];
			data[i] = Math.round(bal * 100) / 100;
		}
	}
	return { dates, series };
}

export function assetClass(account: Account): AssetClass {
	return ['brokerage', 'ira', '401k'].includes(account.type) ? 'investments' : 'cash';
}

export function accountGroup(account: Account, groupBy: GroupBy): string {
	if (groupBy === 'account') return account.id;
	if (groupBy === 'bank') return account.bank;
	if (groupBy === 'asset') return assetClass(account);
	return account.type;
}

/** Merge account series into bank/type groups (sum - balances add across
 * accounts). 'account' passes through. */
export function groupSeries(
	s: StackedSeries,
	accounts: Account[],
	groupBy: GroupBy
): StackedSeries {
	if (groupBy === 'account') return s;
	const groupOf = new Map(accounts.map((a) => [a.id, accountGroup(a, groupBy)]));
	const merged = new Map<string, number[]>();
	for (const ser of s.series) {
		const key = groupOf.get(ser.key) ?? ser.key;
		const data = merged.get(key);
		if (!data) {
			merged.set(key, [...ser.data]);
		} else {
			for (let i = 0; i < data.length; i++) data[i] += ser.data[i];
		}
	}
	return { dates: s.dates, series: [...merged].map(([key, data]) => ({ key, data })) };
}

/** Week buckets anchor on their Monday, months on 'YYYY-MM-01'. */
function bucketLabel(date: string, bucket: Bucket): string {
	if (bucket === 'day') return date;
	if (bucket === 'month') return `${date.slice(0, 7)}-01`;
	const [y, m, d] = date.split('-').map(Number);
	const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
	return addDays(date, -((weekday + 6) % 7));
}

/** Re-bucket daily levels into week/month points holding each bucket's LAST
 * (closing) balance. 'day' passes through untouched. */
export function bucketize(s: StackedSeries, bucket: Bucket): StackedSeries {
	if (bucket === 'day') return s;
	const labels: string[] = [];
	const indexOf = new Map<string, number>();
	const target = s.dates.map((d) => {
		const label = bucketLabel(d, bucket);
		if (!indexOf.has(label)) {
			indexOf.set(label, labels.length);
			labels.push(label);
		}
		return indexOf.get(label)!;
	});
	return {
		dates: labels,
		series: s.series.map((ser) => {
			const data = new Array<number>(labels.length).fill(0);
			// later days overwrite earlier ones -> closing balance per bucket
			ser.data.forEach((v, i) => (data[target[i]] = v));
			return { key: ser.key, data };
		})
	};
}

/** Running-sum each series over its dates - turns per-bucket flows into
 * cumulative totals from the window's start (each series starts at 0). */
export function accumulate(s: StackedSeries): StackedSeries {
	return {
		dates: s.dates,
		series: s.series.map((ser) => {
			let sum = 0;
			return {
				key: ser.key,
				data: ser.data.map((v) => (sum = Math.round((sum + v) * 100) / 100))
			};
		})
	};
}

/** Bucket-over-bucket deltas of a LEVEL series (balances -> per-bucket net
 * change). `initial` supplies each key's level just before the window so
 * the first bucket's delta is real, not a jump from zero. */
export function differentiate(s: StackedSeries, initial: Map<string, number>): StackedSeries {
	return {
		dates: s.dates,
		series: s.series.map((ser) => {
			let prev = initial.get(ser.key) ?? 0;
			return {
				key: ser.key,
				data: ser.data.map((v) => {
					const d = Math.round((v - prev) * 100) / 100;
					prev = v;
					return d;
				})
			};
		})
	};
}

/** Per-date total across all series - the net line (assets minus card debt). */
export function netTotals(s: StackedSeries): number[] {
	return s.dates
		.map((_, i) => Math.round(s.series.reduce((sum, ser) => sum + ser.data[i], 0) * 100))
		.map((v) => v / 100);
}

/** Matches the spending view: shares are independent of the parent's flags.
 * Unsplit internal, excluded and synthetic transactions do not contribute. */
export function flowPieces(txns: Txn[]): Txn[] {
	const out: Txn[] = [];
	for (const t of txns) {
		if (t.shares?.length) {
			for (const s of t.shares) {
				const piece = { ...t, shares: undefined, ...s, date: s.date ?? t.date };
				delete piece.internal;
				delete piece.excluded;
				delete piece.synthetic;
				out.push(piece);
			}
		} else if (!t.excluded && !t.internal && !t.synthetic) out.push(t);
	}
	return out;
}

/** Flow series bucketed over [start, end], keyed by keyOf (category,
 * account, ...). Internal transfer legs and uncategorized txns never count
 * (uncategorized is the review queue, not the analysis).
 *
 * mode 'signed': every categorized txn keeps its sign - income categories
 * stack above zero, spending hangs below, series total = net cash flow.
 * mode 'spending': spending categories, signs flipped, refunds subtract.
 * mode 'income': income categories, with reversals subtracting.
 * Unknown kinds use sign; transfer kinds are excluded from all modes.
 * Ordered by total (income first / biggest spend first). */
export function flowSeries(
	txns: Txn[],
	start: string,
	end: string,
	bucket: Bucket,
	keyOf: (t: Txn) => string | null | undefined,
	mode: 'signed' | 'spending' | 'income' = 'signed'
): StackedSeries {
	const labels: string[] = [];
	const indexOf = new Map<string, number>();
	for (const d of dateRange(start, end)) {
		const label = bucketLabel(d, bucket);
		if (!indexOf.has(label)) {
			indexOf.set(label, labels.length);
			labels.push(label);
		}
	}
	const byKey = new Map<string, number[]>();
	for (const t of flowPieces(txns)) {
		if (!t.category || t.internal) continue;
		if (t.categoryKind === 'transfer') continue;
		// Unknown categories (and older callers without kinds) use sign. Known
		// kinds retain their reversals: a refund reduces spending, never income.
		const kind =
			!t.categoryKind || t.categoryKind === 'unknown'
				? t.amount < 0
					? 'spending'
					: 'income'
				: t.categoryKind;
		if (mode !== 'signed' && kind !== mode) continue;
		if (t.date < start || t.date > end) continue;
		const key = keyOf(t);
		if (!key) continue;
		const i = indexOf.get(bucketLabel(t.date, bucket))!;
		let data = byKey.get(key);
		if (!data) {
			data = new Array<number>(labels.length).fill(0);
			byKey.set(key, data);
		}
		const amount = mode === 'spending' ? -t.amount : t.amount;
		data[i] = Math.round((data[i] + amount) * 100) / 100;
	}
	const series = [...byKey]
		.map(([key, data]) => ({ key, data, total: data.reduce((a, b) => a + b, 0) }))
		.sort((a, b) => b.total - a.total)
		.map(({ key, data }) => ({ key, data }));
	return { dates: labels, series };
}

export function flowsByCategory(
	txns: Txn[],
	start: string,
	end: string,
	bucket: Bucket
): StackedSeries {
	return flowSeries(txns, start, end, bucket, (t) => t.category);
}
