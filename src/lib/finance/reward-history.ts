export interface RewardEventScope {
	component_id: string;
	event_key: string;
}
interface Version {
	id: string;
	supersedes_id: string | null;
}
export interface RewardEventVersion extends Version, RewardEventScope {
	kind: 'earn' | 'redeem' | 'expire' | 'adjust' | 'transfer' | 'reversal';
	state: 'posted' | 'pending' | 'unknown';
}
export interface HistoryDiagnostic {
	code:
		| 'duplicate_id'
		| 'fork'
		| 'cycle'
		| 'missing_predecessor'
		| 'cross_scope_predecessor'
		| 'multiple_roots'
		| 'missing_event'
		| 'ambiguous_event'
		| 'invalid_event_history'
		| 'not_redemption';
	row_ids: string[];
}
export interface RewardEventHistory<T extends RewardEventVersion> {
	scope: RewardEventScope;
	history: T[];
	head: T | null;
	diagnostics: HistoryDiagnostic[];
}
interface Group<T extends Version> {
	key: string;
	scope: RewardEventScope | null;
	rows: T[];
	diagnostics: HistoryDiagnostic[];
}
const scopeKey = (scope: RewardEventScope) => JSON.stringify([scope.component_id, scope.event_key]);
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function diagnose<T extends Version>(
	group: Group<T>,
	code: HistoryDiagnostic['code'],
	ids: string[]
) {
	const row_ids = [...new Set(ids)].sort(order);
	if (
		!group.diagnostics.some(
			(d) => d.code === code && JSON.stringify(d.row_ids) === JSON.stringify(row_ids)
		)
	)
		group.diagnostics.push({ code, row_ids });
}

/** Only chain structure is shared. No date, amount or valuation basis selects a winner. */
function resolveChains<T extends Version>(groups: Group<T>[]) {
	const index = new Map<string, { row: T; group: Group<T> }[]>();
	for (const group of groups)
		for (const row of group.rows) index.set(row.id, [...(index.get(row.id) ?? []), { row, group }]);
	const successors = new Map<string, T[]>();
	for (const entries of index.values())
		if (entries.length > 1)
			for (const { row, group } of entries) diagnose(group, 'duplicate_id', [row.id]);
	for (const group of groups)
		for (const row of group.rows) {
			if (row.supersedes_id === null) continue;
			const previous = index.get(row.supersedes_id);
			if (!previous) diagnose(group, 'missing_predecessor', [row.id, row.supersedes_id]);
			else if (previous.length !== 1) diagnose(group, 'duplicate_id', [row.id, row.supersedes_id]);
			else if (previous[0].group !== group) {
				diagnose(group, 'cross_scope_predecessor', [row.id, row.supersedes_id]);
				diagnose(previous[0].group, 'cross_scope_predecessor', [row.id, row.supersedes_id]);
			} else successors.set(row.supersedes_id, [...(successors.get(row.supersedes_id) ?? []), row]);
		}
	return groups
		.sort((a, b) => order(a.key, b.key))
		.map((group) => {
			const roots = group.rows.filter((row) => row.supersedes_id === null);
			if (roots.length > 1)
				diagnose(
					group,
					'multiple_roots',
					roots.map((row) => row.id)
				);
			for (const row of group.rows) {
				const children = successors.get(row.id) ?? [];
				if (children.length > 1)
					diagnose(group, 'fork', [row.id, ...children.map((child) => child.id)]);
			}
			const visited = new Set<string>();
			for (const row of group.rows) {
				let cursor: T | undefined = row;
				const path: string[] = [],
					positions = new Map<string, number>();
				while (cursor && !visited.has(cursor.id)) {
					const cycleStart = positions.get(cursor.id);
					if (cycleStart !== undefined) {
						diagnose(group, 'cycle', path.slice(cycleStart));
						break;
					}
					positions.set(cursor.id, path.length);
					path.push(cursor.id);
					const previous: { row: T; group: Group<T> }[] | undefined =
						cursor.supersedes_id === null ? undefined : index.get(cursor.supersedes_id);
					cursor =
						previous?.length === 1 && previous[0].group === group ? previous[0].row : undefined;
				}
				for (const id of path) visited.add(id);
			}
			const head = group.diagnostics.length
				? null
				: (group.rows.find((row) => !successors.has(row.id)) ?? null);
			let history = [...group.rows].sort((a, b) => order(a.id, b.id));
			if (head) {
				history = [];
				let cursor: T | undefined = head;
				while (cursor) {
					history.push(cursor);
					cursor =
						cursor.supersedes_id === null ? undefined : index.get(cursor.supersedes_id)![0].row;
				}
				history.reverse();
			}
			return {
				scope: group.scope,
				history,
				head,
				diagnostics: group.diagnostics.sort((a, b) => order(JSON.stringify(a), JSON.stringify(b)))
			};
		});
}

