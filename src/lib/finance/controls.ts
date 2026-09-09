import type { Account, AccountCoverage, Category, GroupBy, Txn } from './types';
import {
	addDays,
	clampRange,
	getPresetRange,
	isDate,
	PRESET_LABELS,
	type PresetLabel
} from './presets';
import {
	accumulate,
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
export const GROUPS = ['account', 'bank', 'type', 'category'] as const;
export const FRIEND_PAID = 'friend-paid';
export interface Controls {
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
const choice = <T extends string>(
	url: unknown,
	saved: unknown,
	choices: readonly T[],
	fallback: T
): T =>
	choices.includes(url as T) ? (url as T) : choices.includes(saved as T) ? (saved as T) : fallback;
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
export const hasControlParams = (params: URLSearchParams) => PARAMS.some((p) => params.has(p));

export function readControls(
	storage: Pick<Storage, 'getItem'> | undefined,
	params: URLSearchParams,
	min: string,
	max: string
): Controls {
	let saved: Record<string, unknown> = {};
	try {
		saved = record(parse(storage?.getItem(STORAGE_KEY) ?? null));
	} catch {
		/* Storage may be disabled. */
	}
	const groupBy = choice(params.get('group'), saved.groupBy, GROUPS, 'account');
	const presetParam = params.get('preset') === 'custom' ? '' : params.get('preset');
	const activePreset = choice(presetParam, saved.activePreset, [...PRESET_LABELS, ''], '1Y');
	const custom =
		(!params.has('preset') && (params.has('start') || params.has('end'))) || activePreset === '';
	const range = custom
		? clampRange(
				isDate(params.get('start')) ? params.get('start') : saved.dateStart,
				isDate(params.get('end')) ? params.get('end') : saved.dateEnd,
				min,
				max
			)
		: getPresetRange(activePreset as PresetLabel, min, max);
	const validFlows = (v: unknown): v is Controls['flows'] =>
		Array.isArray(v) && v.length > 0 && v.every((f) => f === 'spending' || f === 'income');
	const urlFlows = params.get('flows')?.split(',');
	const flows = validFlows(urlFlows)
		? [...new Set(urlFlows)]
		: validFlows(saved.flows)
			? [...new Set(saved.flows)]
			: (['spending', 'income'] as Controls['flows']);
	const cum = params.get('cum');
	const savedHidden = record(saved.hidden);
	const hidden = Object.fromEntries(
		GROUPS.map((g) => [
			g,
			params.has(`hide.${g}`) ? strings(parse(params.get(`hide.${g}`))) : strings(savedHidden[g])
		])
	) as Controls['hidden'];
	if (!params.has(`hide.${groupBy}`)) {
		if (params.has('hide'))
			hidden[groupBy] = strings(params.get('hide')?.split(',').filter(Boolean));
		else if (!('hidden' in saved)) hidden[groupBy] = strings(saved.excluded);
	}
	return {
		activePreset: custom ? '' : activePreset,
		dateStart: range.start,
		dateEnd: range.end,
		bucket: choice(params.get('bucket'), saved.bucket, ['day', 'week', 'month'], 'day'),
		groupBy,
		kind: choice(params.get('chart'), saved.kind, ['bar', 'area', 'line'], 'bar'),
		flows,
		cumulativeChoice:
			cum === '1'
				? true
				: cum === '0'
					? false
					: cum === 'auto'
						? null
						: typeof saved.cumulativeChoice === 'boolean'
							? saved.cumulativeChoice
							: null,
		hidden
	};
}

export function controlParams(state: Controls, original = new URLSearchParams()): URLSearchParams {
	const p = new URLSearchParams(original);
	for (const key of PARAMS) p.delete(key);
	for (const [key, value] of Object.entries({
		preset: state.activePreset || 'custom',
		start: state.dateStart,
		end: state.dateEnd,
		bucket: state.bucket,
		group: state.groupBy,
		chart: state.kind,
		flows: state.flows.join(','),
		cum: state.cumulativeChoice === null ? 'auto' : state.cumulativeChoice ? '1' : '0'
	}))
		p.set(key, value);
	for (const g of GROUPS) p.set(`hide.${g}`, JSON.stringify(state.hidden[g]));
	return p;
}

export function writeControls(
	storage: Pick<Storage, 'setItem'> | undefined,
	state: Controls,
	deepLink: boolean,
	edited = false
): boolean {
	if ((deepLink && !edited) || !storage) return false;
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
	const { groupBy, bucket, dateStart: start, dateEnd: end } = state;
	const mode = state.flows.length === 1 ? state.flows[0] : 'signed';
	const isFlow = groupBy === 'category' || mode !== 'signed';
	const cumulative = state.cumulativeChoice ?? !isFlow;
	const accountOf = new Map(accounts.map((a) => [a.id, a]));
	const keyOf = (t: Txn) =>
		groupBy === 'category'
			? t.category
			: t.standalone
				? FRIEND_PAID
				: groupBy === 'account'
					? (t.account_id ?? undefined)
					: accountOf.get(t.account_id ?? '')?.[groupBy === 'bank' ? 'bank' : 'type'];
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
							.map((a) => (groupBy === 'account' ? a.id : a[groupBy === 'bank' ? 'bank' : 'type']))
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
	return { data, keys, applicable, hidden, isFlow, cumulative, total, title, uncategorized };
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
