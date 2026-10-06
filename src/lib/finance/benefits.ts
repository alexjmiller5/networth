import { isDate } from './presets';
import { STORAGE_KEY } from './controls';

export const BENEFIT_METRICS = {
	annual_election: 'Annual election',
	employee_contributions: 'Employee contributions',
	claims_submitted: 'Claims submitted',
	claims_paid: 'Claims paid',
	claims_denied: 'Claims denied',
	available_benefit: 'Available benefit',
	stated_notional_balance: 'Notional credit',
	vested_balance: 'Vested balance'
} as const;
type Metric = keyof typeof BENEFIT_METRICS;
export type BenefitObservation = Record<Metric, number | null> & {
	id: string;
	plan_year: number | null;
	observed_at: string;
	source_as_of: string | null;
	currency: string;
	eligibility_status: string | null;
	vested_visibility: 'reported' | 'suppressed' | 'not_exposed';
};
export interface BenefitPlan {
	id: string;
	provider: string;
	native_plan_id: string | null;
	name: string;
	kind: 'fsa' | 'retiree_health';
	currency: string;
	status: 'active' | 'inactive' | 'unknown';
	years: { year: number | null; observations: BenefitObservation[] }[];
}
export interface Benefits {
	plans: BenefitPlan[];
}
type Row = Record<string, unknown>;
function fail(): never {
	throw new Error('Invalid benefit data');
}
const text = (value: unknown): string =>
	typeof value === 'string' && value.trim() ? value : fail();
const optionalText = (value: unknown): string | null => (value == null ? null : text(value));
function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
	return values.includes(value as T) ? (value as T) : fail();
}
function currency(value: unknown): string {
	return typeof value === 'string' && Intl.supportedValuesOf('currency').includes(value)
		? value
		: fail();
}
function money(value: unknown): number | null {
	if (value == null) return null;
	if (typeof value === 'string' && !/^-?(0|[1-9]\d*)(\.\d+)?$/.test(value)) return fail();
	if (typeof value !== 'number' && typeof value !== 'string') return fail();
	const number = Number(value);
	return Number.isFinite(number) && Math.abs(number) <= Number.MAX_SAFE_INTEGER ? number : fail();
}
function captured(value: unknown): string {
	if (
		typeof value !== 'string' ||
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value) ||
		!isDate(value.slice(0, 10)) ||
		!Number.isFinite(Date.parse(value))
	)
		return fail();
	const normalized = new Date(value).toISOString();
	if (normalized.slice(0, 19) !== value.slice(0, 19)) return fail();
	return normalized;
}
/** Whitelist a native observation view. No benefit becomes a transaction or liquid asset. */
export function assembleBenefits(planRows: Row[], snapshotRows: Row[]): Benefits {
	const plans = new Map<string, BenefitPlan>();
	const deleted = new Set(planRows.filter((row) => row.deleted_at != null).map((row) => row.id));
	for (const row of planRows.filter((row) => row.deleted_at == null)) {
		const id = text(row.id);
		if (plans.has(id)) fail();
		plans.set(id, {
			id,
			provider: text(row.provider),
			native_plan_id: optionalText(row.native_plan_id),
			name: text(row.name),
			kind: oneOf(row.kind, ['fsa', 'retiree_health']),
			currency: currency(row.currency),
			status: oneOf(row.status, ['active', 'inactive', 'unknown']),
			years: []
		});
	}
	const ids = new Set<string>();
	for (const row of snapshotRows.filter((row) => row.deleted_at == null)) {
		if (deleted.has(row.plan_id)) continue;
		const plan = plans.get(text(row.plan_id));
		if (!plan) fail();
		const id = text(row.id);
		if (ids.has(id)) fail();
		ids.add(id);
		text(row.source_record_ref); // Required evidence is validated here and never sent to the browser.
		const code = currency(row.currency);
		if (code !== plan.currency) fail();
		const year =
			row.plan_year == null
				? null
				: typeof row.plan_year === 'number' &&
					  Number.isInteger(row.plan_year) &&
					  row.plan_year > 0 &&
					  row.plan_year <= 9999
					? row.plan_year
					: fail();
		const sourceDate =
			row.source_as_of == null ? null : isDate(row.source_as_of) ? row.source_as_of : fail();
		const metrics = Object.fromEntries(
			Object.keys(BENEFIT_METRICS).map((key) => [key, money(row[key])])
		) as Record<Metric, number | null>;
		const visibility = oneOf(row.vested_visibility, ['reported', 'suppressed', 'not_exposed']);
		if (visibility !== 'reported' && metrics.vested_balance !== null) fail();
		const observation: BenefitObservation = {
			id,
			plan_year: year,
			observed_at: captured(row.observed_at),
			source_as_of: sourceDate,
			currency: code,
			...metrics,
			eligibility_status: optionalText(row.eligibility_status),
			vested_visibility: visibility
		};
		let group = plan.years.find((group) => group.year === year);
		if (!group) {
			group = { year, observations: [] };
			plan.years.push(group);
		}
		group.observations.push(observation);
	}
	for (const plan of plans.values()) {
		plan.years.sort((a, b) => (b.year ?? -1) - (a.year ?? -1));
		for (const group of plan.years)
			group.observations.sort(
				(a, b) =>
					(b.source_as_of ?? '').localeCompare(a.source_as_of ?? '') ||
					b.observed_at.localeCompare(a.observed_at) ||
					a.id.localeCompare(b.id)
			);
	}
	return {
		plans: [...plans.values()].sort(
			(a, b) =>
				a.provider.localeCompare(b.provider) ||
				a.name.localeCompare(b.name) ||
				a.id.localeCompare(b.id)
		)
	};
}
export function benefitMoney(value: number | null, currency: string, hidden: boolean): string {
	if (value === null) return 'Not reported';
	if (hidden) return 'Hidden';
	return value.toLocaleString('en-US', { style: 'currency', currency });
}
function savedPrivacy(storage: Pick<Storage, 'getItem'> | undefined): Row {
	try {
		const value = JSON.parse(storage?.getItem(STORAGE_KEY) ?? '{}');
		return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
	} catch {
		return {};
	}
}
export function readBenefitPrivacy(storage: Pick<Storage, 'getItem'> | undefined): boolean {
	return savedPrivacy(storage).hideAmounts === true;
}
/** Patch only this preference so visiting benefits cannot reset the chart's saved filters. */
export function writeBenefitPrivacy(
	storage: Pick<Storage, 'getItem' | 'setItem'> | undefined,
	value: boolean
): void {
	try {
		storage?.setItem(STORAGE_KEY, JSON.stringify({ ...savedPrivacy(storage), hideAmounts: value }));
	} catch {
		/* Storage can be disabled. */
	}
}
