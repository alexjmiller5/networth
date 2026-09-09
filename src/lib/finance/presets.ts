// Date-range presets, mirroring notion-task-burndown-chart's preset rules.
// Relative presets anchor to the DATA's last day (not "today" - snapshots lag),
// and every start is clamped to the data's first day.

export const PRESET_LABELS = ['7D', '30D', '90D', '1Y', 'MTD', 'YTD', 'ALL'] as const;
export type PresetLabel = (typeof PRESET_LABELS)[number];

export function isDate(value: unknown): value is string {
	if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const time = Date.parse(value);
	return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

export function clampRange(
	start: unknown,
	end: unknown,
	min: string,
	max: string
): { start: string; end: string } {
	const clamp = (date: string) => (date < min ? min : date > max ? max : date);
	const a = clamp(isDate(start) ? start : min);
	const b = clamp(isDate(end) ? end : max);
	return a <= b ? { start: a, end: b } : { start: b, end: a };
}

/** DST-safe calendar-day arithmetic on YYYY-MM-DD labels (UTC internally). */
export function addDays(date: string, days: number): string {
	const [y, m, d] = date.split('-').map(Number);
	return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function getPresetRange(
	label: PresetLabel,
	min: string,
	max: string
): { start: string; end: string } {
	const clamp = (start: string): { start: string; end: string } => ({
		start: start < min ? min : start,
		end: max
	});
	switch (label) {
		case '7D':
			return clamp(addDays(max, -6));
		case '30D':
			return clamp(addDays(max, -29));
		case '90D':
			return clamp(addDays(max, -89));
		case '1Y': {
			const [y, m, d] = max.split('-');
			const anniversary = `${Number(y) - 1}-${m}-${d}`;
			return clamp(isDate(anniversary) ? addDays(anniversary, 1) : `${Number(y) - 1}-03-01`);
		}
		case 'MTD':
			return clamp(`${max.slice(0, 7)}-01`);
		case 'YTD':
			return clamp(`${max.slice(0, 4)}-01-01`);
		case 'ALL':
			return { start: min, end: max };
	}
}
