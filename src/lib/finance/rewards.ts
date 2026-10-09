import { addDays, isDate } from './presets';
import {
	selectRedemptionValuationHeads,
	selectRewardEventHeads,
	selectRewardTermHeads,
	type RewardEventVersion
} from './reward-history';
import {
	canonical,
	decimal as exact,
	multiply,
	quotient,
	subtract,
	type Decimal
} from './redemption-valuation';

export type RewardRow = Record<string, unknown>;
interface RewardEvent extends RewardEventVersion {
	event_date: string | null;
	occurred_at: string | null;
	posted_date: string | null;
	units_delta: string | null;
	observed_at: string;
}
interface Balance {
	id: string;
	component_id: string;
	basis: string;
	exact_amount: string;
	scraped_at: string;
	source_date: string | null;
	source_as_of: string | null;
	period_start: string | null;
	period_end_exclusive: string | null;
	supersedes_id: string | null;
}
interface BalanceGroup {
	key: string;
	basis: string;
	precision: 'date' | 'timestamp' | 'undated';
	/** captured = latest undated capture, shown with its capture time; never a source-dated balance. */
	status: 'available' | 'captured' | 'conflict' | 'invalid-history' | 'incomplete';
	selected: Balance | null;
}
interface Component {
	id: string;
	program_id: string;
	label: string;
	unit: string;
	role: 'redeemable' | 'qualifying' | 'cash_reward' | 'certificate';
	currency: string | null;
	events: RewardEvent[];
	balances: Balance[];
	balanceGroups: BalanceGroup[];
	earned: string | null;
	pendingEarned: string | null;
	redeemed: string | null;
	expired: string | null;
	diagnostics: string[];
	expiry: ExpiryClock;
	earningRate: EarningRate;
	/** Dollar view of the current available balance: exact cash, or an owner-valued estimate. */
	dollar: { value: string; estimated: boolean } | null;
	redemptions: { event: RewardEvent; valuation: Valuation | null }[];
}
interface Program {
	id: string;
	label: string;
	provider: string;
	account_id: string | null;
	components: Component[];
	terms: Term[];
	caps: CapHeadroom[];
	/** Owner-entered dollars per native unit (Networth's own store), not a provider fact. */
	value: { value_per_unit: string; revision: number } | null;
}
export interface Term {
	id: string;
	program_id: string;
	component_id: string | null;
	term_key: string;
	kind:
		'earning' | 'cap' | 'election' | 'tier' | 'redemption_method' | 'expiry' | 'valuation_estimate';
	applicability: 'public_unverified' | 'account_observed' | 'owner_confirmed';
	effective_from: string | null;
	effective_until: string | null;
	source_as_of: string | null;
	payload: Record<string, unknown>;
	supersedes_id: string | null;
}
interface Valuation {
	id: string;
	event_id: string;
	basis: 'user_override' | 'provider_comparable' | 'estimate';
	comparable_amount: string;
	currency: string;
	comparable_scope: string;
	reward_value: string;
	rate_at_redemption: string;
	units_consumed: string;
	valued_at: string;
	supersedes_id: string | null;
}
export interface ExpiryClock {
	status: 'scheduled' | 'none' | 'unknown';
	expiresOn: string | null;
	/** False when only public program policy applies; it is not verified for this account. */
	verified: boolean;
	reason: string;
}
export interface EarningRate {
	status: 'available' | 'unavailable';
	/** Native units per unit of linked spend currency. */
	rate: string | null;
	earned: string | null;
	spend: string | null;
	currency: string | null;
	events: number;
	reason: string | null;
}
export interface CapHeadroom {
	key: string;
	status: 'available' | 'unavailable';
	unit: string | null;
	limit: string | null;
	used: string | null;
	remaining: string | null;
	resetsOn: string | null;
	reason: string | null;
}
export interface RewardOptions {
	complete: boolean;
	/** UTC calendar date that clocks and periods are evaluated on. */
	today?: string;
	terms?: RewardRow[];
	valuations?: RewardRow[];
	values?: { program_id: string; value_per_unit: string; revision: number }[];
	/** Card spend proved for an exact earning event (provenance txn -> reward_events edges). */
	links?: { event_id: string; amount: string; currency: string }[];
}
export interface Rewards {
	programs: Program[];
	legacyBalances: { id: string; program: string; points: number; scraped_at: string }[];
}
function fail(): never {
	throw new Error('Invalid reward data');
}
const text = (v: unknown): string =>
	typeof v === 'string' && v.length && v.isWellFormed() ? v : fail();
