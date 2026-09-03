<script lang="ts">
	import Seo from '$lib/components/seo.svelte';
	import BalanceChart from '$lib/components/BalanceChart.svelte';
	import RangeSlider from '$lib/components/RangeSlider.svelte';
	import * as Select from '$lib/components/ui/select';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import {
		IconCalendarWeek,
		IconCalendarStats,
		IconStack2,
		IconChartAreaFilled,
		IconChartBar,
		IconFilter,
		IconChevronDown,
		IconArrowsDownUp,
		IconSum
	} from '@tabler/icons-svelte';
	import { MOCK_ACCOUNTS, MOCK_POINTS, generateMockTxns } from '$lib/finance/mock';
	import { categoryIcon, categoryIconUrl } from '$lib/finance/categoryIcons';
	import { PRESET_LABELS, getPresetRange, type PresetLabel } from '$lib/finance/presets';
	import {
		accumulate,
		bucketize,
		deriveBalances,
		differentiate,
		flowSeries,
		groupSeries,
		type Bucket
	} from '$lib/finance/series';
	import { addDays } from '$lib/finance/presets';
	import type { GroupBy, Txn } from '$lib/finance/types';

	const accounts = MOCK_ACCOUNTS;
	const txns = generateMockTxns();
	const minDate = txns.reduce((m, t) => (t.date < m ? t.date : m), txns[0].date);
	const maxDate = txns.reduce((m, t) => (t.date > m ? t.date : m), txns[0].date);

	// Control state persists across reloads (localStorage, like task-burndown
	// and screentime-dashboard) and is deep-linkable (?chart=bar&bucket=month);
	// URL params win over saved state, saved state wins over defaults. ssr is
	// off so window/localStorage are always available.
	const STORAGE_KEY = 'networth-ui';
	const saved: Record<string, unknown> = (() => {
		try {
			return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
		} catch {
			return {};
		}
	})();
	const params = new URLSearchParams(window.location.search);
	const pick = <T,>(
		param: string | null,
		savedVal: unknown,
		valid: (v: unknown) => v is T,
		fallback: T
	): T => (valid(param) ? param : valid(savedVal) ? savedVal : fallback);

	const isPreset = (v: unknown): v is PresetLabel | '' =>
		v === '' || (PRESET_LABELS as readonly string[]).includes(v as string);
	// A saved custom range ('' preset) restores its dates; presets recompute.
	const savedPreset = isPreset(saved.activePreset) ? saved.activePreset : '1Y';
	const savedStart =
		savedPreset === '' && typeof saved.dateStart === 'string' ? saved.dateStart : '';
	const savedEnd = savedPreset === '' && typeof saved.dateEnd === 'string' ? saved.dateEnd : '';
	let activePreset = $state<PresetLabel | ''>(
		savedPreset === '' && (!savedStart || !savedEnd) ? '1Y' : savedPreset // guard corrupt saves
	);
	let dateStart = $state(savedStart);
	let dateEnd = $state(savedEnd);
	$effect(() => {
		if (activePreset !== '') {
			const r = getPresetRange(activePreset, minDate, maxDate);
			dateStart = r.start;
			dateEnd = r.end;
		}
	});

	const isBucket = (v: unknown): v is Bucket => v === 'day' || v === 'week' || v === 'month';
	const isGroupBy = (v: unknown): v is GroupBy =>
		v === 'account' || v === 'bank' || v === 'type' || v === 'category';
	let bucket = $state<Bucket>(pick(params.get('bucket'), saved.bucket, isBucket, 'day'));
	let groupBy = $state<GroupBy>(pick(params.get('group'), saved.groupBy, isGroupBy, 'account'));
	const isKind = (v: unknown): v is 'area' | 'bar' => v === 'area' || v === 'bar';
	// Bars are the house default for time series (dashboards skill).
	let kind = $state<'area' | 'bar'>(pick(params.get('chart'), saved.kind, isKind, 'bar'));
	// Flow-direction lens: Spending, Income, or both (?flows=spending deep-
	// links it). Both = the full picture (balances / signed flows); a single
	// direction locks the chart to those txns, plotted positive.
	const isFlows = (v: unknown): v is ('spending' | 'income')[] =>
		Array.isArray(v) && v.length > 0 && v.every((f) => f === 'spending' || f === 'income');
	const flowsParam = params.get('flows')
		? (params.get('flows') ?? '').split(',').filter(Boolean)
		: null;
	let flows = $state<('spending' | 'income')[]>(
		pick(null, flowsParam ?? saved.flows, isFlows, ['spending', 'income'])
	);
	const flowMode = $derived<'spending' | 'income' | 'both'>(flows.length === 1 ? flows[0] : 'both');
	// Per bucket vs Cumulative, always available. null = auto: account
	// groupings default Cumulative (they're balances), flow modes default
	// Per bucket. An explicit pick (?cum=1 / ?cum=0) overrides either way.
	let cumulativeChoice = $state<boolean | null>(
		params.get('cum') === '1'
			? true
			: params.get('cum') === '0'
				? false
				: typeof saved.cumulativeChoice === 'boolean'
					? saved.cumulativeChoice
					: null
	);
	// Series hidden from the chart (?hide=a,b deep-links a filtered cut).
	const isStrings = (v: unknown): v is string[] =>
		Array.isArray(v) && v.every((s) => typeof s === 'string');
	let excluded = $state<string[]>(
		params.get('hide')
			? (params.get('hide') ?? '').split(',').filter(Boolean)
			: isStrings(saved.excluded)
				? saved.excluded
				: []
	);

	// Persist every control on change.
	$effect(() => {
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({
				activePreset,
				dateStart,
				dateEnd,
				bucket,
				groupBy,
				kind,
				flows,
				cumulativeChoice,
				excluded
			})
		);
	});

	const labelOf = new Map(accounts.map((a) => [a.id, a.name]));
	const typeLabels: Record<string, string> = {
		checking: 'Checking',
		savings: 'Savings',
		credit_card: 'Credit Cards',
		p2p: 'P2P',
		brokerage: 'Brokerage',
		ira: 'IRA',
		'401k': '401(k)'
	};
	const labelFor = (key: string): string => labelOf.get(key) ?? typeLabels[key] ?? key;

	const balances = $derived(
		dateStart && dateEnd ? deriveBalances(txns, accounts, dateStart, dateEnd) : null
	);
	// The full key list for the current grouping, in stable order - drives
	// both the filter dropdown and the color slots (an entity keeps its
	// color no matter what is filtered out or how series get reordered).
	// Every category shows - no "Other" folding (dashboards skill); the
	// palette carries enough validated slots and icons disambiguate.
	const categoryTotals = new Map<string, number>();
	for (const t of txns) {
		if (t.category && !t.internal)
			categoryTotals.set(t.category, (categoryTotals.get(t.category) ?? 0) + Math.abs(t.amount));
	}
	const categoryKeys = [...categoryTotals.keys()].sort(
		(a, b) => categoryTotals.get(b)! - categoryTotals.get(a)!
	);
	const groupKeys = $derived(
		groupBy === 'account'
			? accounts.map((a) => a.id)
			: groupBy === 'category'
				? categoryKeys
				: [...new Set(accounts.map((a) => (groupBy === 'bank' ? a.bank : a.type)))]
	);
	const slotOf = $derived(new Map(groupKeys.map((k, i) => [k, i])));

	// Account groupings plot LEVELS (running balances, buckets take closing
	// values); the category grouping - and the spending lens under ANY
	// grouping - plots FLOWS (buckets sum txns). The bucket control is obeyed
	// verbatim in both modes - daily flows are spiky, but that's the user's
	// call, never a silent override.
	const isFlow = $derived(groupBy === 'category' || flowMode !== 'both');
	const cumulative = $derived(cumulativeChoice ?? !isFlow);
	const flowKeyOf = $derived.by(() => {
		if (groupBy === 'category') return (t: Txn) => t.category;
		const of = new Map(accounts.map((a) => [a.id, groupBy === 'bank' ? a.bank : a.type]));
		return groupBy === 'account' ? (t: Txn) => t.account_id : (t: Txn) => of.get(t.account_id);
	});
	// Under a single-direction lens, keys with no txns in that direction
	// (income categories under Spending, cards under Income, ...) gray out
	// in the filter dropdown.
	const applicableKeys = $derived.by(() => {
		if (flowMode === 'both') return null;
		const s = new Set<string>();
		for (const t of txns) {
			if (!t.category || t.internal) continue;
			if (flowMode === 'spending' ? t.amount >= 0 : t.amount <= 0) continue;
			const k = flowKeyOf(t);
			if (k) s.add(k);
		}
		return s;
	});
	const chartData = $derived.by(() => {
		if (!dateStart || !dateEnd || !balances) return null;
		let base: ReturnType<typeof bucketize>;
		if (isFlow) {
			base = flowSeries(
				txns,
				dateStart,
				dateEnd,
				bucket,
				flowKeyOf,
				flowMode === 'both' ? 'signed' : flowMode
			);
		} else {
			base = bucketize(groupSeries(balances, accounts, groupBy), bucket);
			if (!cumulative) {
				// Per bucket on balances = each bucket's net CHANGE per account;
				// the day-before-window levels anchor the first bucket's delta.
				const dayBefore = addDays(dateStart, -1);
				const init = groupSeries(
					deriveBalances(txns, accounts, dayBefore, dayBefore),
					accounts,
					groupBy
				);
				base = differentiate(base, new Map(init.series.map((s) => [s.key, s.data[0]])));
			}
		}
		const result = { ...base, series: base.series.filter((s) => !excluded.includes(s.key)) };
		return isFlow && cumulative ? accumulate(result) : result;
	});
	// Filters apply to the headline too (dashboards skill): under account
	// groupings, hidden series drop out of the total; category filters don't
	// partition wealth, so those leave it whole.
	const currentTotal = $derived.by(() => {
		if (!balances) return 0;
		const hiddenAccount = (id: string): boolean => {
			if (groupBy === 'category') return false;
			const key =
				groupBy === 'account'
					? id
					: (accounts.find((a) => a.id === id)?.[groupBy === 'bank' ? 'bank' : 'type'] ?? id);
			return excluded.includes(key);
		};
		return balances.series.reduce(
			(sum, s) => sum + (hiddenAccount(s.key) ? 0 : (s.data.at(-1) ?? 0)),
			0
		);
	});
	const money = (v: number): string =>
		v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
