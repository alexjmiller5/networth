<script lang="ts">
	import { untrack } from 'svelte';
	import Seo from '$lib/components/seo.svelte';
	import BalanceChart from '$lib/components/BalanceChart.svelte';
	import RangeSlider from '$lib/components/RangeSlider.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Select from '$lib/components/ui/select';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import IconArrowLeft from '@tabler/icons-svelte/icons/arrow-left';
	import IconEye from '@tabler/icons-svelte/icons/eye';
	import IconEyeOff from '@tabler/icons-svelte/icons/eye-off';
	import IconRefresh from '@tabler/icons-svelte/icons/refresh';
	import IconCoin from '@tabler/icons-svelte/icons/coin';
	import IconWallet from '@tabler/icons-svelte/icons/wallet';
	import IconActivity from '@tabler/icons-svelte/icons/activity';
	import IconCurrencyDollar from '@tabler/icons-svelte/icons/currency-dollar';
	import IconChartBar from '@tabler/icons-svelte/icons/chart-bar';
	import IconCalendarWeek from '@tabler/icons-svelte/icons/calendar-week';
	import IconFilter from '@tabler/icons-svelte/icons/filter';
	import IconChevronDown from '@tabler/icons-svelte/icons/chevron-down';
	import IconClockHour4 from '@tabler/icons-svelte/icons/clock-hour-4';
	import IconTrophy from '@tabler/icons-svelte/icons/trophy';
	import IconInfinity from '@tabler/icons-svelte/icons/infinity';
	import IconCalendarStats from '@tabler/icons-svelte/icons/calendar-stats';
	import IconTrendingUp from '@tabler/icons-svelte/icons/trending-up';
	import IconGift from '@tabler/icons-svelte/icons/gift';
	import IconHourglassEmpty from '@tabler/icons-svelte/icons/hourglass-empty';
	import IconAdjustments from '@tabler/icons-svelte/icons/adjustments';
	import { readDashboard } from '$lib/offline';
	import { readBenefitPrivacy, writeBenefitPrivacy } from '$lib/finance/benefits';
	import { currentBalance, sumRewardUnits, type Rewards } from '$lib/finance/rewards';
	import { rewardSeries, REWARD_SERIES } from '$lib/finance/reward-activity';
	import {
		PRESET_LABELS,
		getPresetRange,
		clampRange,
		addDays,
		type PresetLabel
	} from '$lib/finance/presets';
	import { formatMoney, formatMoneyTick } from '$lib/finance/display';
	import type { Bucket } from '$lib/finance/series';

	type View = Rewards & {
		typedUnavailable: boolean;
		valuesUnavailable?: boolean;
		today?: string;
		savedAt: string | null;
		unavailable: boolean;
	};
	type Measure = 'balances' | 'activity';
	type Lens = 'units' | 'dollars';
	let { data }: { data: View } = $props();
	let storage: Storage | undefined;
	try {
		storage = window.localStorage;
	} catch {
		/* Storage can be disabled. */
	}
	const KEY = 'networth-rewards-ui';
	const MEASURE_KEYS: Record<Measure, string[]> = {
		balances: ['available', 'pending', 'qualifying', 'lifetime', 'earned_period'],
		activity: ['earned', 'redeemed', 'expired', 'adjusted']
	};
	const LABELS: Record<string, string> = {
		available: 'Available',
		pending: 'Pending',
		qualifying: 'Qualifying',
		lifetime: 'Lifetime',
		earned_period: 'Earned in period',
		earned: 'Earned',
		redeemed: 'Redeemed',
		expired: 'Expired',
		adjusted: 'Adjusted'
	};
	const ICONS = {
		available: IconWallet,
		pending: IconClockHour4,
		qualifying: IconTrophy,
		lifetime: IconInfinity,
		earned_period: IconCalendarStats,
		earned: IconTrendingUp,
		redeemed: IconGift,
		expired: IconHourglassEmpty,
		adjusted: IconAdjustments
	} as Record<string, typeof IconWallet>;

	const units = $derived(
		data.programs.flatMap((program) =>
			program.components.map((component) => ({
				key: component.id,
				program,
				component,
				label:
					program.components.length > 1 ? `${program.label} · ${component.label}` : program.label
			}))
		)
	);
	const observationDay = (b: {
		source_date: string | null;
		source_as_of: string | null;
		scraped_at: string;
	}) => b.source_date ?? (b.source_as_of ?? b.scraped_at).slice(0, 10);
	const days = $derived(
		units
			.flatMap(({ component }) => [
				...component.balances.map(observationDay),
				...component.events.flatMap((e) => (e.event_date ? [e.event_date] : []))
			])
			.sort()
	);
	const today = $derived(data.today ?? new Date().toISOString().slice(0, 10));
	const maxDate = $derived(days.at(-1) ?? today);
	const minDate = $derived(days[0] ?? addDays(maxDate, -89));

	interface Prefs {
		component: string | null;
		measure: Measure;
		lens: Lens;
		bucket: Bucket;
		preset: PresetLabel | '';
		start: string | null;
		end: string | null;
		hidden: Record<Measure, string[]>;
	}
	function restore(): Prefs {
		let saved: Partial<Prefs> = {};
		try {
			saved = JSON.parse(storage?.getItem(KEY) ?? '{}') ?? {};
		} catch {
			/* A corrupt preference falls back field by field. */
		}
		const list = (v: unknown) =>
			Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string') : [];
		return {
			component: typeof saved.component === 'string' ? saved.component : null,
			measure: saved.measure === 'activity' ? 'activity' : 'balances',
			lens: saved.lens === 'dollars' ? 'dollars' : 'units',
			bucket: saved.bucket === 'day' || saved.bucket === 'month' ? saved.bucket : 'week',
			preset:
				saved.preset === '' || PRESET_LABELS.includes(saved.preset as PresetLabel)
					? (saved.preset as PresetLabel | '')
					: '90D',
			start: typeof saved.start === 'string' ? saved.start : null,
			end: typeof saved.end === 'string' ? saved.end : null,
			hidden: {
				balances: list(saved.hidden?.balances),
				activity: list(saved.hidden?.activity)
			}
		};
	}
	let prefs = $state<Prefs>(untrack(restore));
	let hidden = $state(untrack(() => readBenefitPrivacy(storage))),
		loading = $state(false),
		message = $state(''),
		valueDraft = $state(''),
		valueMessage = $state(''),
		savingValue = $state(false);
	$effect(() => {
		const snapshot = JSON.stringify(prefs);
		try {
			storage?.setItem(KEY, snapshot);
		} catch {
			/* Device storage is optional. */
		}
	});

	const selected = $derived(units.find((u) => u.key === prefs.component) ?? units[0] ?? null);
	// A relative preset is a rule: it recomputes when new observations arrive.
	const range = $derived(
		prefs.preset
			? getPresetRange(prefs.preset, minDate, maxDate)
			: clampRange(prefs.start, prefs.end, minDate, maxDate)
	);
	const valuePerUnit = $derived(selected?.program.value?.value_per_unit ?? null);
	const dollarsApply = $derived(
		!!selected &&
			(selected.component.currency === 'USD' ||
				(selected.component.role !== 'qualifying' &&
					!selected.component.currency &&
					!!valuePerUnit))
	);
	const lens = $derived<Lens>(prefs.lens === 'dollars' && dollarsApply ? 'dollars' : 'units');
	const series = $derived(
		selected
			? rewardSeries(
					selected.component,
					prefs.measure,
					range.start,
					range.end,
					prefs.bucket,
					lens === 'dollars' && selected.component.currency !== 'USD' ? Number(valuePerUnit) : 1
				)
			: { dates: [], series: [] }
	);
	// Only series this unit can ever have; a redeemable balance never shows qualifying rows.
	const legendKeys = $derived(
		MEASURE_KEYS[prefs.measure].filter(
			(key) =>
				(selected?.component.role !== 'qualifying' &&
					['available', 'pending', 'earned', 'redeemed', 'expired'].includes(key)) ||
				selected?.component.balances.some((b) => b.basis === key) ||
				(key === 'adjusted' &&
					selected?.component.events.some((e) =>
						['adjust', 'transfer', 'reversal'].includes(e.kind)
					))
		)
	);
	const applicable = $derived(
		series.series.filter((s) => s.data.some((v) => v !== 0)).map((s) => s.key)
	);
	const shown = $derived({
		dates: series.dates,
		series: series.series.filter((s) => !prefs.hidden[prefs.measure].includes(s.key))
	});
	const unitLabel = $derived(
		lens === 'dollars' || selected?.component.currency === 'USD'
			? 'USD'
			: (selected?.component.unit ?? '')
	);
	const format = (v: number) =>
		unitLabel === 'USD'
			? formatMoney(v, false)
			: `${v.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${unitLabel}`;
	const tick = (v: number) =>
		unitLabel === 'USD'
			? formatMoneyTick(v, false)
			: Math.abs(v) >= 1000
				? `${(v / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })}k`
				: v.toLocaleString('en-US', { maximumFractionDigits: 2 });

	const totalValue = $derived.by(() => {
		const valued = units.flatMap(({ component }) => (component.dollar ? [component.dollar] : []));
		return {
			value: sumRewardUnits(valued.map((d) => d.value)),
			estimated: valued.some((d) => d.estimated),
			count: new Set(
				units.filter(({ component }) => component.dollar).map(({ program }) => program.id)
			).size
		};
	});
	const amount = (value: string | null, unit: string) =>
		hidden
			? 'Hidden'
			: value === null
				? 'Not established'
				: unit === 'USD'
					? usd(value)
					: `${grouped(value)} ${unit}`;
	function grouped(value: string) {
		const [whole, fraction] = value.split('.');
		const sign = whole.startsWith('-') ? '-' : '';
		const digits = whole.replace('-', '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
		return sign + digits + (fraction ? `.${fraction}` : '');
	}
	// Exact text, padded to cents for display only; estimates are already rounded to cents.
	const usd = (value: string) => {
		if (hidden) return 'Hidden';
		const [whole, fraction = ''] = value.split('.');
		const text = `${grouped(whole)}.${fraction.padEnd(2, '0')}`;
		return text.startsWith('-') ? `-$${text.slice(1)}` : `$${text}`;
	};
	const dateLabel = (value: string) =>
		new Date(value.length === 10 ? `${value}T00:00:00Z` : value).toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric',
			year: 'numeric',
			timeZone: value.length === 10 ? 'UTC' : undefined
		});
	const daysUntil = (date: string) =>
		Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
	function balanceText(component: (typeof units)[number]['component'], basis: string) {
		const balance = currentBalance(component, basis);
		if (!balance) return { value: hidden ? 'Hidden' : 'Not observed', caption: '' };
		return {
			value: amount(balance.amount, component.unit),
			caption: balance.captured
				? `Captured ${dateLabel(balance.asOf)}, no source date`
				: `As of ${dateLabel(balance.asOf)}`
		};
	}
	function rateText(component: (typeof units)[number]['component']) {
		const r = component.earningRate;
		if (r.status !== 'available') return { value: 'Unavailable', caption: r.reason ?? '' };
		const percent = component.currency && component.currency === r.currency;
		return {
			value: percent
				? `${(Number(r.rate) * 100).toLocaleString('en-US', { maximumFractionDigits: 4 })}%`
				: `${r.rate} ${component.unit} per ${r.currency}`,
			caption: hidden
				? `From ${r.events} linked earning events`
				: `${grouped(r.earned!)} ${component.unit} on ${grouped(r.spend!)} ${r.currency} linked spend`
		};
	}
	function expiryText(component: (typeof units)[number]['component']) {
		const e = component.expiry;
		if (e.status === 'scheduled')
			return {
				value: dateLabel(e.expiresOn!),
				caption: `${daysUntil(e.expiresOn!)} days left${e.verified ? '' : ' · public policy, unverified'}`
			};
		if (e.status === 'none') return { value: 'No scheduled expiry', caption: e.reason };
		return { value: 'Unknown', caption: e.reason };
	}
	function capText(program: (typeof units)[number]['program']) {
		if (!program.caps.length)
			return { value: 'No published cap', caption: 'No cap terms apply to this program.' };
		const cap = program.caps.find((c) => c.status === 'available');
		if (!cap) return { value: 'Unavailable', caption: program.caps[0].reason ?? '' };
		return {
			value: amount(cap.remaining, cap.unit ?? ''),
			caption: `${hidden ? 'Hidden' : `${grouped(cap.used!)} of ${grouped(cap.limit!)}`} used${cap.resetsOn ? ` · resets ${dateLabel(cap.resetsOn)}` : ''}`
		};
	}

	const tiles = $derived.by(() => {
		if (!selected) return [];
		const c = selected.component;
		return [
			...(c.role === 'qualifying'
				? [{ label: 'Qualifying', ...balanceText(c, 'qualifying') }]
				: [
						{ label: 'Available', ...balanceText(c, 'available') },
						{ label: 'Pending', ...balanceText(c, 'pending') }
					]),
			{
				label: 'Known earned',
				value: amount(c.earned, c.unit),
				caption: c.diagnostics[0] ?? 'Posted earning events'
			},
			{ label: 'Known redeemed', value: amount(c.redeemed, c.unit), caption: 'Posted redemptions' },
			{ label: 'Known expired', value: amount(c.expired, c.unit), caption: 'Posted expirations' },
			{ label: 'Earning rate', ...rateText(c) },
			{ label: 'Cap headroom', ...capText(selected.program) },
			{ label: 'Next expiry', ...expiryText(c) }
		];
	});
	function toggle() {
		hidden = !hidden;
		writeBenefitPrivacy(storage, hidden);
	}
	async function refresh() {
		loading = true;
		message = '';
		try {
			const result = await readDashboard<View>('/api/rewards', fetch, { refresh: true });
			data = { ...result.data, savedAt: result.savedAt, unavailable: false };
		} catch {
			message = 'Could not reload rewards. Previous observations remain shown.';
		} finally {
			loading = false;
		}
	}
	function setDates(start: string, end: string) {
		prefs.preset = '';
		prefs.start = start;
		prefs.end = end;
	}
	function select(key: string) {
		prefs.component = key;
		valueMessage = '';
	}
	$effect(() => {
		valueDraft = selected?.program.value?.value_per_unit ?? '';
	});
	async function saveValue() {
		if (!selected) return;
		const program = selected.program;
		const value = valueDraft.trim();
		savingValue = true;
		valueMessage = '';
		try {
			const response = await fetch('/api/reward-values', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					program_id: program.id,
					value_per_unit: value === '' ? null : value,
					revision: program.value?.revision ?? null
				})
			});
			if (!response.ok) {
				const body = (await response.json().catch(() => ({}))) as { error?: string };
				valueMessage = body.error ?? 'Could not save this value.';
				return;
			}
			valueMessage = value === '' ? 'Value cleared.' : 'Value saved.';
			await refresh();
		} catch {
			valueMessage = 'Could not save this value. Your entry is still here.';
		} finally {
			savingValue = false;
		}
	}
	const legacy = $derived(
		[...new Set(data.legacyBalances.map((r) => r.program))].sort().map((program) => ({
			program,
			rows: data.legacyBalances
				.filter((r) => r.program === program)
				.sort((a, b) => b.scraped_at.localeCompare(a.scraped_at))
		}))
	);
	const basisLabel = {
		user_override: 'Your value',
		provider_comparable: 'Provider stated',
		estimate: 'Estimate'
	};