const optional = (v: unknown): string | null => (v == null ? null : text(v));
function choice<T extends string>(v: unknown, options: readonly T[]): T {
	return options.includes(v as T) ? (v as T) : fail();
}
const date = (v: unknown): string | null => (v == null ? null : isDate(v) ? v : fail());
function instant(v: unknown): string {
	const s = text(v);
	if (
		!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(s) ||
		!Number.isFinite(Date.parse(s)) ||
		new Date(s).toISOString() !== s
	)
		fail();
	return s;
}
function decimal(v: unknown): string {
	const s = text(v);
	if (
		!/^-?(0|[1-9]\d*)(\.\d*[1-9])?$/.test(s) ||
		s === '-0' ||
		s.replace(/[-.]/g, '').length > 100 ||
		(s.split('.')[1]?.length ?? 0) > 50
	)
		fail();
	return s;
}
export function sumRewardUnits(values: string[]): string | null {
	if (!values.length) return null;
	const scale = values.reduce((n, v) => Math.max(n, v.split('.')[1]?.length ?? 0), 0);
	const total = values.reduce((n, v) => {
		const [a, b = ''] = v.split('.');
		return n + BigInt(a + b) * 10n ** BigInt(scale - b.length);
	}, 0n);
	const abs = (total < 0n ? -total : total).toString().padStart(scale + 1, '0');
	const result = scale
		? (abs.slice(0, -scale) + '.' + abs.slice(-scale)).replace(/\.?0+$/, '')
		: abs;
	return (total < 0n ? '-' : '') + result;
}
const balanceScope = (row: Balance) => JSON.stringify([row.component_id, row.basis]);
const precision = (row: Balance): BalanceGroup['precision'] =>
	row.source_date ? 'date' : row.source_as_of ? 'timestamp' : 'undated';
function balanceGroups(rows: Balance[], complete: boolean): Map<string, BalanceGroup[]> {
	const index = new Map<string, Balance>();
	const invalid = new Set<string>();
	const next = new Map<string, Balance[]>();
	for (const row of rows) {
		const prior = index.get(row.id);
		if (prior) {
			invalid.add(balanceScope(row));
			invalid.add(balanceScope(prior));
		}
		index.set(row.id, row);
		if (row.supersedes_id)
			next.set(row.supersedes_id, [...(next.get(row.supersedes_id) ?? []), row]);
	}
	for (const row of rows) {
		if (!row.supersedes_id) continue;
		const previous = index.get(row.supersedes_id);
		if (
			!previous ||
			balanceScope(previous) !== balanceScope(row) ||
			(next.get(row.supersedes_id)?.length ?? 0) > 1
		) {
			invalid.add(balanceScope(row));
			if (previous) invalid.add(balanceScope(previous));
		}
	}
	const checked = new Set<string>();
	for (const row of rows) {
		const path = new Set<string>();
		let cursor: Balance | undefined = row;
		while (cursor && !checked.has(cursor.id)) {
			if (path.has(cursor.id)) {
				for (const id of path) invalid.add(balanceScope(index.get(id)!));
				break;
			}
			path.add(cursor.id);
			cursor = cursor.supersedes_id ? index.get(cursor.supersedes_id) : undefined;
		}
		for (const id of path) checked.add(id);
	}
	const partitions = new Map<string, Balance[]>();
	for (const row of rows) {
		if (complete && !invalid.has(balanceScope(row)) && next.has(row.id)) continue;
		const key = JSON.stringify([
			balanceScope(row),
			precision(row),
			row.period_start,
			row.period_end_exclusive
		]);
		partitions.set(key, [...(partitions.get(key) ?? []), row]);
	}
	const result = new Map<string, BalanceGroup[]>();
	for (const [key, candidates] of partitions) {
		candidates.sort(
			(a, b) =>
				(b.source_date ?? b.source_as_of ?? '').localeCompare(
					a.source_date ?? a.source_as_of ?? ''
				) ||
				b.scraped_at.localeCompare(a.scraped_at) ||
				a.id.localeCompare(b.id)
		);
		const first = candidates[0];
		const undated = precision(first) === 'undated';
		// Undated captures order by capture time only; a capture never outranks a dated fact.
		const clock = (r: Balance) => (undated ? r.scraped_at : (r.source_date ?? r.source_as_of));
		let status: BalanceGroup['status'] = !complete
			? 'incomplete'
			: invalid.has(balanceScope(first))
				? 'invalid-history'
				: undated
					? 'captured'
					: 'available';
		if (
			(status === 'available' || status === 'captured') &&
			candidates.some((r) => clock(r) === clock(first) && r.exact_amount !== first.exact_amount)
		)
			status = 'conflict';
		result.set(first.component_id, [
			...(result.get(first.component_id) ?? []),
			{
				key,
				basis: first.basis,
				precision: precision(first),
				status,
				selected: status === 'available' || status === 'captured' ? first : null
			}
		]);
	}
	return result;
}

