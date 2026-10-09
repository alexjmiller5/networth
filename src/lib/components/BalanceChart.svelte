<script lang="ts">
	import { onMount } from 'svelte';
	import * as MarkerTooltip from '$lib/components/ui/tooltip';
	import {
		markerBuckets,
		markerText,
		markerLabelBounds,
		assignLane,
		type Marker
	} from '$lib/finance/markers';
	import { formatMoney, formatMoneyTick } from '$lib/finance/display';
	import IconHelp from '@tabler/icons-svelte/icons/help';
	import { colorForSlot, needsNet } from '$lib/finance/chartStyle';
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
		type ChartDataset,
		type Plugin
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
		markers?: Marker[];
		hideAmounts?: boolean;
		data: StackedSeries;
		bucket?: Bucket;
		kind?: 'area' | 'bar' | 'line';
		net?: boolean;
		/** Overlay a dashed net-total line (assets minus debt) on the stack. */
		legendKeys: string[];
		hidden: string[];
		applicable: string[];
		onToggle: (key: string) => void;
		heightClass?: string;
		labelFor?: (key: string, start?: string, end?: string) => string;
		/** Stable palette slot per series key - keeps an entity's color fixed
		 * when filtering or reordering changes the series array. */
		slotFor?: (key: string) => number;
		/** Icon URL per series key (already tinted) - becomes the legend and
		 * tooltip marker via a canvas point style. */
		iconFor?: (key: string) => string | undefined;
		iconComponent?: (key: string) => typeof IconHelp;
		/** Tooltip and tick formatting; dollars unless a native unit is plotted. */
		format?: (value: number) => string;
		tickFormat?: (value: number) => string;
		ariaLabel?: string;
	}
	const {
		markers = [],
		data,
		bucket = 'day',
		hideAmounts = false,
		kind = 'bar',
		net = false,
		legendKeys,
		hidden,
		applicable,
		onToggle,
		heightClass = 'h-[360px] sm:h-[460px]',
		labelFor = (k) => k,
		slotFor,
		iconFor = () => undefined,
		iconComponent = () => IconHelp,
		format,
		tickFormat,
		ariaLabel = 'Financial series for the selected date range'
	}: Props = $props();

	let canvas: HTMLCanvasElement;
	let chart: Chart | null = null;
	let markerLabels = $state<
		{ key: number; x: number; top: number; left: number; width: number; events: Marker[] }[]
	>([]);
	const visibleMarkers = $derived(
		markers.filter((m) => markerBuckets(m, data.dates, bucket) !== null)
	);
	const markerTooltip = (items: { dataIndex: number }[]) =>
		visibleMarkers
			.filter((m) => {
				const bounds = markerBuckets(m, data.dates, bucket)!;
				return items[0]?.dataIndex >= bounds.start && items[0]?.dataIndex <= bounds.end;
			})
			.map((m) => markerText(m, hideAmounts));
	function markerPlugin(chartTheme: ReturnType<typeof readTheme>): Plugin {
		let positions: typeof markerLabels = [];
		const pixel = (c: Chart, i: number) =>
			c.scales.x.getPixelForValue(dayjs(data.dates[i]).valueOf());
		return {
			id: 'eventMarkers',
			afterLayout(c) {
				const grouped = new Map<number, Marker[]>();
				for (const marker of visibleMarkers) {
					const i = markerBuckets(marker, data.dates, bucket)!.start;
					grouped.set(i, [...(grouped.get(i) ?? []), marker]);
				}
				const placed: { lane: number; left: number; right: number }[] = [];
				positions = [];
				for (const [i, events] of [...grouped].sort((a, b) => a[0] - b[0])) {
					const x = pixel(c, i);
					if (x < c.chartArea.left || x > c.chartArea.right) continue;
					const label =
						(hideAmounts ? 'Hidden marker' : events[0].title) +
						(events.length > 1 ? ` (+${events.length - 1})` : '');
					c.ctx.save();
					c.ctx.font = `12px ${getComputedStyle(c.canvas).fontFamily}`;
					const { left, width } = markerLabelBounds(
						x,
						c.ctx.measureText(label).width,
						c.chartArea.left,
						c.chartArea.right
					);
					c.ctx.restore();
					const lane = assignLane(placed, left - 4, left + width + 4);
					placed.push({ lane, left: left - 4, right: left + width + 4 });
					positions.push({ key: i, x, left, width, top: lane * 26 + 2, events });
				}
				markerLabels = positions.filter((p) => p.top < 78);
			},
			beforeDatasetsDraw(c) {
				c.ctx.save();
				c.ctx.fillStyle = chartTheme.mutedInk;
				c.ctx.globalAlpha = 0.12;
				const half =
					data.dates.length > 1
						? Math.abs(pixel(c, 1) - pixel(c, 0)) / 2
						: (c.chartArea.right - c.chartArea.left) / 2;
				for (const marker of visibleMarkers.filter((m) => m.end !== null)) {
					const bounds = markerBuckets(marker, data.dates, bucket)!;
					const left = Math.max(c.chartArea.left, pixel(c, bounds.start) - half);
					const right = Math.min(c.chartArea.right, pixel(c, bounds.end) + half);
					c.ctx.fillRect(left, c.chartArea.top, right - left, c.chartArea.bottom - c.chartArea.top);
				}
				c.ctx.restore();
			},
			afterDatasetsDraw(c) {
				c.ctx.save();
				c.ctx.strokeStyle = chartTheme.mutedInk;
				c.ctx.lineWidth = 1;
				c.ctx.setLineDash([4, 4]);
				for (const p of positions) {
					c.ctx.beginPath();
					c.ctx.moveTo(p.x, p.top < 78 ? p.top + 24 : c.chartArea.top);
					c.ctx.lineTo(p.x, c.chartArea.bottom);
					c.ctx.stroke();
				}
				c.ctx.restore();
			}
		};
	}

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
	function iconCanvas(url: string, tint: string): HTMLCanvasElement {
		const cacheKey = `${url}:${tint}`;
		let c = iconCanvases.get(cacheKey);
		if (c) return c;
		c = document.createElement('canvas');
		c.width = 14;
		c.height = 14;
		iconCanvases.set(cacheKey, c);
		const img = new Image();
		img.onload = () => {
			const ctx = c!.getContext('2d');
			if (ctx) {
				ctx.drawImage(img, 0, 0, 14, 14);
				ctx.globalCompositeOperation = 'source-in';
				ctx.fillStyle = tint;
				ctx.fillRect(0, 0, 14, 14);
			}
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
			series: Array.from({ length: 24 }, (_, i) => i + 1).map((i) => token(`--chart-${i}`)),
			saturation: Number(token('--chart-saturation')),
			lightness: Number(token('--chart-lightness')),
			surface: token('--card'),
			ink: token('--foreground'),
			mutedInk: token('--muted-foreground'),
			gridline: token('--border')
		};
	}

	const money = (v: number): string =>
		hideAmounts ? 'Hidden' : format ? format(v) : formatMoney(v, false);
	const moneyTick = (v: number): string =>
		hideAmounts ? '' : tickFormat ? tickFormat(v) : formatMoneyTick(v, false);

	const tooltipTitle = (items: { dataIndex: number }[]): string => {
		const raw = data.dates[items[0]?.dataIndex ?? -1];
		if (!raw) return '';
		if (bucket === 'month') return dayjs(raw).format('MMMM YYYY');
		if (bucket === 'week') return `Week of ${dayjs(raw).format('MMM D, YYYY')}`;
		return dayjs(raw).format('ddd, MMM D, YYYY');
	};

	let theme = $state<ReturnType<typeof readTheme> | null>(null);
	const slots = $derived(new Map(legendKeys.map((key, i) => [key, i])));
	function color(key: string): string {
		return theme
			? colorForSlot(
					slotFor?.(key) ?? slots.get(key) ?? 0,
					theme.series,
					theme.saturation,
					theme.lightness
				)
			: 'currentColor';
	}
	function render(): void {
		if (!canvas || !theme) return;
		const chartTheme = theme;
		chart?.destroy();
		const pointStyle = (key: string) => {
			const url = iconFor(key);
			return url ? iconCanvas(url, color(key)) : 'rectRounded';
		};
		const showNet = needsNet(data, net);

		// The net line lives in its own stack group so the stacked y-scale never
		// adds it to the account bands - it plots the true total.
		const netDataset = showNet
			? [
					{
						label: 'Net',
						type: 'line' as const,
						data: netTotals(data),
						stack: 'net',
						borderColor: chartTheme.ink,
						backgroundColor: chartTheme.ink,
						pointStyle: 'line' as const,
						borderDash: [6, 4],
						borderWidth: 2,
						pointRadius: 0,
						pointHoverRadius: 5,
						pointBorderColor: chartTheme.surface,
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
						pointStyle: pointStyle(s.key),
						...(kind === 'bar'
							? {
									// neighbors separated by surface, not strokes
									backgroundColor: color(s.key),
									borderColor: chartTheme.surface,
									borderWidth: { top: 2, right: 0, bottom: 0, left: 0 },
									borderRadius: 3,
									borderSkipped: false,
									maxBarThickness: 24
								}
							: {
									fill: kind === 'area' ? 'stack' : false,
									borderColor: color(s.key),
									backgroundColor: color(s.key),
									borderWidth: 2,
									pointRadius: 0,
									pointHoverRadius: 5,
									pointBorderColor: chartTheme.surface,
									pointBorderWidth: 2,
									tension: 0.2
								})
					}))
					.concat(netDataset as never[]) as ChartDataset<'bar'>[]
			},
			options: {
				layout: {
					padding: { top: visibleMarkers.length ? Math.min(3, visibleMarkers.length) * 26 + 8 : 0 }
				},
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
						border: { color: chartTheme.gridline },
						time: {
							unit: bucket === 'month' ? 'month' : bucket === 'week' ? 'week' : 'day',
							isoWeekday: 1,
							displayFormats: { day: 'MMM D', week: 'MMM D', month: 'MMM YYYY' }
						},
						ticks: {
							color: chartTheme.mutedInk,
							maxRotation: 0,
							autoSkip: true,
							maxTicksLimit: 10,
							font: { size: 12 }
						}
					},
					y: {
						stacked: true,
						beginAtZero: true,
						grid: { color: chartTheme.gridline, lineWidth: 1 },
						border: { display: false },
						ticks: {
							color: chartTheme.mutedInk,
							font: { size: 12 },
							callback: (v) => moneyTick(Number(v))
						}
					}
				},
				plugins: {
					legend: {
						display: false,
						position: 'bottom',
						labels: {
							color: chartTheme.ink,
							usePointStyle: true,
							pointStyleWidth: 16,
							boxHeight: 14,
							font: { size: 12 }
						}
					},
					tooltip: {
						filter: (item) => Math.round(Math.abs(item.parsed.y ?? 0) * 100) !== 0,
						usePointStyle: true,
						backgroundColor: chartTheme.surface,
						titleColor: chartTheme.ink,
						bodyColor: chartTheme.ink,
						footerColor: chartTheme.mutedInk,
						footerFont: { weight: 'normal' },
						borderColor: chartTheme.gridline,
						borderWidth: 1,
						padding: 10,
						itemSort: (a, b) => (b.parsed.y ?? 0) - (a.parsed.y ?? 0),
						callbacks: {
							beforeBody: markerTooltip,
							title: tooltipTitle,
							label: (item) => {
								const key = data.series[item.datasetIndex]?.key;
								const start = data.dates[item.dataIndex];
								const end =
									bucket === 'month'
										? dayjs(start).endOf('month').format('YYYY-MM-DD')
										: bucket === 'week'
											? dayjs(start).add(6, 'day').format('YYYY-MM-DD')
											: start;
								return `${key ? labelFor(key, start, end) : item.dataset.label}: ${money(item.parsed.y ?? 0)}`;
							},
							footer: (items) => {
								// the Net row already IS the total - don't double-count it
								const total = items
									.filter((it) => it.dataset.stack !== 'net')
									.reduce((sum, it) => sum + (it.parsed.y ?? 0), 0);
								const i = items[0]?.dataIndex ?? -1;
								const missing = data.series
									.filter((s) => s.data[i] === null && !hidden.includes(s.key))
									.map((s) => labelFor(s.key));
								return [
									`Total: ${money(total)}`,
									...(missing.length ? [`Unavailable: ${missing.join(', ')}`] : [])
								];
							}
						}
					}
				}
			},
			plugins: [markerPlugin(chartTheme)]
		});
	}

	onMount(() => {
		theme = readTheme();
		const observer = new MutationObserver(() => {
			theme = readTheme();
		});
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ['class', 'style']
		});
		return () => {
			observer.disconnect();
			chart?.destroy();
			chart = null;
		};
	});
	$effect(() => {
		void data;
		void bucket;
		void kind;
		void hideAmounts;
		void format;
		void tickFormat;
		void markers;
		render();
	});