</script>

<Seo title="networth" description="Money over time, across every account." />

<main class="mx-auto flex max-w-5xl flex-col gap-4 p-4 sm:p-6">
	<header class="flex flex-wrap items-end justify-between gap-2">
		<div>
			<h1 class="text-lg font-semibold tracking-tight">networth</h1>
			<p class="text-sm text-muted-foreground">Money over time, across every account</p>
		</div>
		<div class="text-right">
			<div class="text-2xl font-semibold tabular-nums">{money(currentTotal)}</div>
			<div class="flex items-center justify-end gap-1.5 text-xs text-muted-foreground">
				as of {dateEnd}
				<Badge variant="outline">mock data</Badge>
			</div>
		</div>
	</header>

	<div class="flex flex-wrap items-center gap-2">
		<Select.Root
			type="single"
			value={activePreset}
			onValueChange={(v) => (activePreset = v as PresetLabel)}
		>
			<Select.Trigger>
				<IconCalendarWeek size={16} class="text-muted-foreground" />
				{activePreset === '' ? 'Custom' : activePreset}
			</Select.Trigger>
			<Select.Content>
				{#each PRESET_LABELS as label (label)}
					<Select.Item value={label} {label} />
				{/each}
			</Select.Content>
		</Select.Root>

		<Select.Root type="single" value={bucket} onValueChange={(v) => (bucket = v as Bucket)}>
			<Select.Trigger>
				<IconCalendarStats size={16} class="text-muted-foreground" />
				{bucket === 'day' ? 'Daily' : bucket === 'week' ? 'Weekly' : 'Monthly'}
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
				groupBy = v as GroupBy;
				excluded = [];
			}}
		>
			<Select.Trigger>
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

		<Select.Root type="single" value={kind} onValueChange={(v) => (kind = v as 'area' | 'bar')}>
			<Select.Trigger>
				{#if kind === 'area'}
					<IconChartAreaFilled size={16} class="text-muted-foreground" />
					Area
				{:else}
					<IconChartBar size={16} class="text-muted-foreground" />
					Bars
				{/if}
			</Select.Trigger>
			<Select.Content>
				<Select.Item value="area" label="Area" />
				<Select.Item value="bar" label="Bars" />
			</Select.Content>
		</Select.Root>

		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<Button
						{...props}
						variant={flowMode === 'both' ? 'outline' : 'default'}
						size="sm"
						class="font-normal"
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
						checked={flows.includes(dir)}
						closeOnSelect={false}
						onCheckedChange={(checked) => {
							const next = checked ? [...flows, dir] : flows.filter((f) => f !== dir);
							// empty selection means nothing to plot - snap back to both
							flows = next.length === 0 ? ['spending', 'income'] : next;
						}}
					>
						{dir === 'spending' ? 'Spending' : 'Income'}
					</DropdownMenu.CheckboxItem>
				{/each}
			</DropdownMenu.Content>
		</DropdownMenu.Root>

		<Select.Root
			type="single"
			value={cumulative ? 'cumulative' : 'bucket'}
			onValueChange={(v) => (cumulativeChoice = v === 'cumulative')}
		>
			<Select.Trigger>
				<IconSum size={16} class="text-muted-foreground" />
				{cumulative ? 'Cumulative' : 'Per bucket'}
			</Select.Trigger>
			<Select.Content>
				<Select.Item value="bucket" label="Per bucket" />
				<Select.Item value="cumulative" label="Cumulative" />
			</Select.Content>
		</Select.Root>

		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<Button {...props} variant="outline" size="sm" class="font-normal">
						<IconFilter size={16} class="text-muted-foreground" />
						{excluded.length === 0 ? 'All series' : `Hiding ${excluded.length}`}
						<IconChevronDown size={16} class="text-muted-foreground" />
					</Button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content class="max-h-96 w-64 overflow-y-auto">
				{#each groupKeys as key (key)}
					{@const Icon = groupBy === 'category' ? categoryIcon(key) : undefined}
					<DropdownMenu.CheckboxItem
						checked={!excluded.includes(key)}
						disabled={applicableKeys ? !applicableKeys.has(key) : false}
						closeOnSelect={false}
						onCheckedChange={(checked) => {
							excluded = checked ? excluded.filter((k) => k !== key) : [...excluded, key];
						}}
					>
						{#if Icon}
							<Icon size={16} class="mr-1.5 text-muted-foreground" />
						{/if}
						{labelFor(key)}
					</DropdownMenu.CheckboxItem>
				{/each}
				{#if excluded.length > 0}
					<DropdownMenu.Separator />
					<DropdownMenu.Item onclick={() => (excluded = [])}>Show all</DropdownMenu.Item>
				{/if}
			</DropdownMenu.Content>
		</DropdownMenu.Root>
	</div>

	<RangeSlider
		min={minDate}
		max={maxDate}
		start={dateStart}
		end={dateEnd}
		onchange={(start, end) => {
			activePreset = '';
			dateStart = start;
			dateEnd = end;
		}}
	/>

	{#if chartData}
		<BalanceChart
			data={chartData}
			{bucket}
			{kind}
			net={flowMode === 'both'}
			{labelFor}
			slotFor={(k) => slotOf.get(k) ?? -1}
			iconFor={groupBy === 'category' ? categoryIconUrl : undefined}
		/>
	{/if}

	<div class="flex flex-wrap gap-2">
		{#each MOCK_POINTS as p (p.program)}
			<div class="flex items-baseline gap-2 rounded-lg border px-3 py-2">
				<span class="text-sm font-medium">{p.program}</span>
				<span class="text-sm tabular-nums">{p.points.toLocaleString('en-US')} pts</span>
				<span class="text-xs text-muted-foreground tabular-nums">≈ {money(p.estValue)}</span>
			</div>
		{/each}
	</div>
</main>
