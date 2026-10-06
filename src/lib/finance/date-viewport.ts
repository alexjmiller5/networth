export type DateWindow = { start: string; end: string };
export const dayNumber = (date: string): number => Date.parse(`${date}T00:00:00Z`) / 86_400_000;
export const dateString = (day: number): string =>
	new Date(day * 86_400_000).toISOString().slice(0, 10);
const clamp = (value: number, min: number, max: number): number =>
	Math.max(min, Math.min(max, value));

/** A fixed calendar-day scale, independent of the selected interval. */
export function dateViewport(min: string, max: string, anchor = max): DateWindow {
	const lo = dayNumber(min),
		hi = dayNumber(max);
	const width = Math.min(90, hi - lo);
	const end = clamp(dayNumber(anchor), lo + width, hi);
	return { start: dateString(end - width), end: dateString(end) };
}
export function moveSelection(
	selection: DateWindow,
	delta: number,
	min: string,
	max: string
): DateWindow {
	const start = dayNumber(selection.start),
		end = dayNumber(selection.end);
	const shift = clamp(delta, dayNumber(min) - start, dayNumber(max) - end);
	return { start: dateString(start + shift), end: dateString(end + shift) };
}
export const panViewport = moveSelection;