</script>

<Seo
	title="Rewards · networth"
	description="Native reward balances, earning, redemption, expiry and caps over time."
/>
<main class="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-6 sm:px-6 sm:py-8" data-rewards-ready>
	<header class="flex flex-wrap items-end justify-between gap-4">
		<div class="min-w-0">
			<a href="/" class="mb-3 inline-flex min-h-9 items-center gap-1 text-sm text-muted-foreground"
				><IconArrowLeft size={16} />Networth</a
			>
			<h1 class="text-2xl font-semibold tracking-tight">Rewards</h1>
			<p class="mt-1 max-w-2xl text-sm text-muted-foreground">
				Available, pending, earned, redeemed and expiring rewards in their own units. Dollars appear
				only from cash rewards or a value you set.
			</p>
		</div>
		{#if !data.unavailable && !data.typedUnavailable}<div class="text-left sm:text-right">
				<div class="text-2xl font-semibold tabular-nums">
					{totalValue.value === null ? 'No dollar values' : usd(totalValue.value)}
				</div>
				<div class="text-xs text-muted-foreground">
					{totalValue.value === null
						? 'Set a value per point to see dollars'
						: `${totalValue.estimated ? 'Estimated, ' : ''}${totalValue.count} of ${data.programs.length} programs · available now`}
				</div>
			</div>{/if}
	</header>
	{#if data.savedAt}<p role="status" class="text-sm text-muted-foreground">
			Showing saved observations from {new Date(data.savedAt).toLocaleString()}.
			<a href="/rewards?online=1" data-sveltekit-reload class="underline">Reconnect</a>
		</p>{/if}
	{#if message}<p role="alert" class="rounded-lg border p-3 text-sm">{message}</p>{/if}
	{#if data.unavailable}<p role="status" class="rounded-xl border border-dashed p-6">
			Rewards could not be read. Reload to try again.
		</p>
	{:else if data.typedUnavailable}<p
			role="status"
			class="rounded-xl border border-dashed p-4 text-sm text-muted-foreground"
		>
			Typed reward histories are unavailable. Original snapshots below preserve their labels without
			assuming units, earning, or cash value.
		</p>{/if}

	{#if selected}
		<div class="flex flex-wrap items-center gap-2">
			<Select.Root type="single" value={selected.key} onValueChange={(v) => select(v)}>
				<Select.Trigger class="min-h-9 max-w-full" aria-label="Program">
					<IconCoin size={16} class="text-muted-foreground" /><span class="truncate"
						>{selected.label}</span
					>
				</Select.Trigger>
				<Select.Content class="max-h-80">
					{#each units as unit (unit.key)}<Select.Item value={unit.key} label={unit.label} />{/each}
				</Select.Content>
			</Select.Root>
			<Select.Root
				type="single"
				value={prefs.measure}
				onValueChange={(v) => (prefs.measure = v as Measure)}
			>
				<Select.Trigger class="min-h-9" aria-label="Measure">
					{#if prefs.measure === 'balances'}<IconWallet
							size={16}
							class="text-muted-foreground"
						/>Balances{:else}<IconActivity size={16} class="text-muted-foreground" />Activity{/if}
				</Select.Trigger>
				<Select.Content>
					<Select.Item value="balances" label="Balances" />
					<Select.Item value="activity" label="Activity" />
				</Select.Content>
			</Select.Root>
			<Select.Root type="single" value={lens} onValueChange={(v) => (prefs.lens = v as Lens)}>
				<Select.Trigger
					class="min-h-9"
					aria-label="Units"
					title={dollarsApply ? undefined : 'Set a dollar value for this program to use dollars'}
				>
					{#if lens === 'dollars'}<IconCurrencyDollar size={16} />Dollars{:else}<IconCoin
							size={16}
							class="text-muted-foreground"
						/>Native units{/if}
				</Select.Trigger>
				<Select.Content>
					<Select.Item value="units" label="Native units" />
					<Select.Item value="dollars" label="Dollars" disabled={!dollarsApply} />
				</Select.Content>
			</Select.Root>
			<Select.Root
				type="single"
				value={prefs.bucket}
				onValueChange={(v) => (prefs.bucket = v as Bucket)}
			>
				<Select.Trigger class="min-h-9" aria-label="Bucket">
					<IconChartBar size={16} class="text-muted-foreground" />
					{prefs.bucket === 'day' ? 'Daily' : prefs.bucket === 'week' ? 'Weekly' : 'Monthly'}
				</Select.Trigger>
				<Select.Content>
					<Select.Item value="day" label="Daily" />
					<Select.Item value="week" label="Weekly" />
					<Select.Item value="month" label="Monthly" />
				</Select.Content>
			</Select.Root>
			<Select.Root
				type="single"
				value={prefs.preset}
				onValueChange={(v) => (prefs.preset = v as PresetLabel)}
			>
				<Select.Trigger class="min-h-9" aria-label="Date preset">
					<IconCalendarWeek size={16} class="text-muted-foreground" />
					{prefs.preset === '' ? 'Custom' : prefs.preset}
				</Select.Trigger>
				<Select.Content>
					{#each PRESET_LABELS as label (label)}<Select.Item value={label} {label} />{/each}
				</Select.Content>
			</Select.Root>
			<DropdownMenu.Root>
				<DropdownMenu.Trigger>
					{#snippet child({ props })}
						<Button
							{...props}
							variant={prefs.hidden[prefs.measure].length ? 'default' : 'outline'}
							size="sm"
							class="min-h-9 font-normal"
						>
							<IconFilter size={16} />
							{prefs.hidden[prefs.measure].length
								? `Hiding ${prefs.hidden[prefs.measure].length}`
								: 'All series'}
							<IconChevronDown size={16} />
						</Button>
					{/snippet}
				</DropdownMenu.Trigger>
				<DropdownMenu.Content class="w-56">
					{#each legendKeys as key (key)}
						{@const Icon = ICONS[key]}
						<DropdownMenu.CheckboxItem
							checked={!prefs.hidden[prefs.measure].includes(key)}
							disabled={!applicable.includes(key)}
							closeOnSelect={false}
							onCheckedChange={(checked) => {
								const next = checked
									? prefs.hidden[prefs.measure].filter((k) => k !== key)
									: [...prefs.hidden[prefs.measure], key];
								// Hiding everything would blank the chart: snap back to all.
								prefs.hidden[prefs.measure] = next.length >= legendKeys.length ? [] : next;
							}}><Icon size={16} class="mr-1.5" />{LABELS[key]}</DropdownMenu.CheckboxItem
						>
					{/each}
					{#if prefs.hidden[prefs.measure].length}
						<DropdownMenu.Separator />
						<DropdownMenu.Item onclick={() => (prefs.hidden[prefs.measure] = [])}
							>Show all</DropdownMenu.Item
						>
					{/if}
				</DropdownMenu.Content>
			</DropdownMenu.Root>
			<Button variant="outline" class="min-h-9" aria-pressed={hidden} onclick={toggle}
				>{#if hidden}<IconEye size={16} />Show amounts{:else}<IconEyeOff size={16} />Hide amounts{/if}</Button
			>
			<Button variant="outline" class="min-h-9" disabled={loading} onclick={refresh}
				><IconRefresh size={16} />{loading ? 'Reloading' : 'Reload'}</Button
			>
		</div>
		<div class="flex flex-wrap items-center gap-2 text-xs">
			<label class="flex items-center gap-2"
				>From <input
					class="min-h-9 rounded-md border bg-background px-2"
					type="date"
					min={minDate}
					max={range.end}
					value={range.start}
					onchange={(e) => setDates(e.currentTarget.value, range.end)}
				/></label
			>
			<label class="flex items-center gap-2"
				>To <input
					class="min-h-9 rounded-md border bg-background px-2"
					type="date"
					min={range.start}
					max={maxDate}
					value={range.end}
					onchange={(e) => setDates(range.start, e.currentTarget.value)}
				/></label
			>
		</div>
		<RangeSlider
			min={minDate}
			max={maxDate}
			start={range.start}
			end={range.end}
			onchange={setDates}
		/>

		<section class="min-w-0 rounded-xl border bg-card p-4 sm:p-6" aria-label="Reward chart">
			<div class="mb-3 flex flex-wrap items-baseline justify-between gap-2">
				<h2 class="text-sm font-semibold">
					{selected.label} · {prefs.measure === 'balances' ? 'balances' : 'posted activity'} in {unitLabel}
				</h2>
				<p class="text-xs text-muted-foreground">
					{prefs.measure === 'balances'
						? 'Each bar is an observation on its source date, or its capture day when the source gives no date.'
						: 'Dated, posted events. Redemptions and expiry plot below zero.'}
				</p>
			</div>
			<BalanceChart
				data={shown}
				bucket={prefs.bucket}
				hideAmounts={hidden}
				{legendKeys}
				hidden={prefs.hidden[prefs.measure]}
				{applicable}
				onToggle={(key) =>
					(prefs.hidden[prefs.measure] = prefs.hidden[prefs.measure].includes(key)
						? prefs.hidden[prefs.measure].filter((k) => k !== key)
						: [...prefs.hidden[prefs.measure], key])}
				labelFor={(key) => LABELS[key] ?? key}
				slotFor={(key) => REWARD_SERIES.indexOf(key)}
				iconComponent={(key) => ICONS[key] ?? IconCoin}
				{format}
				tickFormat={tick}
				heightClass="h-[300px] sm:h-[400px]"
				ariaLabel={`${selected.label} rewards for the selected date range`}
			/>
			{#if !applicable.length}<p class="mt-3 text-sm text-muted-foreground">
					{prefs.measure === 'balances'
						? 'No balance observations in this date range.'
						: (selected.component.diagnostics[0] ?? 'No dated, posted events in this date range.')}
				</p>{/if}
		</section>

		{@const c = selected.component}
		<section
			class="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4"
			aria-label={`${selected.label} figures`}
		>
			{#each tiles as tile (tile.label)}<article
					class="flex min-w-0 flex-col gap-1 rounded-md border p-3"
				>
					<h3 class="text-xs text-muted-foreground">{tile.label}</h3>
					<p class="break-words text-lg font-semibold tabular-nums">{tile.value}</p>
					{#if tile.caption}<p class="break-words text-xs text-muted-foreground">
							{tile.caption}
						</p>{/if}
				</article>{/each}
			<article
				class="col-span-2 flex min-w-0 flex-col gap-2 rounded-md border p-3 sm:col-span-3 lg:col-span-4"
			>
				<h3 class="text-xs text-muted-foreground">Dollar value</h3>
				<p class="break-words text-lg font-semibold tabular-nums">
					{c.dollar ? `${usd(c.dollar.value)}${c.dollar.estimated ? ' est.' : ''}` : 'Not valued'}
				</p>
				{#if c.currency === 'USD'}<p class="text-xs text-muted-foreground">
						Cash rewards are already dollars.
					</p>
				{:else if c.role === 'qualifying'}<p class="text-xs text-muted-foreground">
						Qualifying counters have no dollar value.
					</p>
				{:else}
					<form
						class="flex flex-wrap items-end gap-2"
						onsubmit={(e) => {
							e.preventDefault();
							void saveValue();
						}}
					>
						<label class="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground"
							>Your value, dollars per {c.unit === 'points' ? 'point' : c.unit}
							<Input
								class="min-h-9 w-36"
								inputmode="decimal"
								placeholder="e.g. 0.015"
								disabled={hidden || data.valuesUnavailable || savingValue}
								bind:value={valueDraft}
							/></label
						>
						<Button
							type="submit"
							variant="outline"
							class="min-h-9"
							disabled={hidden || data.valuesUnavailable || savingValue}>Save</Button
						>
					</form>
					<p class="text-xs text-muted-foreground" role="status">
						{data.valuesUnavailable
							? 'Program values are unavailable right now.'
							: hidden
								? 'Show amounts to edit this value.'
								: valueMessage ||
									'Applies to this program only. Leave empty and save to clear. Labelled as an estimate.'}
					</p>
				{/if}
			</article>
		</section>

		<section class="min-w-0 rounded-xl border p-4 sm:p-6" aria-label="Redemptions">
			<h2 class="text-sm font-semibold">Redemptions · {selected.label}</h2>
			{#if !c.redemptions.length}<p class="mt-2 text-sm text-muted-foreground">
					No posted redemptions are recorded for this unit.
				</p>{:else}<div class="mt-2 divide-y">
					{#each c.redemptions as r (r.event.id)}<div
							class="flex flex-wrap justify-between gap-2 py-3 text-sm"
						>
							<div>
								<p>{r.event.event_date ? dateLabel(r.event.event_date) : 'Date unknown'}</p>
								<p class="text-xs text-muted-foreground">
									{r.valuation
										? `${basisLabel[r.valuation.basis]} value, frozen ${dateLabel(r.valuation.valued_at)}`
										: 'No valuation recorded'}
								</p>
							</div>
							<div class="text-right tabular-nums">
								<p class="font-medium">{amount(r.event.units_delta, c.unit)}</p>
								{#if r.valuation}<p class="text-xs text-muted-foreground">
										{hidden
											? 'Hidden'
											: `$${grouped(r.valuation.reward_value)} · ${(Number(r.valuation.rate_at_redemption) * 100).toFixed(2)}¢ per unit`}
									</p>{/if}
							</div>
						</div>{/each}
				</div>{/if}
		</section>

		<section class="min-w-0 rounded-xl border" aria-label="All programs">
			<div class="overflow-x-auto">
				<table class="w-full min-w-[720px] text-left text-sm">
					<thead class="text-xs text-muted-foreground">
						<tr class="border-b">
							<th class="p-3 font-medium">Program</th>
							<th class="p-3 font-medium">Available</th>
							<th class="p-3 font-medium">Pending</th>
							<th class="p-3 font-medium">Earning rate</th>
							<th class="p-3 font-medium">Next expiry</th>
							<th class="p-3 font-medium">Dollar value</th>
						</tr>
					</thead>
					<tbody>
						{#each units as unit (unit.key)}
							{@const a = balanceText(
								unit.component,
								unit.component.role === 'qualifying' ? 'qualifying' : 'available'
							)}
							{@const e = expiryText(unit.component)}
							<tr
								class={`border-b last:border-b-0 ${unit.key === selected.key ? 'bg-muted/60' : ''}`}
							>
								<td class="p-3">
									<button
										type="button"
										class="min-h-9 text-left font-medium underline-offset-4 hover:underline"
										aria-current={unit.key === selected.key ? 'true' : undefined}
										onclick={() => select(unit.key)}>{unit.label}</button
									>
								</td>
								<td class="p-3 tabular-nums"
									>{a.value}{#if a.caption}<span class="block text-xs text-muted-foreground"
											>{a.caption}</span
										>{/if}</td
								>
								<td class="p-3 tabular-nums">{balanceText(unit.component, 'pending').value}</td>
								<td class="p-3">{rateText(unit.component).value}</td>
								<td class="p-3"
									>{e.value}{#if unit.component.expiry.status !== 'unknown' && !unit.component.expiry.verified}<span
											class="block text-xs text-muted-foreground">Public policy, unverified</span
										>{/if}</td
								>
								<td class="p-3 tabular-nums"
									>{unit.component.dollar
										? `${usd(unit.component.dollar.value)}${unit.component.dollar.estimated ? ' est.' : ''}`
										: 'Not valued'}</td
								>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>
	{/if}

	{#if legacy.length}<section class="min-w-0 rounded-xl border p-4 sm:p-6">
			<h2 class="text-lg font-semibold">Original untyped snapshots</h2>
			<p class="mt-1 text-sm text-muted-foreground">
				These captures remain historical evidence. Their amounts are not included in native-unit
				totals.
			</p>
			<div class="mt-4 divide-y">
				{#each legacy as group (group.program)}<details class="py-3">
						<summary class="min-h-11 cursor-pointer break-words text-sm font-medium"
							>{group.program} · {group.rows.length} snapshots</summary
						>
						<div class="flex flex-col gap-2">
							{#each group.rows as row (row.id)}<p
									class="flex flex-wrap justify-between gap-2 text-sm"
								>
									<span class="text-muted-foreground">Captured {row.scraped_at}</span><span
										class="font-medium tabular-nums"
										>{hidden ? 'Hidden' : `${row.points} (unit unverified)`}</span
									>
								</p>{/each}
						</div>
					</details>{/each}
			</div>
		</section>{/if}
	{#if !data.unavailable && !data.typedUnavailable && !data.programs.length && !legacy.length}<p
			class="rounded-xl border border-dashed p-6"
		>
			No reward observations have been recorded.
		</p>{/if}
</main>
