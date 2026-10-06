<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import {
		dateViewport,
		dayNumber,
		dateString,
		panViewport,
		moveSelection,
		type DateWindow
	} from '$lib/finance/date-viewport';

	interface Props {
		min: string;
		max: string;
		start: string;
		end: string;
		onchange: (start: string, end: string) => void;
	}
	let { min, max, start, end, onchange }: Props = $props();
	let viewport = $state<DateWindow>({ start: '', end: '' });
	let track: HTMLDivElement;
	let dragging = $state<'start' | 'end' | 'range' | null>(null);
	let lastSelection = '';
	let didDrag = false;
	let originX = 0;
	let pointerX = 0;
	let originView = 0;
	let originSelection: DateWindow;
	let frame = 0;
	let lastPan = 0;
	let lastBounds = '';
	const span = $derived(viewport.start ? dayNumber(viewport.end) - dayNumber(viewport.start) : 0);
	const percent = (date: string): number =>
		span
			? Math.max(0, Math.min(100, ((dayNumber(date) - dayNumber(viewport.start)) / span) * 100))
			: 50;
	const label = (date: string): string =>
		new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric',
			year: 'numeric',
			timeZone: 'UTC'
		});

	$effect(() => {
		const selection = `${start}|${end}`;
		const bounds = `${min}|${max}`;
		untrack(() => {
			if (selection !== lastSelection || bounds !== lastBounds)
				viewport = dateViewport(min, max, end);
			lastSelection = selection;
			lastBounds = bounds;
		});
	});

	function emit(selection: DateWindow) {
		lastSelection = `${selection.start}|${selection.end}`;
		if (selection.start !== start || selection.end !== end)
			onchange(selection.start, selection.end);
		return selection;
	}
	function pan(days: number) {
		viewport = panViewport(viewport, days, min, max);
	}
	function adjust(type: 'start' | 'end', day: number) {
		if (type === 'start')
			return emit({
				start: dateString(Math.max(dayNumber(min), Math.min(dayNumber(end), day))),
				end
			});
		else
			return emit({
				start,
				end: dateString(Math.min(dayNumber(max), Math.max(dayNumber(start), day)))
			});
	}
	function keydown(event: KeyboardEvent, type: 'start' | 'end' | 'range') {
		const delta = (
			{
				ArrowLeft: -1,
				ArrowDown: -1,
				ArrowRight: 1,
				ArrowUp: 1,
				PageDown: -30,
				PageUp: 30
			} as Record<string, number>
		)[event.key];
		if (delta === undefined && event.key !== 'Home' && event.key !== 'End') return;
		event.preventDefault();
		const current = dayNumber(type === 'end' ? end : start);
		const target =
			event.key === 'Home'
				? dayNumber(min)
				: event.key === 'End'
					? dayNumber(max)
					: current + delta * (event.shiftKey ? 7 : 1);
		const moved =
			type === 'range'
				? emit(moveSelection({ start, end }, target - current, min, max))
				: adjust(type, target);
		const anchor = moved[type === 'range' ? (target < current ? 'start' : 'end') : type];
		if (anchor < viewport.start) pan(dayNumber(anchor) - dayNumber(viewport.start));
		if (anchor > viewport.end) pan(dayNumber(anchor) - dayNumber(viewport.end));
	}
	function updateDrag() {
		if (!dragging || !track) return;
		const shift =
			Math.round(((pointerX - originX) / track.getBoundingClientRect().width) * span) +
			dayNumber(viewport.start) -
			originView;
		if (dragging === 'range') emit(moveSelection(originSelection, shift, min, max));
		else adjust(dragging, dayNumber(originSelection[dragging]) + shift);
	}
	function edgePan(time: number) {
		if (!dragging) return;
		if (didDrag && time - lastPan >= 80) {
			const rect = track.getBoundingClientRect();
			const direction = pointerX <= rect.left + 24 ? -1 : pointerX >= rect.right - 24 ? 1 : 0;
			if (direction) {
				pan(direction);
				updateDrag();
			}
			lastPan = time;
		}
		frame = requestAnimationFrame(edgePan);
	}
	function pointerDown(event: PointerEvent, type: 'start' | 'end' | 'range') {
		(event.currentTarget as HTMLElement).focus();
		event.preventDefault();
		event.stopPropagation();
		dragging = type;
		didDrag = false;
		originX = pointerX = event.clientX;
		originView = dayNumber(viewport.start);
		// A clipped handle begins from its visible edge, keeping pointer movement local.
		originSelection = { start, end };
		if (type !== 'range')
			originSelection[type] = dateString(
				Math.max(originView, Math.min(dayNumber(viewport.end), dayNumber(originSelection[type])))
			);
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
		window.addEventListener('pointermove', pointerMove);
		window.addEventListener('pointerup', pointerUp);
		window.addEventListener('pointercancel', pointerUp);
		frame = requestAnimationFrame(edgePan);
	}
	function pointerMove(event: PointerEvent) {
		pointerX = event.clientX;
		if (Math.abs(pointerX - originX) < 2 && !didDrag) return;
		didDrag = true;
		updateDrag();
	}
	function pointerUp() {
		if (typeof window === 'undefined') return;
		dragging = null;
		cancelAnimationFrame(frame);
		window.removeEventListener('pointermove', pointerMove);
		window.removeEventListener('pointerup', pointerUp);
		window.removeEventListener('pointercancel', pointerUp);
	}
	onDestroy(pointerUp);
	function trackClick(event: MouseEvent) {
		if (didDrag) {
			didDrag = false;
			return;
		}
		if (event.target !== track) return;
		const rect = track.getBoundingClientRect();
		const day =
			dayNumber(viewport.start) +
			Math.round(Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * span);
		adjust(
			Math.abs(day - dayNumber(start)) < Math.abs(day - dayNumber(end)) ? 'start' : 'end',
			day
		);
	}
