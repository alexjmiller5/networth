// Market value of investment accounts: signed ledger positions times dated
// raw prices, plus custody cash where the source exposes it. Market moves never
// become transactions; a day without a usable price for every holding is
// unavailable, never zero and never carried across a newer market day. The one
// exception is a workplace plan fund (netbenefits): its NAV is only captured
// during finance runs, so it carries forward until the next capture and the day
// is marked carried.
import { addDays } from './presets';
import { assetClass, dateRange } from './series';
import type { Account, AccountCoverage, Txn } from './types';

/** Longest calendar gap a close may bridge (Friday close through a Monday holiday). */
export const MAX_PRICE_AGE_DAYS = 4;
const UNIT_TOLERANCE = 0.0015;
const GENERIC = 'Investment market prices unavailable; cash or contributions are not market value';

export type PriceProvider = 'tiingo' | 'fidelity' | 'alphavantage' | 'netbenefits';
export interface PriceMapping {
	account_id: string;
	security_id: string;
	provider: PriceProvider;
	/** Provider series identifier; null for NetBenefits, whose NAVs are per instrument. */
	symbol: string | null;
}
export interface PricePoint {
	date: string;
	price: number;
	/** Provider split factor on its ex-date. */
	split?: number;
}
/** Ascending dated prices per series key (see priceKey). */
export type PriceBook = Map<string, PricePoint[]>;
export interface ObservedUnits {
	account_id: string;
	security_id: string;
	date: string;
	units: number;
}
export interface ValuationGap {
	start: string;
	end: string;
	reason: string;
}
export interface AccountValuation {
	account_id: string;
	/** First ledger date; the account held nothing before it. */
	start: string;
	end: string;
	/** One value per day from start to end; null is unavailable. */
	values: (number | null)[];
	/** Oldest price date behind each available value; null when only cash was held. */
	priceDates: (string | null)[];
	/** True where a plan-fund NAV older than the daily price rule was carried forward. */
	carried: boolean[];
	gaps: ValuationGap[];
}

export function priceKey(
	m: Pick<PriceMapping, 'account_id' | 'security_id' | 'provider' | 'symbol'>
) {
	return m.provider === 'netbenefits'
		? `netbenefits:${m.account_id}:${m.security_id}`
		: `${m.provider}:${m.symbol}`;
}

const days = (from: string, to: string) =>
	Math.round((Date.parse(to) - Date.parse(from)) / 86400000);
/** "12 days old": the age of a carried NAV on a given day. */
export const navAge = (navDate: string, day: string) => {
	const n = days(navDate, day);
	return `${n} ${n === 1 ? 'day' : 'days'} old`;
};
const round = (n: number) => Math.round(n * 100) / 100;

/** Latest point on or before date (points ascending). */
function latest(points: PricePoint[] | undefined, date: string): PricePoint | undefined {
	if (!points) return undefined;
	let lo = 0;
	let hi = points.length - 1;
	let found: PricePoint | undefined;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (points[mid].date <= date) {
			found = points[mid];
			lo = mid + 1;
		} else hi = mid - 1;
	}
	return found;
}

