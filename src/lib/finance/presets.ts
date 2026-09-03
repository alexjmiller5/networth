// Date-range presets, mirroring notion-task-burndown-chart's preset rules.
// Relative presets anchor to the DATA's last day (not "today" - snapshots lag),
// and every start is clamped to the data's first day.

export const PRESET_LABELS = ['7D', '30D', '90D', '1Y', 'MTD', 'YTD', 'ALL'] as const;
export type PresetLabel = (typeof PRESET_LABELS)[number];

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
			return clamp(addDays(max, -7));
		case '30D':
			return clamp(addDays(max, -30));
		case '90D':
			return clamp(addDays(max, -90));
		case '1Y': {
			const [y, m, d] = max.split('-');
			return clamp(`${Number(y) - 1}-${m}-${d}`);
		}
		case 'MTD':
			return clamp(`${max.slice(0, 7)}-01`);
		case 'YTD':
			return clamp(`${max.slice(0, 4)}-01-01`);
		case 'ALL':
			return { start: min, end: max };
	}
}
