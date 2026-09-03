<script lang="ts">
	// Dual-handle date range slider, ported from notion-task-burndown-chart:
	// drag either handle, drag the filled range to slide the whole window, or
	// click the track to jump the nearest handle. Touch gets bigger targets.
	// Restyled from that app's palette to this one's theme tokens.
	import { onMount, onDestroy } from 'svelte';

	interface Props {
		min: string;
		max: string;
		start: string;
		end: string;
		onchange: (start: string, end: string) => void;
	}

	let { min, max, start, end, onchange }: Props = $props();

	let track: HTMLDivElement;
	let dragging: 'start' | 'end' | 'range' | null = $state(null);
	let hovered: 'start' | 'end' | 'range' | 'track' | null = $state(null);
	let isTouch = $state(false);
	let didDrag = false;
	let dragStartX = 0;
	let dragStartVal = 0;
	let dragEndVal = 0;

	let touchMql: MediaQueryList | null = null;
	function syncIsTouch(e: MediaQueryListEvent | MediaQueryList): void {
		isTouch = 'matches' in e ? e.matches : false;
	}

	onMount(() => {
		if (typeof window === 'undefined' || !window.matchMedia) return;
		touchMql = window.matchMedia('(pointer: coarse)');
		isTouch = touchMql.matches;
		touchMql.addEventListener('change', syncIsTouch);
	});

	onDestroy(() => {
		touchMql?.removeEventListener('change', syncIsTouch);
	});

	function dateToOffset(date: string): number {
		const d = new Date(date + 'T00:00:00');
		const m = new Date(min + 'T00:00:00');
		return Math.round((d.getTime() - m.getTime()) / 86400000);
	}

	function offsetToDate(offset: number): string {
		const m = new Date(min + 'T00:00:00');
		const d = new Date(m.getTime() + offset * 86400000);
		const y = d.getFullYear();
		const mo = String(d.getMonth() + 1).padStart(2, '0');
		const day = String(d.getDate()).padStart(2, '0');
		return `${y}-${mo}-${day}`;
	}

	let totalDays = $derived(dateToOffset(max));
	let startOffset = $derived(dateToOffset(start));
	let endOffset = $derived(dateToOffset(end));

	let startPct = $derived(totalDays > 0 ? (startOffset / totalDays) * 100 : 0);
	let endPct = $derived(totalDays > 0 ? (endOffset / totalDays) * 100 : 100);

	const MONTHS = [
		'Jan',
		'Feb',
		'Mar',
		'Apr',
		'May',
		'Jun',
		'Jul',
		'Aug',
		'Sep',
		'Oct',
		'Nov',
		'Dec'
	];
	function formatLabel(date: string): string {
		const d = new Date(date + 'T00:00:00');
		return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
	}

	function xToOffset(clientX: number): number {
		if (!track) return 0;
		const rect = track.getBoundingClientRect();
		const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
		return Math.round(pct * totalDays);
	}

	function handlePointerDown(e: PointerEvent, type: 'start' | 'end' | 'range'): void {
		e.preventDefault();
		e.stopPropagation();
		dragging = type;
		didDrag = false;
		dragStartX = e.clientX;
		dragStartVal = startOffset;
		dragEndVal = endOffset;
		(e.target as HTMLElement).setPointerCapture?.(e.pointerId);
		window.addEventListener('pointermove', handlePointerMove);
		window.addEventListener('pointerup', handlePointerUp);
	}

	function handlePointerMove(e: PointerEvent): void {
		if (!dragging || !track) return;
		didDrag = true;
		const rect = track.getBoundingClientRect();
		const deltaPx = e.clientX - dragStartX;
		const deltaDays = Math.round((deltaPx / rect.width) * totalDays);

		if (dragging === 'start') {
			const newStart = Math.max(0, Math.min(endOffset - 1, dragStartVal + deltaDays));
			onchange(offsetToDate(newStart), end);
		} else if (dragging === 'end') {
			const newEnd = Math.max(startOffset + 1, Math.min(totalDays, dragEndVal + deltaDays));
			onchange(start, offsetToDate(newEnd));
		} else if (dragging === 'range') {
			const rangeSize = dragEndVal - dragStartVal;
			let newStart = dragStartVal + deltaDays;
			let newEnd = dragEndVal + deltaDays;
			if (newStart < 0) {
				newStart = 0;
				newEnd = rangeSize;
			}
			if (newEnd > totalDays) {
				newEnd = totalDays;
				newStart = totalDays - rangeSize;
			}
			onchange(offsetToDate(newStart), offsetToDate(newEnd));
		}
	}

	function handlePointerUp(): void {
		dragging = null;
		window.removeEventListener('pointermove', handlePointerMove);
		window.removeEventListener('pointerup', handlePointerUp);
	}

	function handleTrackClick(e: MouseEvent): void {
		if (dragging || didDrag) {
			didDrag = false;
			return;
		}
		const offset = xToOffset(e.clientX);
		const distToStart = Math.abs(offset - startOffset);
		const distToEnd = Math.abs(offset - endOffset);
		if (distToStart < distToEnd) {
			onchange(offsetToDate(Math.min(offset, endOffset - 1)), end);
		} else {
			onchange(start, offsetToDate(Math.max(offset, startOffset + 1)));
		}
	}

	// Handle sizes scale up on touch so the hit area is closer to 44×44
	function handleSize(type: 'start' | 'end'): number {
		if (isTouch) {
			if (dragging === type) return 28;
			if (hovered === type) return 26;
			return 24;
		}
		if (dragging === type) return 20;
		if (hovered === type) return 18;
		return 14;
	}

	function rangeHeight(): number {
		if (isTouch) {
			if (dragging === 'range') return 12;
			if (hovered === 'range') return 10;
			return 8;
		}
		if (dragging === 'range') return 10;
		if (hovered === 'range') return 8;
		return 6;
	}

	let trackHeight = $derived(isTouch ? 48 : 40);
	let trackCenter = $derived(trackHeight / 2);