export function valueAccounts(input: {
	accounts: Account[];
	txns: Txn[];
	coverage: AccountCoverage[];
	mappings: PriceMapping[];
	prices: PriceBook;
	observed: ObservedUnits[];
	end: string;
}): AccountValuation[] {
	const { prices, end } = input;
	// Any daily feed's close marks a market day; a staler close is not today's price.
	const marketDays = [
		...new Set(
			[...prices]
				.filter(([key]) => !key.startsWith('netbenefits:'))
				.flatMap(([, points]) => points.map((p) => p.date))
		)
	].sort();
	const newerMarketDay = (after: string, through: string) => {
		let lo = 0;
		let hi = marketDays.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (marketDays[mid] <= after) lo = mid + 1;
			else hi = mid;
		}
		return lo < marketDays.length && marketDays[lo] <= through;
	};
	const mappingOf = new Map(
		input.mappings.map((m) => [`${m.account_id}\u0000${m.security_id}`, m])
	);
	const out: AccountValuation[] = [];
	for (const account of input.accounts) {
		if (assetClass(account) !== 'investments') continue;
		const rows = input.txns
			.filter((t) => t.account_id === account.id && !t.standalone)
			.sort((a, b) => a.date.localeCompare(b.date));
		if (!rows.length || rows[0].date > end) continue;
		const start = rows[0].date;
		const dates = dateRange(start, end);
		const coverage = input.coverage.find((c) => c.account_id === account.id);
		// Coverage reasons are failures, except a verified closed account's own note.
		const blockers =
			coverage?.status === 'verified-closed-zero'
				? []
				: (coverage?.reasons ?? []).filter((r) => r !== GENERIC);
		if (!coverage || coverage.basis === 'none') blockers.push('No reconciliation checkpoint');
		// A workplace plan exposes no custody cash: contributions buy units directly.
		const custodyCash = coverage?.basis === 'money';

		// Daily closing positions, built once.
		const byDate = new Map<string, Txn[]>();
		for (const t of rows) byDate.set(t.date, [...(byDate.get(t.date) ?? []), t]);
		const positions: Map<string, number>[] = [];
		const cash: number[] = [];
		const held = new Map<string, number>();
		let balance = 0;
		for (const date of dates) {
			for (const t of byDate.get(date) ?? []) {
				balance += t.amount;
				if (!t.qty) continue;
				if (!t.ticker?.trim()) {
					blockers.push('A position change has no security identifier');
					continue;
				}
				held.set(t.ticker, (held.get(t.ticker) ?? 0) + t.qty);
			}
			positions.push(new Map([...held].filter(([, q]) => Math.abs(q) > 1e-6)));
			cash.push(custodyCash ? balance : 0);
		}
		const index = new Map(dates.map((d, i) => [d, i]));
		const position = (i: number, ticker: string) => (i < 0 ? 0 : (positions[i].get(ticker) ?? 0));

		for (const o of input.observed) {
			if (o.account_id !== account.id || o.date > end) continue;
			const i = o.date < start ? -1 : index.get(o.date)!;
			// A capture during the day may precede that day's ledger rows.
			if (
				Math.abs(position(i, o.security_id) - o.units) > UNIT_TOLERANCE &&
				Math.abs(position(i - 1, o.security_id) - o.units) > UNIT_TOLERANCE
			)
				blockers.push(
					`Ledger units for ${o.security_id} differ from the holdings observed on ${o.date}`
				);
		}

		const dayReasons: (string | null)[] = dates.map(() => null);
		const mark = (from: string, to: string, reason: string) => {
			for (let i = Math.max(0, index.get(from) ?? 0); i < dates.length && dates[i] <= to; i++)
				if (dates[i] >= from) dayReasons[i] ??= reason;
		};
		// A provider split must land on the same day the ledger multiplies the units.
		const tickers = new Set(positions.flatMap((p) => [...p.keys()]));
		for (const ticker of tickers) {
			const m = mappingOf.get(`${account.id}\u0000${ticker}`);
			if (!m || m.provider === 'netbenefits') continue;
			for (const s of prices.get(priceKey(m)) ?? []) {
				if (!s.split || s.split === 1 || s.date < start || s.date > end) continue;
				const x = index.get(s.date)!;
				const matches = (i: number) => {
					const before = position(i - 1, ticker);
					return (
						before > 0 &&
						Math.abs(position(i, ticker) - before * s.split!) <= UNIT_TOLERANCE * s.split!
					);
				};
				let y = -1;
				for (let i = Math.max(0, x - 10); i <= Math.min(dates.length - 1, x + 10); i++)
					if (matches(i)) {
						y = i;
						break;
					}
				if (y === x) continue;
				if (y >= 0)
					mark(
						dates[Math.min(x, y)],
						addDays(dates[Math.max(x, y)], -1),
						`${ticker} split on ${s.date} but the ledger records it on ${dates[y]}`
					);
				else if (position(x - 1, ticker) > 0)
					mark(s.date, end, `${ticker} split on ${s.date} is missing from the ledger`);
			}
		}

		const values: (number | null)[] = [];
		const priceDates: (string | null)[] = [];
		const carried: boolean[] = [];
		dates.forEach((date, i) => {
			let reason = blockers[0] ?? dayReasons[i];
			let value = cash[i];
			let oldest: string | null = null;
			let stale = false;
			for (const [ticker, qty] of positions[i]) {
				if (reason) break;
				const m = mappingOf.get(`${account.id}\u0000${ticker}`);
				const p = m && latest(prices.get(priceKey(m)), date);
				if (qty < 0) reason = `Negative ${ticker} position`;
				else if (!m) reason = `No price source for ${ticker}`;
				else if (!p) reason = `No ${m.provider} price for ${ticker}`;
				else {
					const fresh = days(p.date, date) <= MAX_PRICE_AGE_DAYS && !newerMarketDay(p.date, date);
					if (!fresh && m.provider !== 'netbenefits')
						reason = `Latest ${m.provider} price for ${ticker} is from ${p.date}`;
					else {
						value += qty * p.price;
						if (!oldest || p.date < oldest) oldest = p.date;
						stale ||= !fresh;
					}
				}
			}
			values.push(reason ? null : round(value));
			priceDates.push(reason ? null : oldest);
			carried.push(!reason && stale);
			dayReasons[i] = reason;
		});
		const gaps: ValuationGap[] = [];
		dates.forEach((date, i) => {
			const reason = dayReasons[i];
			const last = gaps.at(-1);
			if (!reason) return;
			if (last && last.reason === reason && last.end === addDays(date, -1)) last.end = date;
			else gaps.push({ start: date, end: date, reason });
		});
		out.push({ account_id: account.id, start, end, values, priceDates, carried, gaps });
	}
	return out;
}

/** Investment coverage after valuation: verified only when reconciled and freshly priced on the
 * end date; a carried plan-fund NAV is labelled carried with its age, never verified. */
export function valuedCoverage(
	coverage: AccountCoverage[],
	valuations: AccountValuation[]
): AccountCoverage[] {
	return coverage.map((c) => {
		const v = valuations.find((x) => x.account_id === c.account_id);
		if (!v) return c;
		const last = v.values.at(-1);
		const lastValued = v.values.findLastIndex((x) => x !== null);
		if (c.status === 'verified-closed-zero')
			return {
				...c,
				reasons: [
					'Current cash and positions verify zero',
					...(v.gaps.length ? ['Some historical market values are unavailable'] : [])
				]
			};
		if (last !== null && last !== undefined) {
			const valuedAsOf = v.priceDates.at(-1) ?? v.end;
			return v.carried.at(-1)
				? {
						...c,
						status: 'carried',
						valuedAsOf,
						reasons: [`NAV from ${valuedAsOf} carried forward, ${navAge(valuedAsOf, v.end)}`]
					}
				: { ...c, status: 'verified', valuedAsOf, reasons: [] };
		}
		const gap = v.gaps.at(-1);
		return {
			...c,
			status: 'investment-unvalued',
			reasons: [
				gap ? `Unavailable on ${v.end}: ${gap.reason}` : GENERIC,
				...(lastValued >= 0
					? [`Last valued ${addDays(v.start, lastValued)}`]
					: ['No valued day yet'])
			]
		};
	});
}
