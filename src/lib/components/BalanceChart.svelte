<script lang="ts">
	import { onMount } from 'svelte';
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
		kind?: 'area' | 'bar' | 'line';
		net?: boolean;
		/** Overlay a dashed net-total line (assets minus debt) on the stack. */
		legendKeys: string[];
		hidden: string[];
		applicable: string[];
		onToggle: (key: string) => void;
		heightClass?: string;
		labelFor?: (key: string) => string;
		/** Stable palette slot per series key - keeps an entity's color fixed
		 * when filtering or reordering changes the series array. */
		slotFor?: (key: string) => number;
		/** Icon URL per series key (already tinted) - becomes the legend and
		 * tooltip marker via a canvas point style. */
		iconFor?: (key: string) => string | undefined;
		iconComponent?: (key: string) => typeof IconHelp;
	}
	const {
		data,
		bucket = 'day',
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
		iconComponent = () => IconHelp
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
		v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
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
							title: tooltipTitle,
							label: (item) => `${item.dataset.label}: ${money(item.parsed.y ?? 0)}`,
							footer: (items) => {
								// the Net row already IS the total - don't double-count it
								const total = items
									.filter((it) => it.dataset.stack !== 'net')
									.reduce((sum, it) => sum + (it.parsed.y ?? 0), 0);
								return `Total: ${money(total)}`;
							}
						}
					}
				}
			}
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
		render();
	});
</script>

<div class="relative w-full {heightClass}">
	<canvas bind:this={canvas} aria-label="Financial series for the selected date range"></canvas>
</div>

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