</script>

<div class="space-y-1">
	<!-- Selected range labels -->
	<div
		class="flex justify-between text-[11px] tabular-nums transition-colors duration-150 {dragging
			? 'text-primary'
			: 'text-muted-foreground'}"
	>
		<span>{formatLabel(start)}</span>
		<span>{formatLabel(end)}</span>
	</div>

	<!-- Slider track -->
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		bind:this={track}
		class="relative cursor-pointer rounded-md transition-colors duration-150 select-none {hovered ||
		dragging
			? 'bg-accent'
			: 'bg-transparent'}"
		style="height: {trackHeight}px;"
		onclick={handleTrackClick}
		onmouseenter={() => {
			if (!dragging) hovered = 'track';
		}}
		onmouseleave={() => {
			if (!dragging) hovered = null;
		}}
	>
		<!-- Background track line -->
		<div
			class="absolute right-2 left-2 h-[6px] rounded-full bg-secondary"
			style="top: {trackCenter - 3}px;"
		></div>

		<!-- Tick marks for month boundaries -->
		{#if totalDays > 0}
			{#each Array.from({ length: Math.ceil(totalDays / 30) }, (_, i) => i * 30) as tickOffset (tickOffset)}
				{#if tickOffset > 0 && tickOffset < totalDays}
					<div
						class="absolute h-[8px] w-px bg-border"
						style="left: {(tickOffset / totalDays) * 100}%; top: {trackCenter - 4}px;"
					></div>
				{/if}
			{/each}
		{/if}

		<!-- Selected range fill -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="absolute cursor-grab rounded-full bg-primary transition-all duration-100 active:cursor-grabbing"
			style="
        left: {startPct}%;
        right: {100 - endPct}%;
        top: {trackCenter - rangeHeight() / 2}px;
        height: {rangeHeight()}px;
      "
			onpointerdown={(e) => handlePointerDown(e, 'range')}
			onmouseenter={() => {
				if (!dragging) hovered = 'range';
			}}
			onmouseleave={() => {
				if (!dragging) hovered = null;
			}}
			role="presentation"
		></div>

		<!-- Start handle -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="absolute z-10 cursor-ew-resize rounded-full border-2 border-primary bg-background shadow-sm transition-all duration-100"
			style="
        left: calc({startPct}% - {handleSize('start') / 2}px);
        top: {trackCenter - handleSize('start') / 2}px;
        width: {handleSize('start')}px;
        height: {handleSize('start')}px;
      "
			onpointerdown={(e) => handlePointerDown(e, 'start')}
			onmouseenter={() => {
				if (!dragging) hovered = 'start';
			}}
			onmouseleave={() => {
				if (!dragging) hovered = null;
			}}
			role="presentation"
		></div>

		<!-- End handle -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="absolute z-10 cursor-ew-resize rounded-full border-2 border-primary bg-background shadow-sm transition-all duration-100"
			style="
        left: calc({endPct}% - {handleSize('end') / 2}px);
        top: {trackCenter - handleSize('end') / 2}px;
        width: {handleSize('end')}px;
        height: {handleSize('end')}px;
      "
			onpointerdown={(e) => handlePointerDown(e, 'end')}
			onmouseenter={() => {
				if (!dragging) hovered = 'end';
			}}
			onmouseleave={() => {
				if (!dragging) hovered = null;
			}}
			role="presentation"
		></div>
	</div>

	<!-- Absolute data bounds -->
	<div class="flex justify-between text-[10px] text-muted-foreground/50 tabular-nums">
		<span>{formatLabel(min)}</span>
		<span>{formatLabel(max)}</span>
	</div>
</div>