</script>

<div class="relative w-full {heightClass}">
	<canvas bind:this={canvas} aria-label={ariaLabel}></canvas>
	<MarkerTooltip.Provider>
		{#each markerLabels as position (position.key)}
			<MarkerTooltip.Root ignoreNonKeyboardFocus={false}>
				<MarkerTooltip.Trigger
					class="absolute h-6 truncate rounded bg-card px-1 text-center text-xs text-foreground outline-offset-2 focus-visible:outline-2"
					style={`left:${position.left}px;top:${position.top}px;width:${position.width}px`}
					aria-label={position.events.map((m) => markerText(m, hideAmounts)).join('; ')}
				>
					{hideAmounts ? 'Hidden marker' : position.events[0].title}{position.events.length > 1
						? ` (+${position.events.length - 1})`
						: ''}
				</MarkerTooltip.Trigger>
				<MarkerTooltip.Content class="block max-h-60 max-w-xs overflow-y-auto break-words">
					{#each position.events as marker (marker.id)}<p>
							{markerText(marker, hideAmounts)}
						</p>{/each}
				</MarkerTooltip.Content>
			</MarkerTooltip.Root>
		{/each}
	</MarkerTooltip.Provider>
</div>

{#if visibleMarkers.length}
	<details class="mt-2 text-xs text-muted-foreground">
		<summary class="cursor-pointer py-2">Markers in view ({visibleMarkers.length})</summary>
		<ul class="max-h-40 space-y-1 overflow-y-auto py-2" aria-label="Markers in view">
			{#each [...visibleMarkers].sort((a, b) => a.date.localeCompare(b.date)) as marker (marker.id)}
				<li class="break-words">{markerText(marker, hideAmounts)}</li>
			{/each}
		</ul>
	</details>
{/if}

<div
	class="mt-3 flex max-h-48 flex-wrap justify-center gap-x-3 gap-y-1 overflow-y-auto"
	aria-label="Chart legend"
>
	{#each legendKeys as key (key)}
		<button
			type="button"
			class="flex min-h-9 max-w-full items-center gap-1.5 rounded px-1 text-xs disabled:opacity-40"
			aria-pressed={!hidden.includes(key)}
			disabled={!applicable.includes(key)}
			onclick={() => onToggle(key)}
			title={applicable.includes(key)
				? `Toggle ${labelFor(key)}`
				: `${labelFor(key)}: no data in this view`}
		>
			{#if iconFor(key)}<span
					class="series-icon"
					style:color={color(key)}
					style:mask-image={`url("${iconFor(key)}")`}
					aria-hidden="true"
				></span>{:else}{@const Icon = iconComponent(key)}<Icon size={16} color={color(key)} />{/if}
			<span class:line-through={hidden.includes(key)} class="break-words text-left"
				>{labelFor(key)}</span
			>
		</button>
	{/each}
</div>
