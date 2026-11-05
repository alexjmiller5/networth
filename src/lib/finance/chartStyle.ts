import type { StackedSeries } from './series';

export function needsNet(data: StackedSeries, enabled = false): boolean {
	return (
		enabled &&
		data.dates.some(
			(_, i) =>
				data.series.some((s) => (s.data[i] ?? 0) > 0) &&
				data.series.some((s) => (s.data[i] ?? 0) < 0)
		)
	);
}

/** Registry slots are stable; overflow extends the palette instead of wrapping. */
export function colorForSlot(
	slot: number,
	palette: string[],
	saturation: number,
	lightness: number
): string {
	return (
		palette[slot] ?? `hsl(${((slot * 137.508) % 360).toFixed(3)} ${saturation}% ${lightness}%)`
	);
}

/** Overlay rows describe the stack, never add money to its total. */
export function tooltipTotal(
	items: { dataset: { stack?: string }; parsed: { y: number | null } }[]
): number {
	return items
		.filter((i) => i.dataset.stack !== 'net' && i.dataset.stack !== 'average')
		.reduce((sum, i) => sum + (i.parsed.y ?? 0), 0);
}

/** A rolling overlay keeps the plotted unit; it is not another period total. */
export function rollingAverageDataset(values: (number | null)[], ink: string, surface: string) {
	return {
		label: '14-day average',
		type: 'line' as const,
		data: values,
		stack: 'average',
		borderColor: ink,
		backgroundColor: ink,
		borderDash: [3, 3],
		borderWidth: 2,
		pointStyle: 'line' as const,
		pointRadius: values.filter((v) => v !== null).length === 1 ? 3 : 0,
		pointHoverRadius: 5,
		pointBorderColor: surface,
		pointBorderWidth: 2,
		fill: false,
		spanGaps: false,
		order: -2
	};
}
