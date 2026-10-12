import { addDays } from './presets';
import { selectRewardEventHeads, type RewardEventVersion } from './reward-history';
import { canonical, decimal as exact, quotient } from './redemption-valuation';

/** A card ledger row with the fields that decide reward eligibility. */
export interface LedgerRow {
	account_id: string;
	date: string;
	posted_date: string | null;
	amount: number;
	name: string | null;
	bank_category: string | null;
	category: string | null;
	internal: boolean;
}
export type SpendKind = 'purchase' | 'refund' | 'payment' | 'reward' | 'fee' | 'cash_advance';
type Part = 'base' | 'bonus' | 'other';
/** A provider statement's earned-this-period observation (`reward_events` with period bounds). */
export interface PeriodEvent extends RewardEventVersion {
	event_date: string | null;
	units_delta: string | null;
	period_start: string | null;
	period_end_exclusive: string | null;
	details: {
		base_bonus?: { kind: Part; units: string | null; native_label: string | null }[];
	} | null;
}
export interface PeriodEarning {
	id: string;
	start: string;
	endExclusive: string;
	closing: string;
	earned: string;
	/** The statement's printed parts of `earned`, never added on top of it. */
	parts: Record<Part, string | null>;
	/** Net posted purchases in the window, card currency. */
	spend: string;
	rate: string | null;
	reason: string | null;
}
export interface StatementEarnings {
	status: 'available' | 'unavailable';
	periods: PeriodEarning[];
	/** Statements closing within twelve months up to the latest one. */
	t12m: {
		earned: string;
		/** Earnings of the periods that have a rate: the rate's numerator. */
		ratedEarned: string | null;
		spend: string;
		rate: string | null;
		periods: number;
		/** Periods left out of the rate because their window holds no net purchases. */
		unrated: number;
		from: string;
		to: string;
	} | null;
	asOf: string | null;
	diagnostics: string[];
}

// Issuer wording for fees and interest on statement rows, which carry no bank label.
const FEE =
	/^(?:FOREIGN TRANSACTION FEE|(?:ATM|BANK) - TRANSACTION FEE|INTEREST CHARGE|LATE (?:PAYMENT )?FEE|ANNUAL (?:MEMBERSHIP )?FEE)/i;
/** Rewards accrue on purchases net of refunds; payments, reward credits, fees and cash advances never earn. */
export function spendKind(row: LedgerRow): SpendKind {
	if (row.internal) return 'payment';
	if (row.category === 'Cashback' || row.category === 'Transfer') return 'reward';
	if (row.bank_category?.startsWith('Finance: Service Charges') || FEE.test(row.name ?? ''))
		return 'fee';
	if (
		row.category === 'Cash & ATM' ||
		(row.amount < 0 && /ATM\/Cash Withdrawals/.test(row.bank_category ?? ''))
	)
		return 'cash_advance';
	return row.amount < 0 ? 'purchase' : 'refund';
}

const cents = (amount: number) => Math.round(amount * 100);
const money = (c: number) => canonical({ coefficient: BigInt(c), scale: 2 });
function rate(earned: string, spendCents: number): string | null {
	const units = exact(earned);
	if (units.coefficient < 0n || spendCents <= 0) return null;
	return quotient(units, { coefficient: BigInt(spendCents), scale: 2 }, 6);
}
function sum(values: string[]): string | null {
	if (!values.length) return null;
	return canonical(
		values.map(exact).reduce((a, b) => {
			const scale = Math.max(a.scale, b.scale);
			const lift = (d: typeof a) => d.coefficient * 10n ** BigInt(scale - d.scale);
			return { coefficient: lift(a) + lift(b), scale };
		})
	);
}

/** Observed statement earnings against net posted purchases in each statement window. */
export function statementEarnings(events: PeriodEvent[], rows: LedgerRow[]): StatementEarnings {
	const none = (reason: string): StatementEarnings => ({
		status: 'unavailable',
		periods: [],
		t12m: null,
		asOf: null,
		diagnostics: [reason]
	});
	const groups = selectRewardEventHeads(events.filter((e) => e.period_start !== null));
	if (groups.some((g) => g.diagnostics.length))
		return none('Statement event history needs review.');
	const heads = groups
		.map((g) => g.head!)
		.filter((h) => h.state === 'posted' && h.units_delta !== null && h.event_date !== null)
		.sort((a, b) => a.period_start!.localeCompare(b.period_start!));
	if (!heads.length) return none('No statement states earnings for this card.');

	const day = (r: LedgerRow) => r.posted_date ?? r.date;
	const priced = rows.map((r) => ({ day: day(r), kind: spendKind(r), cents: cents(r.amount) }));
	const periods: PeriodEarning[] = heads.map((h) => {
		const start = h.period_start!,
			endExclusive = h.period_end_exclusive!;
		const spend = priced
			.filter((r) => r.day >= start && r.day < endExclusive)
			.reduce((n, r) => (r.kind === 'purchase' || r.kind === 'refund' ? n - r.cents : n), 0);
		const parts = (kind: Part) =>
			sum(
				(h.details?.base_bonus ?? []).flatMap((p) => (p.kind === kind && p.units ? [p.units] : []))
			);
		const r = rate(h.units_delta!, spend);
		return {
			id: h.id,
			start,
			endExclusive,
			closing: h.event_date!,
			earned: h.units_delta!,
			parts: { base: parts('base'), bonus: parts('bonus'), other: parts('other') },
			spend: money(spend),
			rate: r,
			reason:
				r !== null
					? null
					: spend <= 0
						? 'No net posted purchases in this statement window.'
						: 'Earnings net negative in this statement window.'
		};
	});

	const asOf = periods.reduce((a, p) => (p.closing > a ? p.closing : a), periods[0].closing);
	const cutoff = `${Number(asOf.slice(0, 4)) - 1}${asOf.slice(4)}`;
	const recent = periods.filter((p) => p.closing > cutoff);
	const rated = recent.filter((p) => p.rate !== null);
	const ratedCents = rated.reduce((n, p) => n + cents(Number(p.spend)), 0);
	const ratedEarned = sum(rated.map((p) => p.earned));

	const diagnostics: string[] = [];
	const purchases = priced.filter((r) => r.kind === 'purchase').map((r) => r.day);
	const uncovered = (from: string | null, to: string | null) =>
		purchases.some((d) => (from === null || d >= from) && (to === null || d < to));
	if (uncovered(null, periods[0].start))
		diagnostics.push(`Purchases before ${periods[0].start} fall in no recorded statement.`);
	for (let i = 1; i < periods.length; i++) {
		const gapFrom = periods[i - 1].endExclusive,
			gapTo = periods[i].start;
		if (gapFrom < gapTo && uncovered(gapFrom, gapTo))
			diagnostics.push(
				`Purchases from ${gapFrom} to ${addDays(gapTo, -1)} fall in no recorded statement.`
			);
	}
	const last = periods.at(-1)!;
	if (uncovered(last.endExclusive, null))
		diagnostics.push(`Purchases after ${last.closing} have no statement earnings recorded yet.`);

	return {
		status: 'available',
		periods,
		t12m: {
			earned: sum(recent.map((p) => p.earned))!,
			ratedEarned,
			spend: money(ratedCents),
			rate: ratedEarned === null ? null : rate(ratedEarned, ratedCents),
			periods: recent.length,
			unrated: recent.length - rated.length,
			from: recent.reduce((a, p) => (p.start < a ? p.start : a), recent[0].start),
			to: asOf
		},
		asOf,
		diagnostics
	};
}