/** Known source events only; snapshots and unlike components never become an earning total. */
export function assembleRewards(
	programRows: RewardRow[],
	componentRows: RewardRow[],
	eventRows: RewardRow[],
	balanceRows: RewardRow[],
	options: RewardOptions
): Rewards {
	const today = options.today ?? new Date().toISOString().slice(0, 10);
	if (!isDate(today)) fail();
	const programs = new Map<string, Program>(),
		components = new Map<string, Component>();
	for (const row of programRows.filter((r) => r.deleted_at == null)) {
		const id = text(row.id);
		if (programs.has(id)) fail();
		programs.set(id, {
			id,
			label: text(row.label),
			provider: text(row.provider),
			account_id: optional(row.account_id),
			components: [],
			terms: [],
			caps: [],
			value: null
		});
	}
	const componentKeys = new Set<string>();
	for (const row of componentRows.filter((r) => r.deleted_at == null)) {
		const id = text(row.id),
			program_id = text(row.program_id),
			program = programs.get(program_id),
			key = JSON.stringify([program_id, text(row.component_key)]);
		if (!program || components.has(id) || componentKeys.has(key)) fail();
		componentKeys.add(key);
		const unit = text(row.unit);
		const currency = optional(row.currency);
		if (currency ? unit !== currency : Intl.supportedValuesOf('currency').includes(unit)) fail();
		if (currency && !Intl.supportedValuesOf('currency').includes(currency)) fail();
		const role = choice(row.role, ['redeemable', 'qualifying', 'cash_reward', 'certificate']);
		if (role === 'cash_reward' && !currency) fail();
		const component: Component = {
			id,
			program_id,
			label: text(row.label),
			unit,
			role,
			currency,
			events: [],
			balances: [],
			balanceGroups: [],
			earned: null,
			pendingEarned: null,
			redeemed: null,
			expired: null,
			diagnostics: [],
			expiry: { status: 'unknown', expiresOn: null, verified: false, reason: '' },
			earningRate: unavailableRate(''),
			dollar: null,
			redemptions: []
		};
		components.set(id, component);
		program.components.push(component);
	}
	const events: RewardEvent[] = [];
	for (const row of eventRows.filter((r) => r.deleted_at == null)) {
		const component_id = text(row.component_id),
			component = components.get(component_id);
		if (!component) fail();
		const kind = choice(row.kind, ['earn', 'redeem', 'expire', 'adjust', 'transfer', 'reversal']);
		const units_delta = row.units_delta == null ? null : decimal(row.units_delta);
		if (
			units_delta !== null &&
			((kind === 'earn' && units_delta.startsWith('-')) ||
				(['redeem', 'expire'].includes(kind) &&
					units_delta !== '0' &&
					!units_delta.startsWith('-')))
		)
			fail();
		const value: RewardEvent = {
			id: text(row.id),
			component_id,
			event_key: text(row.event_key),
			kind,
			state: choice(row.state, ['posted', 'pending', 'unknown']),
			event_date: date(row.event_date),
			occurred_at: row.occurred_at == null ? null : instant(row.occurred_at),
			posted_date: date(row.posted_date),
			units_delta,
			observed_at: instant(row.observed_at),
			supersedes_id: optional(row.supersedes_id)
		};
		events.push(value);
		component.events.push(value);
	}
	const heads = selectRewardEventHeads(events);
	for (const component of components.values()) {
		const groups = heads.filter((g) => g.scope.component_id === component.id);
		if (!options.complete) component.diagnostics.push('Complete event history unavailable');
		if (groups.some((g) => g.diagnostics.length))
			component.diagnostics.push('Event correction history needs review');
		if (groups.some((g) => g.head?.units_delta === null || g.head?.state === 'unknown'))
			component.diagnostics.push('Some event amounts or posting states are unknown');
		if (!component.diagnostics.length) {
			const values = (kind: RewardEvent['kind'], state: RewardEvent['state'], positive = false) =>
				groups.flatMap((g) =>
					g.head?.kind === kind && g.head.state === state && g.head.units_delta !== null
						? [positive ? g.head.units_delta.replace(/^-/, '') : g.head.units_delta]
						: []
				);
			component.earned = sumRewardUnits(values('earn', 'posted'));
			component.pendingEarned = sumRewardUnits(values('earn', 'pending'));
			component.redeemed = sumRewardUnits(values('redeem', 'posted', true));
			component.expired = sumRewardUnits(values('expire', 'posted', true));
		}
	}
	const legacyBalances: Rewards['legacyBalances'] = [];
	const balances: Balance[] = [];
	for (const row of balanceRows.filter((r) => r.deleted_at == null)) {
		if (row.component_id == null) {
			if (row.exact_amount != null || row.basis != null) fail();
			if (typeof row.points !== 'number' || !Number.isFinite(row.points)) fail();
			legacyBalances.push({
				id: text(row.id),
				program: text(row.program),
				points: row.points,
				scraped_at: instant(row.scraped_at)
			});
			continue;
		}
		const component_id = text(row.component_id),
			component = components.get(component_id);
		if (!component) fail();
		const basis = choice(row.basis, [
			'available',
			'pending',
			'earned_period',
			'lifetime',
			'qualifying'
		]);
		if ((basis === 'qualifying') !== (component.role === 'qualifying')) fail();
		const exact_amount = decimal(row.exact_amount);
		if (
			typeof row.points !== 'number' ||
			!Number.isFinite(row.points) ||
			Number(exact_amount) !== row.points
		)
			fail();
		const source_date = date(row.source_date),
			source_as_of = row.source_as_of == null ? null : instant(row.source_as_of),
			period_start = date(row.period_start),
			period_end_exclusive = date(row.period_end_exclusive);
		if (source_date && source_as_of) fail();
		if (
			Boolean(period_start) !== Boolean(period_end_exclusive) ||
			(period_start && period_end_exclusive && period_end_exclusive <= period_start) ||
			(basis === 'earned_period' && !period_start)
		)
			fail();
		const value: Balance = {
			id: text(row.id),
			component_id,
			basis,
			exact_amount,
			scraped_at: instant(row.scraped_at),
			source_date,
			source_as_of,
			period_start,
			period_end_exclusive,
			supersedes_id: optional(row.supersedes_id)
		};
		balances.push(value);
		component.balances.push(value);
	}
	// An approved legacy replacement preserves the original three facts. Its untyped
	// predecessor participates in graph validation only, never in typed arithmetic.
	const legacyIndex = new Map(legacyBalances.map((row) => [row.id, row]));
	if (legacyIndex.size !== legacyBalances.length) fail();
	const originalRows = new Map(balanceRows.map((row) => [row.id, row]));
	const stubs = new Map<string, Balance>();
	for (const row of balances) {
		if (!row.supersedes_id) continue;
		const legacy = legacyIndex.get(row.supersedes_id),
			original = originalRows.get(row.id);
		if (
			legacy &&
			original &&
			legacy.program === original.program &&
			legacy.points === original.points &&
			legacy.scraped_at === row.scraped_at &&
			!stubs.has(legacy.id)
		)
			stubs.set(legacy.id, { ...row, id: legacy.id, supersedes_id: null });
	}
	const selected = balanceGroups([...balances, ...stubs.values()], options.complete);
	for (const component of components.values())
		component.balanceGroups = selected.get(component.id) ?? [];
	const terms = (options.terms ?? []).filter((r) => r.deleted_at == null).map(parseTerm);
	for (const term of terms) {
		const program = programs.get(term.program_id);
		if (!program) fail();
		if (term.component_id && components.get(term.component_id)?.program_id !== term.program_id)
			fail();
	}
	const termHeads = selectRewardTermHeads(terms).flatMap((g) => (g.head ? [g.head] : []));
	for (const program of programs.values()) {
		program.terms = termHeads.filter((t) => t.program_id === program.id && inEffect(t, today));
		program.caps = program.terms
			.filter((t) => t.kind === 'cap')
			.map((t) =>
				options.complete
					? capHeadroom(t, today)
					: {
							...capHeadroom(t, today),
							status: 'unavailable',
							remaining: null,
							reason: 'Complete term history unavailable.'
						}
			);
	}
	for (const row of options.values ?? []) {
		const program = programs.get(row.program_id);
		if (!program) continue; // A value outlives a retired program without breaking the view.
		if (program.value || !Number.isSafeInteger(row.revision) || row.revision < 1) fail();
		program.value = { value_per_unit: nonnegative(row.value_per_unit), revision: row.revision };
	}
	const valuations = (options.valuations ?? [])
		.filter((r) => r.deleted_at == null)
		.map(parseValuation);
	const valuationHeads = selectRedemptionValuationHeads(events, valuations);
	const links = (options.links ?? []).map((l) => ({
		event_id: text(l.event_id),
		amount: decimal(l.amount),
		currency: text(l.currency)
	}));
	for (const component of components.values()) {
		const program = programs.get(component.program_id)!;
		const scoped = program.terms.filter(
			(t) =>
				t.component_id === component.id ||
				(t.component_id === null && component.role !== 'qualifying')
		);
		component.expiry = !options.complete
			? {
					status: 'unknown',
					expiresOn: null,
					verified: false,
					reason: 'Complete term history unavailable.'
				}
			: component.role === 'qualifying'
				? {
						status: 'unknown',
						expiresOn: null,
						verified: false,
						reason: 'Qualifying counters do not expire as a balance.'
					}
				: expiryClock(
						scoped.filter((t) => t.kind === 'expiry'),
						today
					);
		component.earningRate = options.complete
			? earningRate(component.events, links)
			: unavailableRate('Complete event history unavailable.');
		const available = currentBalance(component, 'available');
		component.dollar = available ? dollarValue(component, available.amount, program) : null;
		for (const group of selectRewardEventHeads(component.events)) {
			const head = group.head;
			if (!head || head.kind !== 'redeem' || head.state !== 'posted') continue;
			const chain = valuationHeads.find(
				(v) => v.scope?.component_id === component.id && v.scope.event_key === head.event_key
			);
			component.redemptions.push({ event: head, valuation: chain?.current ?? null });
		}
	}
	return { programs: [...programs.values()], legacyBalances };
}

