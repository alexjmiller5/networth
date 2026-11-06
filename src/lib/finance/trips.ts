import type { Txn } from './types';
export interface Trip {
	id: string;
	name: string;
	intervals: { start: string; end: string }[];
}
export interface TripData {
	trips: Trip[];
	settlements: Record<string, string[]>;
	unavailable?: boolean;
}
export const AMBIGUOUS_TRIP = 'trip:ambiguous';
export const UNASSIGNED_TRIP = 'trip:unassigned';
export const UNAVAILABLE_TRIP = 'trip:unavailable';
export const tripKey = (id: string) => 'trip:id:' + id;
export function tripFor(
	t: Txn,
	data?: TripData
): { key: string; candidates: string[]; reason: string } {
	if (!data || data.unavailable)
		return { key: UNAVAILABLE_TRIP, candidates: [], reason: 'Trip data unavailable' };
	const explicit = [...new Set(data.settlements[t.source + ':' + t.source_id] ?? [])].sort();
	if (explicit.length) {
		if (explicit.length === 1 && data.trips.some((x) => x.id === explicit[0]))
			return { key: tripKey(explicit[0]), candidates: explicit, reason: 'Settlement link' };
		return {
			key: AMBIGUOUS_TRIP,
			candidates: explicit,
			reason: 'Conflicting or unavailable trip links'
		};
	}
	const candidates = data.trips.filter((x) =>
		x.intervals.some((r) => t.date >= r.start && t.date <= r.end)
	);
	const ids = candidates.map((x) => x.id).sort();
	if (candidates.some((x) => x.intervals.length > 1))
		return { key: AMBIGUOUS_TRIP, candidates: ids, reason: 'Conflicting trip dates' };
	return ids.length === 1
		? { key: tripKey(ids[0]), candidates: ids, reason: 'Date match' }
		: ids.length
			? { key: AMBIGUOUS_TRIP, candidates: ids, reason: 'Overlapping trips' }
			: { key: UNASSIGNED_TRIP, candidates: [], reason: 'No dated trip match' };
}
function day(value: unknown): string {
	if (
		typeof value !== 'string' ||
		!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
		!Number.isFinite(Date.parse(value)) ||
		new Date(value).toISOString().slice(0, 10) !== value
	)
		throw Error('Invalid trip date');
	return value;
}
export function tripRegistry(
	rows: Record<string, unknown>[],
	claims: Record<string, unknown>[]
): Trip[] {
	const live = rows.filter((r) => r.deleted_at == null);
	const trips = new Map(
		live.map((r) => {
			if (typeof r.id !== 'string' || !r.id || typeof r.name !== 'string' || !r.name)
				throw Error('Invalid trip identity');
			return [r.id, { id: r.id, name: r.name, intervals: [] } as Trip] as const;
		})
	);
	if (trips.size !== live.length) throw Error('Duplicate trip identity');
	for (const c of claims) {
		if (typeof c.notion_id !== 'string' || !c.notion_id) throw Error('Invalid trip claim identity');
		const start = day(c.start),
			end = day(c.end);
		if (start > end) throw Error('Invalid trip interval');
		if (c.start_tst != null && c.start_tst !== Date.parse(start) / 1000)
			throw Error('Invalid trip boundary');
		if (c.end_tst != null && c.end_tst !== Date.parse(end) / 1000 + 86400)
			throw Error('Invalid trip boundary');
		const trip = trips.get(c.notion_id);
		if (!trip) continue;
		if (!trip.intervals.some((r) => r.start === start && r.end === end))
			trip.intervals.push({ start, end });
	}
	return [...trips.values()].sort((a, b) => a.id.localeCompare(b.id));
}
export function tripLabel(key: string, data?: TripData): string {
	if (key === AMBIGUOUS_TRIP) return 'Ambiguous trips';
	if (key === UNASSIGNED_TRIP) return 'Unassigned';
	if (key === UNAVAILABLE_TRIP) return 'Trip data unavailable';
	return data?.trips.find((t) => tripKey(t.id) === key)?.name ?? 'Unavailable trip';
}
