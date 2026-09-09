<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import Seo from '$lib/components/seo.svelte';
	import BalanceChart from '$lib/components/BalanceChart.svelte';
	import RangeSlider from '$lib/components/RangeSlider.svelte';
	import * as Select from '$lib/components/ui/select';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import IconCalendarWeek from '@tabler/icons-svelte/icons/calendar-week';
	import IconCalendarStats from '@tabler/icons-svelte/icons/calendar-stats';
	import IconStack2 from '@tabler/icons-svelte/icons/stack-2';
	import IconChartAreaFilled from '@tabler/icons-svelte/icons/chart-area-filled';
	import IconChartBar from '@tabler/icons-svelte/icons/chart-bar';
	import IconChartLine from '@tabler/icons-svelte/icons/chart-line';
	import IconFilter from '@tabler/icons-svelte/icons/filter';
	import IconChevronDown from '@tabler/icons-svelte/icons/chevron-down';
	import IconArrowsDownUp from '@tabler/icons-svelte/icons/arrows-down-up';
	import IconSum from '@tabler/icons-svelte/icons/sum';
	import IconRefresh from '@tabler/icons-svelte/icons/refresh';
	import IconHelp from '@tabler/icons-svelte/icons/help';
	import IconBuildingBank from '@tabler/icons-svelte/icons/building-bank';
	import IconWallet from '@tabler/icons-svelte/icons/wallet';
	import IconCash from '@tabler/icons-svelte/icons/cash';
	import {
		PRESET_LABELS,
		clampRange,
		getPresetRange,
		isDate,
		type PresetLabel
	} from '$lib/finance/presets';
	import {
		accountLabel,
		buildView,
		clearControlParams,
		FRIEND_PAID,
		pointsAt,
		readControls,
		toggleHidden,
		writeControls
	} from '$lib/finance/controls';
	import type { Bucket } from '$lib/finance/series';
	import type { GroupBy } from '$lib/finance/types';
	import type { Estate } from '$lib/finance/assemble';

	let { data }: { data: Estate } = $props();
	const accounts = $derived(data.accounts);
	const categories = $derived(data.categories);
	const dates = $derived(
		[
			...data.txns.flatMap((t) => [t.date, ...(t.shares ?? []).map((s) => s.date)]),
			...data.points.map((p) => p.scrapedAt.slice(0, 10)),
			...data.coverage.map((c) => c.asOf?.slice(0, 10))
		]
			.filter(isDate)
			.sort()
	);
	const minDate = $derived(dates[0] ?? new Date().toISOString().slice(0, 10));
	const maxDate = $derived(dates.at(-1) ?? minDate);
	let storage: Storage | undefined;
	try {
		storage = window.localStorage;
	} catch {
		/* Browsing still works with storage disabled. */
	}
	let controls = $state(untrack(() => readControls(storage, minDate, maxDate)));
	const range = $derived(
		controls.activePreset
			? getPresetRange(controls.activePreset, minDate, maxDate)
			: clampRange(controls.dateStart, controls.dateEnd, minDate, maxDate)
	);
	const viewState = $derived({ ...controls, dateStart: range.start, dateEnd: range.end });
	const view = $derived(buildView(data.txns, accounts, categories, viewState, data.coverage));
	const groupBy = $derived(controls.groupBy);
	const paletteKeys = $derived(
		groupBy === 'category'
			? [...categories]
					.sort((a, b) => a.sort - b.sort || a.id.localeCompare(b.id))
					.map((c) => c.name)
			: [
					...new Set(
						[...accounts]
							.sort((a, b) => a.id.localeCompare(b.id))
							.map((a) => (groupBy === 'account' ? a.id : a[groupBy === 'bank' ? 'bank' : 'type']))
					),
					FRIEND_PAID
				]
	);
	const flowMode = $derived(controls.flows.length === 1 ? controls.flows[0] : 'both');
	const excluded = $derived(view.hidden.filter((k) => view.keys.includes(k)));
	let search = $state('');
	const filterKeys = $derived(
		view.keys.filter((k) => labelFor(k).toLocaleLowerCase().includes(search.toLocaleLowerCase()))
	);
	const selectedPoints = $derived(pointsAt(data.points, viewState.dateEnd));
	let refreshing = $state(false);
	let refreshError = $state('');

	const typeLabels: Record<string, string> = {
		checking: 'Checking',
		savings: 'Savings',
		credit_card: 'Credit Cards',
		p2p: 'P2P',
		brokerage: 'Brokerage',
		ira: 'IRA',
		'401k': '401(k)',
		cash: 'Cash',
		stored_value: 'Stored value'
	};
	function labelFor(key: string, start = viewState.dateStart, end = viewState.dateEnd): string {
		if (key === FRIEND_PAID) return 'Friend-paid';
		start = start < viewState.dateStart ? viewState.dateStart : start;
		end = end > viewState.dateEnd ? viewState.dateEnd : end;
		const account = accounts.find((a) => a.id === key);
		return groupBy === 'account'
			? account
				? accountLabel(account, start, end)
				: key
			: groupBy === 'type'
				? (typeLabels[key] ?? key)
				: key;
	}
	function iconFor(key: string): string | undefined {
		if (groupBy === 'account') return accounts.find((a) => a.id === key)?.logo;
		if (groupBy === 'bank') return accounts.find((a) => a.bank === key && a.logo)?.logo;
		const category = groupBy === 'category' ? categories.find((c) => c.name === key) : undefined;
		return category && 'iconUrl' in category && typeof category.iconUrl === 'string'
			? category.iconUrl
			: undefined;
	}
	function iconComponent(key: string) {
		if (
			(groupBy === 'account' && accounts.find((a) => a.id === key)?.type === 'cash') ||
			(groupBy === 'type' && key === 'cash')
		)
			return IconCash;
		return groupBy === 'category'
			? IconHelp
			: key === FRIEND_PAID
				? IconArrowsDownUp
				: groupBy === 'bank'
					? IconBuildingBank
					: IconWallet;
	}
	function toggleSeries(key: string): void {
		controls.hidden = toggleHidden(
			{ ...controls.hidden, [groupBy]: view.hidden },
			groupBy,
			key,
			view.applicable
		);
	}
	function setDates(start: string, end: string): void {
		const next = clampRange(start, end, minDate, maxDate);
		controls.activePreset = '';
		controls.dateStart = next.start;
		controls.dateEnd = next.end;
	}
	const money = (v: number): string =>
		v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
	const coverageLabels = {
		verified: 'Verified',
		unverified: 'Unverified',
		missing: 'Missing transactions',
		'investment-unvalued': 'Investment value unavailable'
	};
	const incomplete = $derived(
		data.coverage.some((c) => c.status !== 'verified' || c.basis !== 'money')
	);
	async function refresh(): Promise<void> {
		refreshing = true;
		refreshError = '';
		try {
			const response = await fetch('/api/finance', { cache: 'no-store' });
			if (!response.ok)
				throw new Error(`Refresh failed (${response.status}). Showing the previous data.`);
			data = await response.json();
		} catch (error) {
			refreshError =
				error instanceof Error ? error.message : 'Refresh failed. Showing the previous data.';
		} finally {
			refreshing = false;
		}
	}
	$effect(() => {
		writeControls(storage, viewState);
	});
	onMount(() => {
		const url = new URL(window.location.href);
		url.search = clearControlParams(url.searchParams).toString();
		if (url.href !== window.location.href)
			window.history.replaceState(window.history.state, '', url);
	});