const applicabilityRank = { public_unverified: 0, account_observed: 1, owner_confirmed: 2 };
function parseTerm(row: RewardRow): Term {
	let payload = row.payload;
	// The hub returns json columns as text; local replicas and tests may pass objects.
	if (typeof payload === 'string')
		try {
			payload = JSON.parse(payload);
		} catch {
			fail();
		}
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail();
	const value: Term = {
		id: text(row.id),
		program_id: text(row.program_id),
		component_id: optional(row.component_id),
		term_key: text(row.term_key),
		kind: choice(row.kind, [
			'earning',
			'cap',
			'election',
			'tier',
			'redemption_method',
			'expiry',
			'valuation_estimate'
		]),
		applicability: choice(row.applicability, [
			'public_unverified',
			'account_observed',
			'owner_confirmed'
		]),
		effective_from: date(row.effective_from),
		effective_until: date(row.effective_until),
		source_as_of: date(row.source_as_of),
		payload: payload as Record<string, unknown>,
		supersedes_id: optional(row.supersedes_id)
	};
	if (value.payload.schema_version !== 1) fail();
	if (
		value.effective_from &&
		value.effective_until &&
		value.effective_until <= value.effective_from
	)
		fail();
	return value;
}
function parseValuation(row: RewardRow): Valuation {
	return {
		id: text(row.id),
		event_id: text(row.event_id),
		basis: choice(row.basis, ['user_override', 'provider_comparable', 'estimate']),
		comparable_amount: nonnegative(row.comparable_amount),
		currency: text(row.currency),
		comparable_scope: text(row.comparable_scope),
		reward_value: nonnegative(row.reward_value),
		rate_at_redemption: nonnegative(row.rate_at_redemption),
		units_consumed: nonnegative(row.units_consumed),
		valued_at: instant(row.valued_at),
		supersedes_id: optional(row.supersedes_id)
	};
}
function nonnegative(v: unknown): string {
	const s = decimal(v);
	if (s.startsWith('-')) fail();
	return s;
}
const inEffect = (t: Term, today: string) =>
	(!t.effective_from || t.effective_from <= today) &&
	(!t.effective_until || today < t.effective_until);
