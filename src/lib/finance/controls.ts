import type { Account, AccountCoverage, AssetClass, Category, GroupBy, Txn } from './types';
import { addDays, clampRange, getPresetRange, PRESET_LABELS, type PresetLabel } from './presets';
import {
	accumulate,
	accountGroup,
	assetClass,
	bucketize,
	deriveBalances,
	differentiate,
	flowPieces,
	flowSeries,
	groupSeries,
	netTotals,
	type Bucket
} from './series';

export const STORAGE_KEY = 'networth-ui';
export const GROUPS = ['account', 'bank', 'type', 'asset', 'category'] as const;
export const FRIEND_PAID = 'friend-paid';
export interface Controls {
	presentation: 'chart' | 'overview';
	accountStatuses: ('open' | 'closed')[];
	assetClasses: AssetClass[];
	balanceSources: ('accounts' | 'rewards')[];
	measure: 'balances' | 'activity';
	activePreset: PresetLabel | '';
	dateStart: string;
	dateEnd: string;
	bucket: Bucket;
	groupBy: GroupBy;
	kind: 'bar' | 'area' | 'line';
	flows: ('spending' | 'income')[];
	cumulativeChoice: boolean | null;
	hidden: Record<GroupBy, string[]>;
}
const record = (v: unknown): Record<string, unknown> =>
	v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const strings = (v: unknown): string[] =>
	Array.isArray(v) && v.every((s) => typeof s === 'string') ? [...new Set(v)] : [];
const parse = (raw: string | null): unknown => {
	try {
		return JSON.parse(raw ?? '{}');
	} catch {
		return null;
	}
};
const choice = <T extends string>(saved: unknown, choices: readonly T[], fallback: T): T =>
	choices.includes(saved as T) ? (saved as T) : fallback;
const PARAMS = [
	'preset',
	'start',
	'end',
	'bucket',
	'group',
	'chart',
	'flows',
	'cum',
	'hide',
	...GROUPS.map((g) => `hide.${g}`)
];

/** Remove dashboard state from existing links without disturbing other URL parameters. */
export function clearControlParams(params: URLSearchParams): URLSearchParams {
	const clean = new URLSearchParams(params);
	for (const key of PARAMS) clean.delete(key);
	return clean;
}

export function readControls(
	storage: Pick<Storage, 'getItem'> | undefined,
	min: string,
	max: string
): Controls {
	let saved: Record<string, unknown> = {};
	try {
		saved = record(parse(storage?.getItem(STORAGE_KEY) ?? null));
	} catch {
		/* Storage may be disabled. */
	}
	const groupBy = choice(saved.groupBy, GROUPS, 'account');
	const activePreset = choice(saved.activePreset, [...PRESET_LABELS, ''], '1Y');
	const custom = activePreset === '';
	const range = custom
		? clampRange(saved.dateStart, saved.dateEnd, min, max)
		: getPresetRange(activePreset as PresetLabel, min, max);
	const validFlows = (v: unknown): v is Controls['flows'] =>
		Array.isArray(v) && v.length > 0 && v.every((f) => f === 'spending' || f === 'income');
	const flows = validFlows(saved.flows)
		? [...new Set(saved.flows)]
		: (['spending', 'income'] as Controls['flows']);
	const accountStatuses = strings(saved.accountStatuses).filter(
		(s): s is 'open' | 'closed' => s === 'open' || s === 'closed'
	);
	const assetClasses = strings(saved.assetClasses).filter(
		(s): s is AssetClass => s === 'cash' || s === 'investments'
	);
	const balanceSources = strings(saved.balanceSources).filter(
		(s): s is 'accounts' | 'rewards' => s === 'accounts' || s === 'rewards'
	);
	const savedHidden = record(saved.hidden);
	const hidden = Object.fromEntries(
		GROUPS.map((g) => [g, strings(savedHidden[g])])
	) as Controls['hidden'];
	if (!('hidden' in saved)) hidden[groupBy] = strings(saved.excluded);
	return {
		presentation: choice(saved.presentation, ['chart', 'overview'], 'chart'),
		accountStatuses: accountStatuses.length
			? accountStatuses
			: saved.includeClosed === false
				? ['open']
				: ['open', 'closed'],
		assetClasses: assetClasses.length ? assetClasses : ['cash', 'investments'],
		balanceSources: balanceSources.length ? balanceSources : ['accounts', 'rewards'],
		measure:
			groupBy === 'category'
				? 'activity'
				: choice(
						saved.measure,
						['balances', 'activity'],
						flows.length === 1 ? 'activity' : 'balances'
					),
		activePreset: custom ? '' : activePreset,
		dateStart: range.start,
		dateEnd: range.end,
		bucket: choice(saved.bucket, ['day', 'week', 'month'], 'day'),
		groupBy,
		kind: choice(saved.kind, ['bar', 'area', 'line'], 'bar'),
		flows,
		cumulativeChoice: typeof saved.cumulativeChoice === 'boolean' ? saved.cumulativeChoice : null,
		hidden
	};
}

export function writeControls(
	storage: Pick<Storage, 'setItem'> | undefined,
	state: Controls
): boolean {
	if (!storage) return false;
	try {
		storage.setItem(STORAGE_KEY, JSON.stringify(state));
		return true;
	} catch {
		return false;
	}
}

export function toggleHidden(
	hidden: Controls['hidden'],
	group: GroupBy,
	key: string,
	applicable: string[]
): Controls['hidden'] {
	let next = hidden[group].includes(key)
		? hidden[group].filter((k) => k !== key)
		: [...hidden[group], key];
	if (applicable.length && applicable.every((k) => next.includes(k)))
		next = next.filter((k) => !applicable.includes(k));
	return { ...hidden, [group]: next };
}