/** Complete immutable event rows only; snapshots never imply events or earnings.
 * Valid history is root-to-head. Invalid groups retain all rows with no selected head.
 * Row schema, evidence and publication authority remain the catalog/writer's responsibility.
 */
export function selectRewardEventHeads<T extends RewardEventVersion>(
	events: readonly T[]
): RewardEventHistory<T>[] {
	const groups = new Map<string, Group<T>>();
	for (const row of events) {
		const scope = { component_id: row.component_id, event_key: row.event_key },
			key = scopeKey(scope);
		const group = groups.get(key) ?? { key, scope, rows: [], diagnostics: [] };
		group.rows.push(row);
		groups.set(key, group);
	}
	return resolveChains([...groups.values()]).map((result) => ({ ...result, scope: result.scope! }));
}

export interface RedemptionValuationVersion extends Version {
	event_id: string;
	basis: 'user_override' | 'provider_comparable' | 'estimate';
}
export interface RedemptionValuationHistory<T extends RedemptionValuationVersion> {
	scope: RewardEventScope | null;
	history: T[];
	head: T | null;
	current: T | null;
	diagnostics: HistoryDiagnostic[];
}
/** A head is structurally accepted history, not an approved monetary valuation.
 * Missing/ambiguous event references retain rows under scope=null. Current never
 * falls back to an ancestor or preferred basis, and confers no publication authority.
 */
export function selectRedemptionValuationHeads<
	E extends RewardEventVersion,
	V extends RedemptionValuationVersion
>(events: readonly E[], valuations: readonly V[]): RedemptionValuationHistory<V>[] {
	const eventGroups = new Map(
		selectRewardEventHeads(events).map((group) => [scopeKey(group.scope), group])
	);
	const eventIndex = new Map<string, E[]>();
	for (const event of events)
		eventIndex.set(event.id, [...(eventIndex.get(event.id) ?? []), event]);
	const groups = new Map<string, Group<V>>();
	for (const row of valuations) {
		const matches = eventIndex.get(row.event_id) ?? [];
		const event = matches.length === 1 ? matches[0] : null;
		const scope = event ? { component_id: event.component_id, event_key: event.event_key } : null;
		const key = scope ? scopeKey(scope) : JSON.stringify(['unbound', row.event_id, null]);
		const group = groups.get(key) ?? { key, scope, rows: [], diagnostics: [] };
		group.rows.push(row);
		if (!event)
			diagnose(group, matches.length ? 'ambiguous_event' : 'missing_event', [row.id, row.event_id]);
		else {
			if (event.kind !== 'redeem') diagnose(group, 'not_redemption', [row.id, row.event_id]);
			if (!eventGroups.get(key)!.head)
				diagnose(group, 'invalid_event_history', [row.id, row.event_id]);
		}
		groups.set(key, group);
	}
	return resolveChains([...groups.values()]).map((result) => ({
		...result,
		current:
			result.head &&
			result.scope &&
			eventGroups.get(scopeKey(result.scope))!.head?.id === result.head.event_id
				? result.head
				: null
	}));
}