const field = (t: Term, key: string): string | null => {
	const v = t.payload[key];
	return v == null ? null : text(v);
};
const quantity = (t: Term, key: string): string | null => {
	const v = t.payload[key];
	return v == null ? null : decimal(v);
};

/** Calendar arithmetic on date labels; month ends clamp (Jan 31 + 1 month = Feb 28). */
function addPeriod(start: string, amount: number, unit: string): string {
	if (unit === 'day') return addDays(start, amount);
	const months = unit === 'year' ? amount * 12 : unit === 'month' ? amount : fail();
	const [y, m, d] = start.split('-').map(Number);
	const target = new Date(Date.UTC(y, m - 1 + months, 1));
	const last = new Date(
		Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)
	).getUTCDate();
	target.setUTCDate(Math.min(d, last));
	return target.toISOString().slice(0, 10);
}
export function quarterOf(day: string): { start: string; end: string } {
	const [y, m] = day.split('-').map(Number);
	const first = Math.floor((m - 1) / 3) * 3 + 1;
	const start = `${y}-${String(first).padStart(2, '0')}-01`;
	return { start, end: addPeriod(start, 3, 'month') };
}

/** Only stated deadlines or a stated activity date produce a date; capture time never does. */
export function expiryClock(terms: Term[], today: string): ExpiryClock {
	const unknown = (reason: string, verified = false): ExpiryClock => ({
		status: 'unknown',
		expiresOn: null,
		verified,
		reason
	});
	if (!terms.length) return unknown('No expiry terms are published for this unit.');
	const top = Math.max(...terms.map((t) => applicabilityRank[t.applicability]));
	const verified = top > 0;
	const outcomes = terms
		.filter((t) => applicabilityRank[t.applicability] === top)
		.map((t): ExpiryClock => {
			const type = field(t, 'type');
			const stated = t.payload.expires_on == null ? null : date(t.payload.expires_on);
			if (type === 'no_scheduled_expiry')
				return {
					status: 'none',
					expiresOn: null,
					verified,
					reason: verified
						? 'No scheduled expiry for this account.'
						: 'Public program policy: no scheduled expiry. Not verified for this account.'
				};
			if (stated)
				return stated > today
					? {
							status: 'scheduled',
							expiresOn: stated,
							verified,
							reason: 'Provider-stated deadline.'
						}
					: unknown('The stated deadline has passed; a newer source is needed.', verified);
			if (type === 'inactivity') {
				const last =
					t.payload.last_qualifying_activity == null
						? null
						: date(t.payload.last_qualifying_activity);
				const duration = t.payload.duration;
				const unit = field(t, 'duration_unit');
				if (
					!verified ||
					!last ||
					typeof duration !== 'number' ||
					!Number.isSafeInteger(duration) ||
					!unit
				)
					return unknown(
						'Inactivity rule; the last qualifying activity date is not established.',
						verified
					);
				return {
					status: 'scheduled',
					expiresOn: addPeriod(last, duration, unit),
					verified,
					reason: 'Inactivity clock from the stated last qualifying activity.'
				};
			}
			if (type === 'fixed_duration')
				return unknown('Expiry runs per earning lot; lot dates are not established.', verified);
			if (type === 'provider_deadline')
				return unknown('Provider deadline date is not stated.', verified);
			return unknown('Expiry rule is unknown.', verified);
		});
	if (outcomes.every((o) => o.status === 'scheduled'))
		return outcomes.reduce((a, b) => (b.expiresOn! < a.expiresOn! ? b : a));
	const kinds = new Set(outcomes.map((o) => o.status));
	if (kinds.size > 1) return unknown('Conflicting expiry terms; review the sources.', verified);
	return outcomes[0];
}

