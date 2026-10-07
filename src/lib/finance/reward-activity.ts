import { selectRewardEventHeads, type RewardEventVersion } from './reward-history';
import { sumRewardUnits } from './rewards';
interface ActivityEvent extends RewardEventVersion {
	event_date: string | null;
	units_delta: string | null;
}
export function rewardActivity(
	rows: ActivityEvent[],
	complete: boolean
): { date: string; kind: string; value: string }[] {
	if (new Set(rows.map((r) => r.component_id)).size > 1)
		throw new Error('Unlike reward components');
	if (!complete) return [];
	const groups = selectRewardEventHeads(rows);
	if (groups.some((g) => g.diagnostics.length || !g.head || g.head.units_delta === null)) return [];
	const sums = new Map<string, { date: string; kind: string; values: string[] }>();
	for (const group of groups) {
		const row = group.head!;
		if (row.state !== 'posted' || !row.event_date) continue;
		const key = JSON.stringify([row.event_date, row.kind]);
		const result = sums.get(key) ?? { date: row.event_date, kind: row.kind, values: [] };
		result.values.push(row.units_delta!);
		sums.set(key, result);
	}
	return [...sums.values()]
		.sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind))
		.map(({ date, kind, values }) => ({ date, kind, value: sumRewardUnits(values)! }));
}
