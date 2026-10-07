import { isDate } from './presets';

export type InvestmentRow = Record<string, unknown>;
export const INVESTMENT_METRICS = {
	position_units: 'Native units',
	unit_price: 'Unit price',
	market_value: 'Reported market value',
	cash_balance: 'Custody cash'
} as const;
type Metric = keyof typeof INVESTMENT_METRICS;
type Representation = 'security' | 'custody_cash' | 'unresolved';
export interface InvestmentObservation {
	id: string;
	instrument_id: string;
	metric: Metric;
	exact_amount: string | null;
	currency: string | null;
	value_status: 'reported' | 'missing';
	missing_reason: string | null;
	price_kind: string | null;
	source_date: string | null;
	source_at: string | null;
	time_basis: string;
	quote_delay_seconds: number | null;
	captured_at: string;
	supersedes_id: string | null;
}
export interface InvestmentGroup {
	key: string;
	metric: Metric;
	price_kind: string | null;
	currency: string | null;
	time_basis: string;
	precision: 'date' | 'timestamp' | 'undated';
	status:
		| 'available'
		| 'missing'
		| 'conflict'
		| 'invalid-history'
		| 'incomplete'
		| 'undated'
		| 'unresolved';
	selected: InvestmentObservation | null;
}
export interface InvestmentInstrument {
	id: string;
	account_id: string;
	provider_source: string;
	native_security_id: string;
	native_label: string | null;
	ticker: string | null;
	share_class: string | null;
	representation: Representation;
	observations: InvestmentObservation[];
	groups: InvestmentGroup[];
}
export interface Investments {
	instruments: InvestmentInstrument[];
}
function fail(): never {
	throw new Error('Invalid investment data');
}
function text(value: unknown): string {
	if (typeof value !== 'string' || !value.length || !value.isWellFormed()) return fail();
	return value;
}
const optional = (value: unknown): string | null => (value == null ? null : text(value));
function oneOf<T extends string>(value: unknown, options: readonly T[]): T {
	return options.includes(value as T) ? (value as T) : fail();
}
function instant(value: unknown): string {
	const result = text(value);
	if (
		!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(result) ||
		!Number.isFinite(Date.parse(result)) ||
		new Date(result).toISOString() !== result
	)
		fail();
	return result;
}
function decimal(value: unknown): string {
	const result = text(value);
	if (
		!/^-?(0|[1-9]\d*)(\.\d*[1-9])?$/.test(result) ||
		result === '-0' ||
		result.replace(/[-.]/g, '').length > 100 ||
		(result.split('.')[1]?.length ?? 0) > 50
	)
		fail();
	return result;
}
/** Matches the source contract's Python ensure_ascii JSON, without Unicode normalization. */
export async function investmentIdentity(
	tuple: [string, string, string | null, string | null, string, string]
): Promise<string> {
	if (tuple.length !== 6) fail();
	for (const [index, value] of tuple.entries()) {
		if ((index === 2 || index === 3) && value === null) continue;
		text(value);
	}
	const bytes = JSON.stringify(['investment_instruments:v1', ...tuple]).replace(
		/[\u007f-\uffff]/g,
		(char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
	);
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(bytes));
	return 'ii_' + [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function observation(row: InvestmentRow, instrument: InvestmentInstrument): InvestmentObservation {
	const metric = oneOf(row.metric, Object.keys(INVESTMENT_METRICS) as Metric[]);
	const value_status = oneOf(row.value_status, ['reported', 'missing']);
	const exact_amount = value_status === 'reported' ? decimal(row.exact_amount) : null;
	const missing_reason = optional(row.missing_reason);
	if (
		value_status === 'missing'
			? row.exact_amount != null || !missing_reason
			: missing_reason !== null
	)
		fail();
	const currency = optional(row.currency);
	if (currency !== null && !Intl.supportedValuesOf('currency').includes(currency)) fail();
	const price_kind =
		row.price_kind == null
			? null
			: oneOf(row.price_kind, ['nav', 'last', 'close', 'bid', 'ask', 'provider_unspecified']);
	const source_date =
		row.source_date == null ? null : isDate(row.source_date) ? row.source_date : fail();
	const source_at = row.source_at == null ? null : instant(row.source_at);
	const time_basis = oneOf(row.time_basis, [
		'holdings_as_of',
		'nav_as_of',
		'price_last_updated',
		'quote_refresh',
		'market_value_as_of',
		'cash_as_of',
		'observation_only',
		'unknown'
	]);
	if (source_date && source_at) fail();
	if (!source_date && !source_at && !['observation_only', 'unknown'].includes(time_basis)) fail();
	if ((source_date || source_at) && ['observation_only', 'unknown'].includes(time_basis)) fail();
	const delay = row.quote_delay_seconds ?? null;
	if (delay !== null && (typeof delay !== 'number' || !Number.isSafeInteger(delay) || delay < 0))
		fail();
	if (
		instrument.representation === 'custody_cash'
			? metric !== 'cash_balance'
			: metric === 'cash_balance'
	)
		fail();
	if (metric === 'position_units' ? currency !== null : currency === null) fail();
	if (metric === 'unit_price') {
		if (!price_kind || exact_amount?.startsWith('-')) fail();
		if (price_kind === 'nav' && !['nav_as_of', 'unknown'].includes(time_basis)) fail();
	} else if (price_kind !== null || delay !== null) fail();
	const clocks: Record<Metric, string[]> = {
		position_units: ['holdings_as_of'],
		unit_price: ['nav_as_of', 'price_last_updated', 'quote_refresh'],
		market_value: ['market_value_as_of'],
		cash_balance: ['cash_as_of']
	};
	if (![...clocks[metric], 'observation_only', 'unknown'].includes(time_basis)) fail();
	text(row.capture_key); // Evidence identifiers are validated, never returned to the browser.
	return {
		id: text(row.id),
		instrument_id: instrument.id,
		metric,
		exact_amount,
		currency,
		value_status,
		missing_reason,
		price_kind,
		source_date,
		source_at,
		time_basis,
		quote_delay_seconds: delay as number | null,
		captured_at: instant(row.captured_at),
		supersedes_id: optional(row.supersedes_id)
	};
}
const graphKey = (row: InvestmentObservation) =>
	JSON.stringify([row.instrument_id, row.metric, row.price_kind]);
const precision = (row: InvestmentObservation): InvestmentGroup['precision'] =>
	row.source_date ? 'date' : row.source_at ? 'timestamp' : 'undated';
const partitionKey = (row: InvestmentObservation) =>
	JSON.stringify([graphKey(row), row.time_basis, row.currency, precision(row)]);
const assertion = (row: InvestmentObservation) =>
	JSON.stringify([row.value_status, row.exact_amount, row.missing_reason, row.quote_delay_seconds]);

/** Native facts only. Membership must be complete before a correction graph may select a value. */
export function assembleInvestments(
	instrumentRows: InvestmentRow[],
	observationRows: InvestmentRow[],
	options: { complete: boolean; asOf: string }
): Investments {
	if (!isDate(options.asOf)) fail();
	const instruments = new Map<string, InvestmentInstrument>();
	const deletedInstruments = new Set(
		instrumentRows.filter((r) => r.deleted_at != null).map((r) => r.id)
	);
	for (const row of instrumentRows.filter((r) => r.deleted_at == null)) {
		const id = text(row.id);
		if (instruments.has(id) || deletedInstruments.has(id)) fail();
		const kind = oneOf(row.native_id_kind, ['plan_fund_code', 'provider_security_id', 'ticker']);
		const account = optional(row.provider_account_id),
			plan = optional(row.provider_plan_id);
		if ((!account && !plan) || (kind === 'plan_fund_code' && !plan)) fail();
		instant(row.identity_observed_at);
		instruments.set(id, {
			id,
			account_id: text(row.account_id),
			provider_source: text(row.provider_source),
			native_security_id: text(row.native_security_id),
			native_label: optional(row.native_label),
			ticker: optional(row.ticker),
			share_class: optional(row.share_class),
			representation: oneOf(row.representation, ['security', 'custody_cash', 'unresolved']),
			observations: [],
			groups: []
		});
	}
	const rows: InvestmentObservation[] = [];
	const byId = new Map<string, InvestmentObservation>();
	const invalid = new Set<string>();
	const successors = new Map<string, InvestmentObservation[]>();
	for (const raw of observationRows.filter((r) => r.deleted_at == null)) {
		if (deletedInstruments.has(raw.instrument_id)) continue;
		const instrument = instruments.get(text(raw.instrument_id));
		if (!instrument) fail();
		const row = observation(raw, instrument);
		const duplicate = byId.get(row.id);
		if (duplicate) {
			invalid.add(graphKey(duplicate));
			invalid.add(graphKey(row));
		}
		byId.set(row.id, row);
		rows.push(row);
		instrument.observations.push(row);
		if (row.supersedes_id)
			successors.set(row.supersedes_id, [...(successors.get(row.supersedes_id) ?? []), row]);
	}
	for (const row of rows) {
		if (!row.supersedes_id) continue;
		const predecessor = byId.get(row.supersedes_id);
		if (!predecessor || graphKey(predecessor) !== graphKey(row)) {
			invalid.add(graphKey(row));
			if (predecessor) invalid.add(graphKey(predecessor));
		}
		if ((successors.get(row.supersedes_id)?.length ?? 0) > 1) {
			for (const sibling of successors.get(row.supersedes_id)!) invalid.add(graphKey(sibling));
			if (predecessor) invalid.add(graphKey(predecessor));
		}
	}
	// Iterative traversal avoids a stack overflow on long retained histories.
	const checked = new Set<string>();
	for (const start of rows) {
		const path = new Set<string>();
		let current: InvestmentObservation | undefined = start;
		while (current && !checked.has(current.id)) {
			if (path.has(current.id)) {
				for (const id of path) invalid.add(graphKey(byId.get(id)!));
				break;
			}
			path.add(current.id);
			current = current.supersedes_id ? byId.get(current.supersedes_id) : undefined;
		}
		for (const id of path) checked.add(id);
	}
	for (const instrument of instruments.values()) {
		const partitions = new Map<string, InvestmentObservation[]>();
		for (const row of instrument.observations) {
			if ((row.source_date ?? row.source_at?.slice(0, 10) ?? '') > options.asOf) continue;
			// Keep invalid histories visible, including their affected partition labels.
			if (options.complete && !invalid.has(graphKey(row)) && successors.has(row.id)) continue;
			const key = partitionKey(row);
			partitions.set(key, [...(partitions.get(key) ?? []), row]);
		}
		for (const [key, candidates] of partitions) {
			candidates.sort(
				(a, b) =>
					(b.source_date ?? b.source_at ?? '').localeCompare(a.source_date ?? a.source_at ?? '') ||
					b.captured_at.localeCompare(a.captured_at) ||
					a.id.localeCompare(b.id)
			);
			const first = candidates[0];
			let status: InvestmentGroup['status'] = !options.complete
				? 'incomplete'
				: invalid.has(graphKey(first))
					? 'invalid-history'
					: instrument.representation === 'unresolved'
						? 'unresolved'
						: precision(first) === 'undated'
							? 'undated'
							: first.value_status === 'missing'
								? 'missing'
								: 'available';
			if (
				['available', 'missing'].includes(status) &&
				candidates.some(
					(r) =>
						(r.source_date ?? r.source_at) === (first.source_date ?? first.source_at) &&
						assertion(r) !== assertion(first)
				)
			)
				status = 'conflict';
			instrument.groups.push({
				key,
				metric: first.metric,
				price_kind: first.price_kind,
				currency: first.currency,
				time_basis: first.time_basis,
				precision: precision(first),
				status,
				selected: ['available', 'missing'].includes(status) ? first : null
			});
		}
	}
	return { instruments: [...instruments.values()] };
}