function capPeriod(t: Term, today: string): { start: string; end: string } | null {
	const start = t.payload.period_start == null ? null : date(t.payload.period_start);
	const end = t.payload.period_end_exclusive == null ? null : date(t.payload.period_end_exclusive);
	if (start && end) return start <= today && today < end ? { start, end } : null;
	const kind = field(t, 'period_kind');
	if (kind === 'calendar_quarter') return quarterOf(today);
	if (kind === 'calendar_year') {
		const y = Number(today.slice(0, 4));
		return { start: `${y}-01-01`, end: `${y + 1}-01-01` };
	}
	return null;
}
/** Provider-observed usage only; a public cap rule alone never implies usage. */
export function capHeadroom(t: Term, today: string): CapHeadroom {
	const limit = quantity(t, 'limit'),
		used = quantity(t, 'observed_usage'),
		period = capPeriod(t, today);
	const base = {
		key: field(t, 'shared_cap_key') ?? t.term_key,
		unit: field(t, 'unit'),
		limit,
		used,
		resetsOn: period?.end ?? null
	};
	const reason = !limit
		? 'The cap limit is not stated.'
		: !used || t.applicability === 'public_unverified'
			? 'Cap usage has not been observed for this account.'
			: !period
				? 'The current cap period is not established.'
				: null;
	if (reason) return { ...base, status: 'unavailable', remaining: null, reason };
	const left = subtract(exact(limit), exact(used!));
	return {
		...base,
		status: 'available',
		remaining: left.coefficient > 0n ? canonical(left) : '0',
		reason: null
	};
}

