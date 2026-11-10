import type { Txn } from './types';
export interface Trip {
	id: string;
	name: string;
	intervals: { start: string; end: string }[];
}
export interface TripData {
	trips: Trip[];
	settlements: Record<string, string[]>;
	assignments?: TripAssignment[];
	unavailable?: boolean;
}
export interface TripAssignment {
	id: string;
	piece_kind: 'txn' | 'share';
	txn_source: string | null;
	txn_source_id: string | null;
	share_id: string | null;
	trip_id: string | null;
}
export function tripAssignments(rows: Record<string, unknown>[]): TripAssignment[] {
	const seen = new Set<string>();
	return rows
		.filter((r) => r.deleted_at == null)
		.map((r) => {
			const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
			if (
				!(
					(r.piece_kind === 'txn' &&
						text(r.txn_source) &&
						text(r.txn_source_id) &&
						r.share_id === null) ||
					(r.piece_kind === 'share' &&
						r.txn_source === null &&
						r.txn_source_id === null &&
						text(r.share_id))
				) ||
				!(r.trip_id === null || text(r.trip_id))
			)
				throw Error('Invalid trip assignment');
			const id = [
				...new TextEncoder().encode(
					JSON.stringify([r.piece_kind, r.txn_source, r.txn_source_id, r.share_id])
				)
			]
				.map((b) => b.toString(16).padStart(2, '0'))
				.join('');
			if (r.id !== id || seen.has(id)) throw Error('Invalid trip assignment identity');
			seen.add(id);
			return {
				id,
				piece_kind: r.piece_kind,
				txn_source: r.txn_source,
				txn_source_id: r.txn_source_id,
				share_id: r.share_id,
				trip_id: r.trip_id
			} as TripAssignment;
		});
}
export const AMBIGUOUS_TRIP = 'trip:ambiguous';
export const UNASSIGNED_TRIP = 'trip:unassigned';
export const UNAVAILABLE_TRIP = 'trip:unavailable';
export const tripKey = (id: string) => 'trip:id:' + id;
export function assignmentMatches(a: TripAssignment, t: Txn): boolean {
	return t.share_id
		? a.piece_kind === 'share' && a.share_id === t.share_id
		: t.share_id === undefined &&
				!t.shares?.length &&
				!t.standalone &&
				a.piece_kind === 'txn' &&
				a.txn_source === t.source &&
				a.txn_source_id === t.source_id;
}
export function tripFor(
	t: Txn,
	data?: TripData
): { key: string; candidates: string[]; reason: string } {
	if (!data || data.unavailable)
		return { key: UNAVAILABLE_TRIP, candidates: [], reason: 'Trip data unavailable' };
	const assigned = (data.assignments ?? []).filter((a) => assignmentMatches(a, t));
	const targets = [...new Set(assigned.map((a) => a.trip_id))];
	if (targets.length > 1)
		return {
			key: AMBIGUOUS_TRIP,
			candidates: targets.filter((id): id is string => id !== null),
			reason: 'Conflicting trip assignments'
		};
	const explicit = [
		...new Set([
			...(data.settlements[t.source + ':' + t.source_id] ?? []),
			...targets.filter((id): id is string => id !== null)
		])
	].sort();
	if (explicit.length) {
		if (explicit.length === 1 && data.trips.some((x) => x.id === explicit[0]))
			return {
				key: tripKey(explicit[0]),
				candidates: explicit,
				reason: targets[0] ? 'Owner assignment' : 'Settlement link'
			};
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
