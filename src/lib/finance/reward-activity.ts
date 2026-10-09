import { selectRewardEventHeads, type RewardEventVersion } from './reward-history';
import { sumRewardUnits } from './rewards';
import { bucketLabel, dateRange, type Bucket, type StackedSeries } from './series';
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

interface SeriesBalance {
	id: string;
	basis: string;
	exact_amount: string;
	scraped_at: string;
	source_date: string | null;
	source_as_of: string | null;
	supersedes_id: string | null;
}
/** Canonical series order: colors and legend positions follow the measure, never data order. */
export const REWARD_SERIES = [
	'available',
	'pending',
	'qualifying',
	'lifetime',
	'earned_period',
	'earned',
	'redeemed',
	'expired',
	'adjusted'
];
const ACTIVITY: Record<string, string> = {
	earn: 'earned',
	redeem: 'redeemed',
	expire: 'expired',
	adjust: 'adjusted',
	transfer: 'adjusted',
	reversal: 'adjusted'
};
/** One component's chart series. Balances are closing levels at each observation's own date
 * (source date, else capture day); activity is signed posted event heads by date. Geometry only:
 * displayed quantities stay exact text elsewhere. `scale` converts units for a dollar lens. */
export function rewardSeries(
	component: {
		balances: SeriesBalance[];
		events: ActivityEvent[];
		diagnostics: string[];
		balanceGroups: { basis: string; status: string }[];
	},
	measure: 'balances' | 'activity',
	start: string,
	end: string,
	bucket: Bucket,
	scale = 1
): StackedSeries {
	const labels = [...new Set(dateRange(start, end).map((d) => bucketLabel(d, bucket)))];
	const index = new Map(labels.map((l, i) => [l, i]));
	const series = new Map<string, number[]>();
	const put = (key: string, date: string, value: number, add: boolean) => {
		if (date < start || date > end) return;
		const data = series.get(key) ?? new Array<number>(labels.length).fill(0);
		const i = index.get(bucketLabel(date, bucket))!;
		data[i] = add ? data[i] + value * scale : value * scale;
		series.set(key, data);
	};
	if (measure === 'activity') {
		for (const entry of rewardActivity(component.events, component.diagnostics.length === 0)) {
			// Signed like the source: earnings above the axis, redemptions and expiry below.
			put(ACTIVITY[entry.kind], entry.date, Number(entry.value), true);
		}
	} else {
		const trusted = new Set(
			component.balanceGroups
				.map((g) => g.basis)
				.filter((basis) =>
					component.balanceGroups.every(
						(g) => g.basis !== basis || g.status === 'available' || g.status === 'captured'
					)
				)
		);
		const superseded = new Set(component.balances.map((b) => b.supersedes_id));
		const day = (b: SeriesBalance) =>
			b.source_date ?? (b.source_as_of ?? b.scraped_at).slice(0, 10);
		const rows = component.balances
			.filter((b) => trusted.has(b.basis) && !superseded.has(b.id))
			// Closing level: later day wins; on one day a source-dated fact outranks a capture.
			.sort(
				(a, b) =>
					day(a).localeCompare(day(b)) ||
					Number(Boolean(a.source_date ?? a.source_as_of)) -
						Number(Boolean(b.source_date ?? b.source_as_of)) ||
					a.scraped_at.localeCompare(b.scraped_at)
			);
		for (const b of rows) put(b.basis, day(b), Number(b.exact_amount), false);
	}
	return {
		dates: labels,
		series: REWARD_SERIES.filter((key) => series.has(key)).map((key) => ({
			key,
			data: series.get(key)!
		}))
	};
}