const unavailableRate = (reason: string): EarningRate => ({
	status: 'unavailable',
	rate: null,
	earned: null,
	spend: null,
	currency: null,
	events: 0,
	reason
});
/** Observed earned units / proved linked spend. Unlinked earnings and pending heads never count. */
export function earningRate(
	events: RewardEvent[],
	links: { event_id: string; amount: string; currency: string }[]
): EarningRate {
	const groups = selectRewardEventHeads(events);
	if (groups.some((g) => g.diagnostics.length))
		return unavailableRate('Event correction history needs review.');
	const earned: string[] = [],
		spend: string[] = [],
		currencies = new Set<string>();
	for (const g of groups) {
		const head = g.head!;
		if (head.kind !== 'earn' || head.state !== 'posted' || head.units_delta === null) continue;
		const ids = new Set(g.history.map((r) => r.id));
		const linked = links.filter((l) => ids.has(l.event_id));
		if (!linked.length) continue;
		earned.push(head.units_delta);
		for (const l of linked) {
			spend.push(l.amount);
			currencies.add(l.currency);
		}
	}
	if (!earned.length) return unavailableRate('No posted earning events are linked to card spend.');
	if (currencies.size > 1) return unavailableRate('Linked spend uses more than one currency.');
	const units = sumRewardUnits(earned)!,
		total = sumRewardUnits(spend)!;
	if (exact(total).coefficient <= 0n) return unavailableRate('Linked spend is not positive.');
	return {
		status: 'available',
		rate: quotient(exact(units), exact(total), 6),
		earned: units,
		spend: total,
		currency: [...currencies][0],
		events: earned.length,
		reason: null
	};
}

/** Exact cash, or native units times the owner's value. Qualifying counters have no dollar value. */
export function dollarValue(
	component: Pick<Component, 'role' | 'currency'>,
	amount: string,
	program: Pick<Program, 'value'>
): { value: string; estimated: boolean } | null {
	if (component.currency === 'USD') return { value: amount, estimated: false };
	if (component.currency || component.role === 'qualifying' || !program.value) return null;
	return {
		value: canonical(roundCents(multiply(exact(amount), exact(program.value.value_per_unit)))),
		estimated: true
	};
}
function roundCents(value: Decimal): Decimal {
	if (value.scale <= 2) return value;
	return exact(quotient(value, { coefficient: 1n, scale: 0 }, 2));
}

/** Current balance for a basis: a source-dated selection first, else the latest capture. */
export function currentBalance(
	component: Pick<Component, 'balanceGroups'>,
	basis: string
): { amount: string; asOf: string; captured: boolean } | null {
	const groups = component.balanceGroups.filter((g) => g.basis === basis && g.selected);
	const dated = groups
		.filter((g) => g.status === 'available' && !g.selected!.period_start)
		.map((g) => g.selected!)
		.sort((a, b) =>
			(b.source_date ?? b.source_as_of!).localeCompare(a.source_date ?? a.source_as_of!)
		);
	if (dated.length)
		return {
			amount: dated[0].exact_amount,
			asOf: dated[0].source_date ?? dated[0].source_as_of!,
			captured: false
		};
	const captured = groups.find(
		(g) => g.status === 'captured' && !g.selected!.period_start
	)?.selected;
	return captured
		? { amount: captured.exact_amount, asOf: captured.scraped_at, captured: true }
		: null;
}