</script>

<Seo title="networth" description="Money over time, across every account." />

<main class="mx-auto flex max-w-5xl flex-col gap-4 p-4 sm:p-6">
	<header class="flex flex-wrap items-end justify-between gap-2">
		<div>
			<h1 class="text-lg font-semibold tracking-tight">networth</h1>
			<p class="text-sm text-muted-foreground">Money over time, across every account</p>
		</div>
		<div class="text-right">
			<div
				class="text-2xl font-semibold tabular-nums"
				title={view.isFlow
					? 'Sum of the visible categorized amounts in this date range, using your shares and excluding internal transfers.'
					: 'Sum of the visible verified transaction ledgers. Credit-card debt subtracts from the subtotal.'}
			>
				{money(view.total)}
			</div>
			<div class="flex items-center justify-end gap-1.5 text-xs text-muted-foreground">
				{view.title}
				{view.cumulative && !view.isFlow
					? `as of ${viewState.dateEnd}`
					: `${viewState.dateStart} to ${viewState.dateEnd}`}
			</div>
		</div>
	</header>

	<div class="flex flex-wrap items-center gap-2">
		<Select.Root
			type="single"
			value={controls.presentation}
			onValueChange={(v) => (controls.presentation = v as 'chart' | 'overview')}
		>
			<Select.Trigger class="min-h-9" aria-label="View">
				{#if controls.presentation === 'chart'}<IconChartBar size={16} />Chart{:else}<IconWallet
						size={16}
					/>Overview{/if}
			</Select.Trigger>
			<Select.Content
				><Select.Item value="chart" label="Chart" /><Select.Item
					value="overview"
					label="Overview"
				/></Select.Content
			>
		</Select.Root>
		<Select.Root
			type="single"
			value={controls.includeClosed ? 'all' : 'open'}
			onValueChange={(v) => (controls.includeClosed = v === 'all')}
		>
			<Select.Trigger class="min-h-9" aria-label="Account status"
				><IconBuildingBank size={16} />{controls.includeClosed
					? 'Open & closed'
					: 'Open accounts'}</Select.Trigger
			>
			<Select.Content
				><Select.Item value="all" label="Open & closed" /><Select.Item
					value="open"
					label="Open accounts"
				/></Select.Content
			>
		</Select.Root>
		<Select.Root
			type="single"
			value={controls.activePreset}
			onValueChange={(v) => (controls.activePreset = v as PresetLabel)}
		>
			<Select.Trigger class="min-h-9">
				<IconCalendarWeek size={16} class="text-muted-foreground" />
				{controls.activePreset === '' ? 'Custom' : controls.activePreset}
			</Select.Trigger>
			<Select.Content>
				{#each PRESET_LABELS as label (label)}
					<Select.Item value={label} {label} />
				{/each}
			</Select.Content>
		</Select.Root>

		<Select.Root
			type="single"
			disabled={controls.presentation === 'overview'}
			value={controls.bucket}
			onValueChange={(v) => (controls.bucket = v as Bucket)}
		>
			<Select.Trigger class="min-h-9">
				<IconCalendarStats size={16} class="text-muted-foreground" />
				{controls.bucket === 'day' ? 'Daily' : controls.bucket === 'week' ? 'Weekly' : 'Monthly'}
			</Select.Trigger>
			<Select.Content>
				<Select.Item value="day" label="Daily" />
				<Select.Item value="week" label="Weekly" />
				<Select.Item value="month" label="Monthly" />
			</Select.Content>
		</Select.Root>

		<Select.Root
			type="single"
			value={groupBy}
			onValueChange={(v) => {
				controls.groupBy = v as GroupBy;
			}}
		>
			<Select.Trigger class="min-h-9">
				<IconStack2 size={16} class="text-muted-foreground" />
				{groupBy === 'account'
					? 'By account'
					: groupBy === 'bank'
						? 'By bank'
						: groupBy === 'type'
							? 'By type'
							: 'By category'}
			</Select.Trigger>
			<Select.Content>
				<Select.Item value="account" label="By account" />
				<Select.Item value="bank" label="By bank" />
				<Select.Item value="type" label="By type" />
				<Select.Item value="category" label="By category" />
			</Select.Content>
		</Select.Root>

		<Select.Root
			type="single"
			disabled={controls.presentation === 'overview'}
			value={controls.kind}
			onValueChange={(v) => (controls.kind = v as 'area' | 'bar' | 'line')}
		>
			<Select.Trigger class="min-h-9">
				{#if controls.kind === 'area'}
					<IconChartAreaFilled size={16} class="text-muted-foreground" />
					Area
				{:else if controls.kind === 'line'}
					<IconChartLine size={16} class="text-muted-foreground" /> Line
				{:else}
					<IconChartBar size={16} class="text-muted-foreground" />
					Bars
				{/if}
			</Select.Trigger>
			<Select.Content>
				<Select.Item value="area" label="Area" />
				<Select.Item value="bar" label="Bars" />
				<Select.Item value="line" label="Line" />
			</Select.Content>
		</Select.Root>

		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<Button
						{...props}
						variant={flowMode === 'both' ? 'outline' : 'default'}
						size="sm"
						class="min-h-9 font-normal"
					>
						<IconArrowsDownUp
							size={16}
							class={flowMode === 'both' ? 'text-muted-foreground' : ''}
						/>
						{flowMode === 'both'
							? 'Spending & Income'
							: flowMode === 'spending'
								? 'Spending'
								: 'Income'}
						<IconChevronDown size={16} class={flowMode === 'both' ? 'text-muted-foreground' : ''} />
					</Button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content class="w-44">
				{#each ['spending', 'income'] as const as dir (dir)}
					<DropdownMenu.CheckboxItem
						checked={controls.flows.includes(dir)}
						closeOnSelect={false}
						onCheckedChange={(checked) => {
							const next = checked
								? [...controls.flows, dir]
								: controls.flows.filter((f) => f !== dir);
							// empty selection means nothing to plot - snap back to both
							controls.flows = next.length === 0 ? ['spending', 'income'] : next;
						}}
					>
						{dir === 'spending' ? 'Spending' : 'Income'}
					</DropdownMenu.CheckboxItem>
				{/each}
			</DropdownMenu.Content>
		</DropdownMenu.Root>

		<Select.Root
			type="single"
			disabled={controls.presentation === 'overview'}
			value={view.cumulative ? 'cumulative' : 'bucket'}
			onValueChange={(v) => (controls.cumulativeChoice = v === 'cumulative')}
		>
			<Select.Trigger class="min-h-9">
				<IconSum size={16} class="text-muted-foreground" />
				{view.cumulative ? 'Cumulative' : 'Per bucket'}
			</Select.Trigger>
			<Select.Content>
				<Select.Item value="bucket" label="Per bucket" />
				<Select.Item value="cumulative" label="Cumulative" />
			</Select.Content>
		</Select.Root>

		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<Button
						{...props}
						variant={excluded.length ? 'default' : 'outline'}
						size="sm"
						class="min-h-9 font-normal"
					>
						<IconFilter size={16} class="text-muted-foreground" />
						{excluded.length === 0 ? 'All series' : `Hiding ${excluded.length}`}
						<IconChevronDown size={16} class="text-muted-foreground" />
					</Button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content class="max-h-96 w-64 overflow-y-auto">
				<div class="sticky top-0 z-10 bg-popover pb-2">
					<Input bind:value={search} aria-label="Search series" placeholder="Search series" />
				</div>
				{#each filterKeys as key (key)}
					<DropdownMenu.CheckboxItem
						checked={!excluded.includes(key)}
						disabled={!view.applicable.includes(key)}
						closeOnSelect={false}
						onCheckedChange={() => toggleSeries(key)}
					>
						{#if iconFor(key)}<span
								class="series-icon mr-1.5"
								style:mask-image={`url("${iconFor(key)}")`}
								aria-hidden="true"
							></span>{:else}{@const Icon = iconComponent(key)}<Icon
								size={16}
								class="mr-1.5"
							/>{/if}
						{labelFor(key)}
					</DropdownMenu.CheckboxItem>
				{/each}
				{#if excluded.length > 0}
					<DropdownMenu.Separator />
					<DropdownMenu.Item
						onclick={() => (controls.hidden = { ...controls.hidden, [groupBy]: [] })}
						>Show all</DropdownMenu.Item
					>
				{/if}
			</DropdownMenu.Content>
		</DropdownMenu.Root>
	</div>

	<div class="flex flex-wrap items-center gap-2 text-xs">
		<label class="flex items-center gap-2"
			>From <input
				class="min-h-9 rounded-md border bg-background px-2"
				type="date"
				min={minDate}
				max={viewState.dateEnd}
				value={viewState.dateStart}
				onchange={(e) => setDates(e.currentTarget.value, viewState.dateEnd)}
			/></label
		>
		<label class="flex items-center gap-2"
			>To <input
				class="min-h-9 rounded-md border bg-background px-2"
				type="date"
				min={viewState.dateStart}
				max={maxDate}
				value={viewState.dateEnd}
				onchange={(e) => setDates(viewState.dateStart, e.currentTarget.value)}
			/></label
		>
	</div>
	<RangeSlider
		min={minDate}
		max={maxDate}
		start={viewState.dateStart}
		end={viewState.dateEnd}
		onchange={setDates}
	/>
	{#if controls.presentation === 'overview'}
		<section aria-label={view.title} class="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
			{#each view.summary as row (row.key)}
				{@const account =
					groupBy === 'account' ? accounts.find((a) => a.id === row.key) : undefined}
				{@const coverage = account
					? data.coverage.find((c) => c.account_id === account.id)
					: undefined}
				<article
					class="flex min-w-0 flex-col gap-1 rounded-md border p-3"
					title={row.value === null && !view.isFlow ? coverage?.reasons.join(' · ') : undefined}
				>
					<div class="flex items-start gap-2 text-xs">
						{#if iconFor(row.key)}<span
								class="series-icon mt-0.5 shrink-0"
								style:mask-image={`url("${iconFor(row.key)}")`}
								aria-hidden="true"
							></span>{:else}{@const Icon = iconComponent(row.key)}<Icon
								size={16}
								class="shrink-0"
							/>{/if}
						<span class="break-words font-medium"
							>{labelFor(
								row.key,
								view.isFlow ? viewState.dateStart : viewState.dateEnd,
								viewState.dateEnd
							)}</span
						>
					</div>
					<div class="text-lg font-semibold tabular-nums">
						{row.value === null ? 'Unavailable' : money(row.value)}
					</div>
					<p class="text-xs text-muted-foreground">
						{#if account?.closed}Closed ·
						{/if}
						{#if view.isFlow}{row.value === null ? 'No categorized activity' : view.title}
						{:else if row.value === null}{coverage
								? coverageLabels[coverage.status]
								: 'Not verified'}
						{:else if coverage?.asOf}Checked {coverage.asOf.slice(0, 10)}
						{:else}Verified subtotal{/if}
					</p>
				</article>
			{/each}
		</section>
	{:else}
		<BalanceChart
			data={view.data}
			bucket={controls.bucket}
			kind={controls.kind}
			net={groupBy === 'category' && flowMode === 'both'}
			{labelFor}
			{iconFor}
			{iconComponent}
			legendKeys={view.keys}
			slotFor={(key) => paletteKeys.indexOf(key)}
			hidden={view.hidden}
			applicable={view.applicable}
			onToggle={toggleSeries}
		/>
	{/if}
	{#if !view.applicable.length}<p class="text-sm text-muted-foreground" role="status">
			No matching data in this date range.
		</p>{/if}
	{#if view.isFlow && view.uncategorized > 0}
		<p class="text-xs text-muted-foreground" role="status">
			{view.uncategorized.toLocaleString('en-US')} uncategorized {view.uncategorized === 1
				? 'entry omitted'
				: 'entries omitted'} from flows
			{groupBy === 'category'
				? 'in this date range, across all categories'
				: 'within these dates and account filters'}.
		</p>
	{/if}
	<div class="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
		<span
			>{incomplete
				? 'Incomplete balance coverage. Balances include verified monetary accounts only; investment values are unavailable.'
				: 'Balances include verified monetary accounts.'}</span
		>
		<Button variant="outline" class="min-h-9" onclick={refresh} disabled={refreshing}
			><IconRefresh size={16} class={refreshing ? 'animate-spin' : ''} />{refreshing
				? 'Refreshing'
				: 'Refresh data'}</Button
		>
	</div>
	{#if refreshError}<p class="text-sm text-destructive" role="alert">{refreshError}</p>{/if}
	<details class="rounded-lg border p-3">
		<summary class="cursor-pointer text-sm">Balance coverage · all accounts</summary>
		<ul class="mt-3 space-y-3 text-xs">
			{#each data.coverage as c (c.account_id)}
				<li class="break-words">
					<span class="font-medium"
						>{accounts.find((a) => a.id === c.account_id)?.name ?? c.account_id}</span
					>: {coverageLabels[c.status]}
					{#if c.asOf}<span class="text-muted-foreground">
							· checked {c.asOf.slice(0, 10)}</span
						>{/if}
					{#if c.reasons.length}<p class="mt-1 text-muted-foreground">
							{c.reasons.join(' · ')}
						</p>{/if}
				</li>
			{/each}
		</ul>
	</details>
	<div>
		<p class="mb-2 text-xs text-muted-foreground">
			Points · all programs · latest snapshots on or before {viewState.dateEnd}
		</p>
		<div class="flex flex-wrap gap-2">
			{#each selectedPoints as p (p.program)}
				<div class="rounded-lg border px-3 py-2">
					<div class="flex flex-wrap items-baseline gap-2">
						<span class="text-sm font-medium">{p.program}</span><span class="text-sm tabular-nums"
							>{p.points.toLocaleString('en-US')} pts</span
						><span class="text-xs text-muted-foreground"
							>{p.estValue === null ? 'Value unavailable' : `≈ ${money(p.estValue)}`}</span
						>
					</div>
					<p class="mt-1 text-xs text-muted-foreground">as of {p.scrapedAt?.slice(0, 10)}</p>
				</div>
			{/each}
		</div>
	</div>
</main>
