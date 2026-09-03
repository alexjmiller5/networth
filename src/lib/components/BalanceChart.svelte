<script lang="ts">
	import { onMount } from 'svelte';
	import {
		Chart,
		LineController,
		LineElement,
		PointElement,
		BarController,
		BarElement,
		LinearScale,
		TimeScale,
		CategoryScale,
		Tooltip,
		Legend,
		Filler,
		type ChartDataset
	} from 'chart.js';
	import 'chartjs-adapter-dayjs-4';
	import dayjs from 'dayjs';
	import { netTotals, type StackedSeries, type Bucket } from '$lib/finance/series';

	Chart.register(
		LineController,
		LineElement,
		PointElement,
		BarController,
		BarElement,
		LinearScale,
		TimeScale,
		CategoryScale,
		Tooltip,
		Legend,
		Filler
	);

	interface Props {
		data: StackedSeries;
		bucket?: Bucket;
		kind?: 'area' | 'bar';
		/** Overlay a dashed net-total line (assets minus debt) on the stack. */
		net?: boolean;
		heightClass?: string;
		labelFor?: (key: string) => string;
		/** Stable palette slot per series key - keeps an entity's color fixed
		 * when filtering or reordering changes the series array. */
		slotFor?: (key: string) => number;
		/** Icon URL per series key (already tinted) - becomes the legend and
		 * tooltip marker via a canvas point style. */
		iconFor?: (key: string, hexColor: string) => string | undefined;
	}
	const {
		data,
		bucket = 'day',
		kind = 'area',
		net = false,
		heightClass = 'h-[360px] sm:h-[460px]',
		labelFor = (k) => k,
		slotFor,
		iconFor
	}: Props = $props();

	let canvas: HTMLCanvasElement;
	let chart: Chart | null = null;

	// Icons as tiny canvases: Chart.js draws image point styles at natural
	// size, so pre-render at legend size; repaint (coalesced into one rAF)
	// when the image lands.
	const iconCanvases = new Map<string, HTMLCanvasElement>();
	let repaintQueued = false;
	function scheduleRepaint(): void {
		if (repaintQueued) return;
		repaintQueued = true;
		requestAnimationFrame(() => {
			repaintQueued = false;
			chart?.update('none');
		});
	}
	function iconCanvas(url: string): HTMLCanvasElement {
		let c = iconCanvases.get(url);
		if (c) return c;
		c = document.createElement('canvas');
		c.width = 14;
		c.height = 14;
		iconCanvases.set(url, c);
		const img = new Image();
		img.onload = () => {
			c!.getContext('2d')?.drawImage(img, 0, 0, 14, 14);
			scheduleRepaint();
		};
		img.src = url;
		return c;
	}

	// Chart colors come from the CSS tokens in layout.css, so Chart.js always
	// paints with the palette the current theme resolved.
	function readTheme() {
		const style = getComputedStyle(document.documentElement);
		const token = (name: string): string => style.getPropertyValue(name).trim();
		return {
			series: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((i) => token(`--chart-${i}`)),
			surface: token('--card'),
			ink: token('--foreground'),
			mutedInk: token('--muted-foreground'),
			gridline: token('--border')
		};
	}

	const money = (v: number): string =>
		v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
	const moneyTick = (v: number): string =>
		Math.abs(v) >= 1000
			? `$${(v / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })}k`
			: money(v);

	const tooltipTitle = (items: { dataIndex: number }[]): string => {
		const raw = data.dates[items[0]?.dataIndex ?? -1];
		if (!raw) return '';
		if (bucket === 'month') return dayjs(raw).format('MMMM YYYY');
		if (bucket === 'week') return `Week of ${dayjs(raw).format('MMM D, YYYY')}`;
		return dayjs(raw).format('ddd, MMM D, YYYY');
	};

	function render(): void {
		if (!canvas) return;
		chart?.destroy();
		const theme = readTheme();
		// Color follows the entity: stable slot from slotFor (registry order),
		// never the series' current array position, rank, or visibility.
		// A slot of -1 means "folded tail" - it wears gray, never a repeated hue.
		const color = (key: string, i: number): string => {
			const slot = slotFor?.(key) ?? i;
			return slot < 0 ? theme.mutedInk : theme.series[slot % theme.series.length];
		};
		const pointStyle = (key: string, i: number): HTMLCanvasElement | 'rectRounded' => {
			const url = iconFor?.(key, color(key, i));
			return url ? iconCanvas(url) : 'rectRounded';
		};
		// The net line lives in its own stack group so the stacked y-scale never
		// adds it to the account bands - it plots the true total.
		const netDataset = net
			? [
					{
						label: 'Net',
						type: 'line' as const,
						data: netTotals(data),
						stack: 'net',
						borderColor: theme.ink,
						backgroundColor: theme.ink,
						pointStyle: 'line' as const,
						borderDash: [6, 4],
						borderWidth: 2,
						pointRadius: 0,
						pointHoverRadius: 5,
						pointBorderColor: theme.surface,
						pointBorderWidth: 2,
						fill: false,
						tension: 0.2,
						order: -1
					}
				]
			: [];
		chart = new Chart(canvas, {
			type: kind === 'bar' ? 'bar' : 'line',
			data: {
				labels: data.dates,
				datasets: data.series
					.map((s, i) => ({
						label: labelFor(s.key),
						data: s.data,
						pointStyle: pointStyle(s.key, i),
						...(kind === 'bar'
							? {
									// neighbors separated by surface, not strokes
									backgroundColor: color(s.key, i),
									borderColor: theme.surface,
									borderWidth: { top: 2, right: 0, bottom: 0, left: 0 },
									borderRadius: 3,
									borderSkipped: false,
									maxBarThickness: 24
								}
							: {
									fill: true,
									borderColor: color(s.key, i),
									backgroundColor: color(s.key, i) + 'cc',
									borderWidth: 2,
									pointRadius: 0,
									pointHoverRadius: 5,
									pointBorderColor: theme.surface,
									pointBorderWidth: 2,
									tension: 0.2
								})
					}))
					.concat(netDataset as never[]) as ChartDataset<'bar'>[]
			},
			options: {
				responsive: true,
				maintainAspectRatio: false,
				animation: false,
				interaction: { mode: 'index', intersect: false },
				scales: {
					x: {
						type: 'time',
						stacked: true,
						offset: kind === 'bar',
						grid: { display: false },
						border: { color: theme.gridline },
						time: {
							unit: bucket === 'month' ? 'month' : 'week',
							displayFormats: { week: 'MMM D', month: 'MMM YYYY' }
						},
						ticks: {
							color: theme.mutedInk,
							maxRotation: 0,
							autoSkip: true,
							maxTicksLimit: 10,
							font: { size: 11 }
						}
					},
					y: {
						stacked: true,
						beginAtZero: true,
						grid: { color: theme.gridline, lineWidth: 1 },
						border: { display: false },
						ticks: {
							color: theme.mutedInk,
							font: { size: 11 },
							callback: (v) => moneyTick(Number(v))
						}
					}
				},
				plugins: {
					legend: {
						display: data.series.length > 1,
						position: 'bottom',
						labels: {
							color: theme.ink,
							usePointStyle: true,
							pointStyleWidth: 16,
							boxHeight: 14,
							font: { size: 12 }
						}
					},
					tooltip: {
						usePointStyle: true,
						backgroundColor: theme.surface,
						titleColor: theme.ink,
						bodyColor: theme.ink,
						footerColor: theme.mutedInk,
						footerFont: { weight: 'normal' },
						borderColor: theme.gridline,
						borderWidth: 1,
						padding: 10,
						itemSort: (a, b) => (b.parsed.y ?? 0) - (a.parsed.y ?? 0),
						callbacks: {
							title: tooltipTitle,
							label: (item) => `${item.dataset.label}: ${money(item.parsed.y ?? 0)}`,
							footer: (items) => {
								// the Net row already IS the total - don't double-count it
								const total = items
									.filter((it) => it.dataset.label !== 'Net')
									.reduce((sum, it) => sum + (it.parsed.y ?? 0), 0);
								return `Total: ${money(total)}`;
							}
						}
					}
				}
			}
		});
	}

	onMount(() => () => chart?.destroy());
	$effect(() => {
		void data;
		void bucket;
		void kind;
		render();
	});
</script>

<div class="relative w-full {heightClass}">
	<canvas bind:this={canvas}></canvas>
</div>