export interface Guidance {
	periodStart: string;
	periodEnd: string;
	categories: {
		category: string;
		spent: string;
		/** Card id with the single best comparable value, only when every card is known. */
		pick: string | null;
		cards: {
			id: string;
			label: string;
			status: 'rate' | 'unknown' | 'conflict';
			rate: string | null;
			unit: string | null;
			/** Dollars per dollar of spend; estimated when it relies on an owner value. */
			value: string | null;
			estimated: boolean;
			headroom: string | null;
		}[];
	}[];
}
/** Which card per category this quarter, from verified typed terms only; unknown is never a guess. */
export function cardGuidance(input: {
	rewards: Rewards;
	cards: { id: string; label: string }[];
	spending: { account_id: string; category: string; amount: number; date: string }[];
	today: string;
}): Guidance {
	const period = quarterOf(input.today);
	const totals = new Map<string, number>();
	for (const s of input.spending)
		if (s.date >= period.start && s.date <= input.today)
			totals.set(s.category, Math.round(((totals.get(s.category) ?? 0) + s.amount) * 100) / 100);
	const categories = [...totals]
		.filter(([, v]) => v > 0)
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	return {
		periodStart: period.start,
		periodEnd: period.end,
		categories: categories.map(([category, spent]) => {
			const cards = input.cards.map((card) => ({
				id: card.id,
				label: card.label,
				...cardRate(input.rewards, card.id, category, input.today)
			}));
			const known = cards.every((c) => c.status === 'rate' && c.value !== null);
			let pick: string | null = null;
			if (known && cards.length) {
				const best = cards.reduce((a, b) => (compare(b.value!, a.value!) > 0 ? b : a));
				if (cards.filter((c) => compare(c.value!, best.value!) === 0).length === 1) pick = best.id;
			}
			return {
				category,
				spent: canonical(exact(spent.toFixed(2).replace(/\.?0+$/, '') || '0')),
				pick,
				cards
			};
		})
	};
}
function compare(a: string, b: string): number {
	const d = subtract(exact(a), exact(b)).coefficient;
	return d > 0n ? 1 : d < 0n ? -1 : 0;
}
function cardRate(rewards: Rewards, cardId: string, category: string, today: string) {
	const none = { rate: null, unit: null, value: null, estimated: false, headroom: null };
	const unknown = { status: 'unknown' as const, ...none };
	const programs = rewards.programs.filter((p) => p.account_id === cardId);
	if (programs.length !== 1) return unknown;
	const program = programs[0];
	const verified = program.terms.filter((t) => t.applicability !== 'public_unverified');
	const earning = verified.filter(
		(t) =>
			t.kind === 'earning' &&
			field(t, 'basis') === 'spend' &&
			field(t, 'basis_currency') === 'USD' &&
			quantity(t, 'numerator') &&
			quantity(t, 'denominator') &&
			exact(quantity(t, 'denominator')!).coefficient > 0n
	);
	const bonus = earning.filter((t) => field(t, 'category_key') === category);
	const base = earning.filter(
		(t) => field(t, 'category_key') === null && field(t, 'base_or_bonus') === 'base'
	);
	if (bonus.length > 1 || base.length > 1) return { status: 'conflict' as const, ...none };
	const satisfied = (t: Term) => {
		const election = field(t, 'required_election_key'),
			tier = field(t, 'required_tier_key');
		return (
			(!election ||
				verified.some(
					(e) =>
						e.kind === 'election' &&
						e.term_key === election &&
						field(e, 'category_key') === category &&
						field(e, 'enrollment') === 'enrolled'
				)) &&
			(!tier || verified.some((e) => e.kind === 'tier' && e.term_key === tier))
		);
	};
	let rule = bonus.find(satisfied) ?? null;
	let headroom: string | null = null;
	const capKey = rule && field(rule, 'cap_key');
	if (rule && capKey) {
		const cap = program.caps.find((c) => c.key === capKey);
		if (!cap || cap.status !== 'available') return unknown;
		headroom = cap.remaining;
		if (headroom === '0') rule = null;
	}
	rule ??= base[0] ?? null;
	if (!rule) return unknown;
	const component = rule.component_id
		? program.components.find((c) => c.id === rule!.component_id)
		: program.components.filter((c) => c.role !== 'qualifying').length === 1
			? program.components.find((c) => c.role !== 'qualifying')
			: undefined;
	if (!component) return unknown;
	const rate = quotient(
		exact(quantity(rule, 'numerator')!),
		exact(quantity(rule, 'denominator')!),
		6
	);
	const value =
		component.currency === 'USD'
			? { value: rate, estimated: false }
			: dollarValue(component, rate, program);
	return {
		status: 'rate' as const,
		rate,
		unit: component.unit,
		value: value ? canonical(exact(value.value)) : null,
		estimated: value?.estimated ?? false,
		headroom
	};
}