</script>

<div class="space-y-1">
	<div class="flex justify-between text-xs text-muted-foreground tabular-nums">
		<span>{label(start)}</span><span>{label(end)}</span>
	</div>
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div bind:this={track} class="relative mx-5 h-12 touch-none select-none" onclick={trackClick}>
		<div
			class="pointer-events-none absolute top-[21px] h-1.5 w-full rounded-full bg-secondary"
		></div>
		{#if viewport.start}
			{#each [30, 60] as tick}
				{#if tick < span}<div
						class="pointer-events-none absolute top-5 h-2 w-px bg-border"
						style:left={`${(tick / span) * 100}%`}
					></div>{/if}
			{/each}
			<button
				type="button"
				aria-label="Move selected date range"
				class="absolute top-0 h-12 min-w-1 cursor-grab touch-none focus-visible:outline-2 focus-visible:outline-primary"
				style:left={`${percent(start)}%`}
				style:width={`${percent(end) - percent(start)}%`}
				onpointerdown={(e) => pointerDown(e, 'range')}
				onkeydown={(e) => keydown(e, 'range')}
			>
				<span
					class="pointer-events-none absolute inset-x-0 top-[21px] h-1.5 rounded-full bg-primary"
				></span>
			</button>
			{#each ['start', 'end'] as type}
				{@const bound = type as 'start' | 'end'}
				<button
					type="button"
					role="slider"
					aria-label={bound === 'start' ? 'Start date' : 'End date'}
					aria-valuemin={dayNumber(bound === 'start' ? min : start)}
					aria-valuemax={dayNumber(bound === 'start' ? end : max)}
					aria-valuenow={dayNumber(bound === 'start' ? start : end)}
					aria-valuetext={label(bound === 'start' ? start : end)}
					class="absolute top-0 z-10 flex h-12 w-11 -translate-x-1/2 touch-none items-center justify-center rounded-md focus-visible:outline-2 focus-visible:outline-primary"
					style:left={`${percent(bound === 'start' ? start : end)}%`}
					onpointerdown={(e) => pointerDown(e, bound)}
					onkeydown={(e) => keydown(e, bound)}
				>
					<span
						class="pointer-events-none h-4 w-4 rounded-full border-2 border-primary bg-background"
					></span>
				</button>
			{/each}
		{/if}
	</div>
	<nav
		aria-label="Date viewport"
		class="flex flex-wrap items-center justify-between gap-1 text-xs text-muted-foreground tabular-nums"
	>
		<button
			type="button"
			class="min-h-9 rounded-md border px-2 disabled:opacity-40"
			aria-label="Show earlier dates"
			disabled={viewport.start <= min}
			onclick={() => pan(-30)}>Earlier</button
		>
		<span aria-live="polite"
			>{viewport.start ? `${label(viewport.start)} - ${label(viewport.end)}` : ''}</span
		>
		<button
			type="button"
			class="min-h-9 rounded-md border px-2 disabled:opacity-40"
			aria-label="Show later dates"
			disabled={viewport.end >= max}
			onclick={() => pan(30)}>Later</button
		>
	</nav>
</div>
