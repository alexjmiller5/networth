import { isDate } from './presets';
import { selectRewardEventHeads, type RewardEventVersion } from './reward-history';

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
	status: 'available' | 'conflict' | 'invalid-history' | 'incomplete' | 'undated';
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
}
interface Program {
	id: string;
	label: string;
	provider: string;
	account_id: string | null;
	components: Component[];
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
		let status: BalanceGroup['status'] = !complete
			? 'incomplete'
			: invalid.has(balanceScope(first))
				? 'invalid-history'
				: precision(first) === 'undated'
					? 'undated'
					: 'available';
		if (
			status === 'available' &&
			candidates.some(
				(r) =>
					(r.source_date ?? r.source_as_of) === (first.source_date ?? first.source_as_of) &&
					r.exact_amount !== first.exact_amount
			)
		)
			status = 'conflict';
		result.set(first.component_id, [
			...(result.get(first.component_id) ?? []),
			{
				key,
				basis: first.basis,
				precision: precision(first),
				status,
				selected: status === 'available' ? first : null
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
	options: { complete: boolean }
): Rewards {
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
			components: []
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
			diagnostics: []
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
	return { programs: [...programs.values()], legacyBalances };
}
