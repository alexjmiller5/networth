import { addDays, isDate } from './presets';
import type { Bucket } from './series';

export interface MarkerInput {
	date: string;
	end: string | null;
	title: string;
}
export interface Marker extends MarkerInput {
	id: string;
	revision: number;
}
export const MARKER_TITLE_MAX = 200;
export function parseMarker(value: unknown): MarkerInput {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error('Provide a date and title.');
	const row = value as Record<string, unknown>;
	if (Object.keys(row).some((k) => !['date', 'end', 'title'].includes(k)))
		throw new Error('Unexpected marker field.');
	if (!isDate(row.date) || row.date.startsWith('0000')) throw new Error('Choose a valid date.');
	const end = row.end ?? null;
	if (end !== null && (!isDate(end) || end < row.date))
		throw new Error('End date must be on or after the start.');
	if (
		typeof row.title !== 'string' ||
		!row.title.trim() ||
		row.title.trim().length > MARKER_TITLE_MAX ||
		/[\u0000-\u001f\u007f]/u.test(row.title) ||
		!row.title.isWellFormed()
	)
		throw new Error(`Enter a title of 1-${MARKER_TITLE_MAX} characters.`);
	return { date: row.date, end, title: row.title.trim() };
}
export function visibleMarkers(markers: Marker[], start: string, end: string): Marker[] {
	return markers.filter((m) => m.date <= end && (m.end ?? m.date) >= start);
}
function bucketDate(date: string, bucket: Bucket): string {
	if (bucket === 'month') return date.slice(0, 7);
	if (bucket === 'week') return addDays(date, -((new Date(date).getUTCDay() + 6) % 7));
	return date;
}
export function markerBuckets(
	marker: MarkerInput,
	dates: string[],
	bucket: Bucket
): { start: number; end: number } | null {
	const from = bucketDate(marker.date, bucket),
		to = bucketDate(marker.end ?? marker.date, bucket);
	const labels = dates.map((date) => bucketDate(date, bucket));
	const start = labels.findIndex((d) => d >= from && d <= to);
	if (start < 0) return null;
	let end = start;
	while (end + 1 < labels.length && labels[end + 1] <= to) end++;
	return { start, end };
}
export function markerText(marker: MarkerInput, hideAmounts: boolean): string {
	return `${marker.date}${marker.end ? ` to ${marker.end}` : ''}: ${hideAmounts ? 'Hidden marker' : marker.title}`;
}
export function assignLane(
	placed: { lane: number; left: number; right: number }[],
	left: number,
	right: number
): number {
	for (let lane = 0; ; lane++)
		if (!placed.some((p) => p.lane === lane && left < p.right && right > p.left)) return lane;
}
export function markerLabelBounds(x: number, textWidth: number, min: number, max: number) {
	const width = Math.max(0, Math.min(textWidth + 8, 140, max - min));
	return { left: Math.max(min, Math.min(x - width / 2, max - width)), width };
}
