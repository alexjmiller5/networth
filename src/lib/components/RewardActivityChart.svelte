<script lang="ts">
	import { untrack } from 'svelte';
	import RangeSlider from './RangeSlider.svelte';
	import { dateString, dayNumber } from '$lib/finance/date-viewport';
	import { isDate } from '$lib/finance/presets';
	let {
		entries,
		unit,
		hidden,
		componentId
	}: {
		entries: { date: string; kind: string; value: string }[];
		unit: string;
		hidden: boolean;
		componentId: string;
	} = $props();
	const min = $derived(entries[0]?.date ?? '');
	const max = $derived(entries.at(-1)?.date ?? '');
	const key = untrack(() => `networth-reward-chart:${componentId}`);
	function initial() {
		const fallback = { start: dateString(Math.max(dayNumber(min), dayNumber(max) - 89)), end: max };
		try {
			const saved = JSON.parse(localStorage.getItem(key) ?? 'null');
			if (
				saved &&
				isDate(saved.start) &&
				isDate(saved.end) &&
				saved.start >= min &&
				saved.end <= max &&
				saved.start <= saved.end &&
				dayNumber(saved.end) - dayNumber(saved.start) < 90
			)
				return saved;
		} catch {
			/* Device storage is optional. */
		}
		return fallback;
	}
	let selection = $state<{ start: string; end: string }>(untrack(initial));
	const shown = $derived(
		entries.filter((e) => e.date >= selection.start && e.date <= selection.end)
	);
	const peak = $derived(shown.reduce((n, e) => Math.max(n, Math.abs(Number(e.value))), 0));
	function change(start: string, end: string) {
		if (dayNumber(end) - dayNumber(start) >= 90) start = dateString(dayNumber(end) - 89);
		selection = { start, end };
		try {
			localStorage.setItem(key, JSON.stringify(selection));
		} catch {
			/* Device storage is optional. */
		}
	}
</script>

<section class="mt-5 rounded-lg border p-3 sm:p-4" aria-label="Dated native reward activity">
	<h4 class="text-sm font-medium">Native activity · {unit}</h4>
	<p class="mt-1 text-xs text-muted-foreground">
		Dated, posted events only. Earning, redemption and other activity remain separate. At most 90
		days shown.
	</p>
	<div class="my-4">
		<RangeSlider {min} {max} start={selection.start} end={selection.end} onchange={change} />
	</div>
	<div class="mb-2 flex justify-between text-xs text-muted-foreground">
		<span>{selection.start}</span><span>{selection.end}</span>
	</div>
	{#if !shown.length}<p class="py-3 text-sm text-muted-foreground">
			No dated posted events in this window.
		</p>{/if}
	<ol class="flex flex-col gap-3">
		{#each shown as entry (`${entry.date}:${entry.kind}`)}<li class="min-w-0">
				<div class="mb-1 flex flex-wrap justify-between gap-2 text-xs">
					<span>{entry.date} · <span class="capitalize">{entry.kind}</span></span><span
						class="min-w-0 break-words font-medium tabular-nums"
						>{hidden ? 'Hidden' : `${entry.value} ${unit}`}</span
					>
				</div>
				<div class="flex h-3 rounded-sm bg-muted" aria-hidden="true">
					<div class="h-full w-1/2 border-r border-border">
						{#if Number(entry.value) < 0}<div
								class="ml-auto h-full bg-muted-foreground"
								style:width={`${peak ? (Math.abs(Number(entry.value)) / peak) * 100 : 0}%`}
							></div>{/if}
					</div>
					<div class="h-full w-1/2">
						{#if Number(entry.value) > 0}<div
								class="h-full bg-primary"
								style:width={`${peak ? (Number(entry.value) / peak) * 100 : 0}%`}
							></div>{/if}
					</div>
				</div>
			</li>{/each}
	</ol>
</section>