/** The chart, headline, dropdown and legend all consume the same view. */
export function buildView(
	txns: Txn[],
	accounts: Account[],
	categories: Category[],
	state: Controls,
	coverage?: AccountCoverage[]
) {
	accounts = accounts.filter(
		(a) =>
			state.accountStatuses.includes(a.closed ? 'closed' : 'open') &&
			state.assetClasses.includes(assetClass(a)) &&
			state.balanceSources.includes(a.type === 'stored_value' ? 'rewards' : 'accounts')
	);
	const ids = new Set(accounts.map((a) => a.id));
	txns = txns.filter((t) =>
		t.standalone
			? state.accountStatuses.includes('open') &&
				state.assetClasses.includes('cash') &&
				state.balanceSources.includes('accounts')
			: ids.has(t.account_id ?? '')
	);
	const { groupBy, bucket, dateStart: start, dateEnd: end } = state;
	const mode = state.flows.length === 1 ? state.flows[0] : 'signed';
	const isFlow = state.measure === 'activity' || groupBy === 'category';
	const cumulative = state.presentation === 'overview' || (state.cumulativeChoice ?? !isFlow);
	const accountOf = new Map(accounts.map((a) => [a.id, a]));
	const keyOf = (t: Txn) => {
		if (groupBy === 'category') return t.category;
		if (t.standalone) return FRIEND_PAID;
		const account = accountOf.get(t.account_id ?? '');
		return account ? accountGroup(account, groupBy) : undefined;
	};
	const verified = coverage
		? accounts.filter((a) =>
				coverage.some(
					(c) => c.account_id === a.id && c.status === 'verified' && c.basis === 'money'
				)
			)
		: accounts;
	let base;
	if (isFlow) base = flowSeries(txns, start, end, bucket, keyOf, mode);
	else {
		base = bucketize(
			groupSeries(deriveBalances(txns, verified, start, end), verified, groupBy),
			bucket
		);
		if (!cumulative) {
			const before = addDays(start, -1);
			const initial = groupSeries(
				deriveBalances(txns, verified, before, before),
				verified,
				groupBy
			);
			base = differentiate(base, new Map(initial.series.map((s) => [s.key, s.data[0]])));
		}
	}
	const registry =
		groupBy === 'category'
			? [...categories]
					.sort((a, b) => a.sort - b.sort || a.id.localeCompare(b.id))
					.map((c) => c.name)
			: [
					...new Set(
						[...accounts]
							.sort((a, b) => a.id.localeCompare(b.id))
							.map((a) => accountGroup(a, groupBy))
					)
				];
	if (groupBy !== 'category' && txns.some((t) => t.standalone)) registry.push(FRIEND_PAID);
	const keys = [
		...new Set([
			...registry,
			...base.series
				.map((s) => s.key)
				.filter((k) => !registry.includes(k))
				.sort()
		])
	];
	const applicable = base.series.map((s) => s.key);
	const requested = state.hidden[groupBy];
	const hidden =
		applicable.length && applicable.every((k) => requested.includes(k))
			? requested.filter((k) => !applicable.includes(k))
			: requested;
	let data = { ...base, series: base.series.filter((s) => !hidden.includes(s.key)) };
	if (isFlow && cumulative) data = accumulate(data);
	const totals = netTotals(data);
	const total = cumulative
		? (totals.at(-1) ?? 0)
		: Math.round(totals.reduce((sum, v) => sum + v, 0) * 100) / 100;
	const values = new Map(
		data.series.map((s) => [
			s.key,
			cumulative ? (s.data.at(-1) ?? 0) : Math.round(s.data.reduce((n, v) => n + v, 0) * 100) / 100
		])
	);
	const summary = keys
		.filter((key) => !hidden.includes(key) && (isFlow || key !== FRIEND_PAID))
		.map((key) => ({ key, value: values.get(key) ?? null }));
	const title = !isFlow
		? cumulative
			? 'Verified balance subtotal'
			: 'Verified balance change'
		: mode === 'spending'
			? 'Spending'
			: mode === 'income'
				? 'Income'
				: 'Net flow';
	const uncategorized = flowPieces(txns).filter((t) => {
		if (t.category || t.date < start || t.date > end || t.categoryKind === 'transfer') return false;
		const kind =
			!t.categoryKind || t.categoryKind === 'unknown'
				? t.amount < 0
					? 'spending'
					: 'income'
				: t.categoryKind;
		if (mode !== 'signed' && kind !== mode) return false;
		if (groupBy === 'category') return true;
		const key = keyOf(t);
		return !!key && !hidden.includes(key);
	}).length;
	return {
		data,
		keys,
		applicable,
		hidden,
		isFlow,
		cumulative,
		total,
		title,
		uncategorized,
		summary,
		accountIds: accounts.map((a) => a.id)
	};
}

/** Names follow the account's real effective dates, not when metadata was edited. */
export function accountLabel(account: Account, start: string, end = start): string {
	let since = '';
	const names: string[] = [];
	for (const previous of account.nameHistory ?? []) {
		if (start < previous.until && end >= since) names.push(previous.name);
		since = previous.until;
	}
	if (end >= since) names.push(account.name);
	return [...new Set(names)].join(' / ');
}

export function pointsAt<T extends { program: string; scrapedAt?: string }>(
	rows: T[],
	end: string
): T[] {
	const latest = new Map<string, T>();
	for (const row of rows) {
		if (!row.scrapedAt || row.scrapedAt.slice(0, 10) > end) continue;
		const previous = latest.get(row.program);
		if (!previous || (previous.scrapedAt ?? '') < row.scrapedAt) latest.set(row.program, row);
	}
	return [...latest.values()].sort((a, b) => a.program.localeCompare(b.program));
}
