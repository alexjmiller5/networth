<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import IconFlag from '@tabler/icons-svelte/icons/flag';
	import MarkersDialog from '$lib/components/MarkersDialog.svelte';
	import FinanceRunCard from '$lib/components/FinanceRunCard.svelte';
	import { visibleMarkers, type Marker, type MarkerInput } from '$lib/finance/markers';
	import { formatMoney, formatUnits, formatCoverage, valuationLabel } from '$lib/finance/display';
	import IconEye from '@tabler/icons-svelte/icons/eye';
	import IconHeartHandshake from '@tabler/icons-svelte/icons/heart-handshake';
	import IconEyeOff from '@tabler/icons-svelte/icons/eye-off';
	import { readDashboard } from '$lib/offline';
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
	import IconLayoutGrid from '@tabler/icons-svelte/icons/layout-grid';
	import IconFilter from '@tabler/icons-svelte/icons/filter';
	import IconChevronDown from '@tabler/icons-svelte/icons/chevron-down';
	import IconArrowsDownUp from '@tabler/icons-svelte/icons/arrows-down-up';
	import arrowsDownUpSvg from '@tabler/icons/outline/arrows-down-up.svg?raw';
	import giftSvg from '@tabler/icons/outline/gift.svg?raw';
	import IconSum from '@tabler/icons-svelte/icons/sum';
	import IconRefresh from '@tabler/icons-svelte/icons/refresh';
	import IconHelp from '@tabler/icons-svelte/icons/help';
	import IconBuildingBank from '@tabler/icons-svelte/icons/building-bank';
	import IconWallet from '@tabler/icons-svelte/icons/wallet';
	import IconCash from '@tabler/icons-svelte/icons/cash';
	import IconChartPie from '@tabler/icons-svelte/icons/chart-pie';
	import IconGift from '@tabler/icons-svelte/icons/gift';
	import IconReceipt from '@tabler/icons-svelte/icons/receipt';
	import IconCoin from '@tabler/icons-svelte/icons/coin';
	import IconLockDollar from '@tabler/icons-svelte/icons/lock-dollar';
	import IconChevronRight from '@tabler/icons-svelte/icons/chevron-right';
	import IconArrowLeft from '@tabler/icons-svelte/icons/arrow-left';
	import { ownerOf } from '$lib/finance/categoryTree';
	import {
		PRESET_LABELS,
		clampRange,
		getPresetRange,
		isDate,
		type PresetLabel
	} from '$lib/finance/presets';
	import {
		ACCOUNT_STATUSES,
		accountFilter,
		accountLabel,
		ASSET_CLASSES,
		BALANCE_SOURCES,
		buildView,
		CLASS_LABELS,
		clearControlParams,
		FRIEND_PAID,
		measureOf,
		REWARDS_PAID,
		pointsAt,
		readControls,
		setMeasure,
		SOURCE_LABELS,
		STATUS_LABELS,
		toggleChoice,
		toggleHidden,
		totalLabels,
		writeControls,
		type Controls,
		type Measure
	} from '$lib/finance/controls';
	import { accountGroup, type Bucket } from '$lib/finance/series';
	import type { Account, AssetClass, GroupBy, AccountCoverage } from '$lib/finance/types';
	import type { Estate } from '$lib/finance/assemble';

	let { data }: { data: Estate & { savedAt: string | null } } = $props();
	// Noncash assets chart like balance-only accounts; snapshots saved before them have none.
	const assets = $derived(data.assets ?? []);
	const accounts = $derived([...data.accounts, ...assets]);
	let markers = $state<Marker[]>([]);
	let markersOpen = $state(false);
	let markersLoaded = $state(false);
	let markersError = $state('');
	async function markerRequest<T = null>(method = 'GET', body?: unknown) {
		const response = await fetch('/api/markers', {
			method,
			cache: 'no-store',
			redirect: 'error',
			signal: AbortSignal.timeout(10000),
			...(body === undefined
				? {}
				: { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
		});
		if (
			!response.headers.get('content-type')?.includes('application/json') &&
			response.status !== 204
		)
			throw new Error('Markers could not be loaded. Reconnect and try again.');
		const result = response.status === 204 ? null : ((await response.json()) as { error?: string });
		if (!response.ok) throw new Error(result?.error ?? 'Marker request failed. Try again.');
		return result as T;
	}
	async function loadMarkers() {
		const result = await markerRequest<{ markers: Marker[] }>();
		markers = result.markers;
		markersLoaded = true;
		markersError = '';
	}
	async function saveMarker(input: MarkerInput, createId: string, existing?: Marker) {
		const marker: Marker = await markerRequest<Marker>(existing ? 'PUT' : 'POST', {
			...input,
			...(existing ? { id: existing.id, revision: existing.revision } : { id: createId })
		});
		markers = [...markers.filter((m) => m.id !== marker.id), marker];
	}
	async function deleteMarker(marker: Marker) {
		await markerRequest('DELETE', { id: marker.id, revision: marker.revision });
		markers = markers.filter((m) => m.id !== marker.id);
	}
	const categories = $derived(data.categories);
	const dates = $derived(
		[
			...data.txns.flatMap((t) => [t.date, ...(t.shares ?? []).map((s) => s.date)]),
			...data.points.map((p) => p.scrapedAt.slice(0, 10)),
			...data.coverage.map((c) => c.asOf?.slice(0, 10)),
			...(data.valuations ?? []).map((v) => v.end)
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
	const view = $derived(
		buildView(data.txns, accounts, categories, viewState, data.coverage, data.valuations ?? [])
	);
	/** Price date (and carried NAV age) behind an investment account's value at the shown end date. */
	function pricedAsOf(key: string): string | undefined {
		const v =
			groupBy === 'account' ? data.valuations?.find((x) => x.account_id === key) : undefined;
		return v && valuationLabel(v, viewState.dateEnd);
	}
	const groupBy = $derived(controls.groupBy);
	const groupKeys = (list: Account[]) =>
		[...list].sort((a, b) => a.id.localeCompare(b.id)).map((a) => accountGroup(a, groupBy));
	// Assets slot after every existing key so adding one never repaints another series.
	const paletteKeys = $derived(
		groupBy === 'category'
			? [...categories]
					.sort((a, b) => a.sort - b.sort || a.id.localeCompare(b.id))
					.map((c) => c.name)
			: [...new Set([...groupKeys(data.accounts), FRIEND_PAID, ...groupKeys(assets), REWARDS_PAID])]
	);
	const drillPath = $derived(view.drill.path);
	function drill(name: string): void {
		const category = categories.find((c) => c.name === name);
		if (category) controls.categoryNode = category.id;
	}
	const measure = $derived(measureOf(controls));
	const totals = $derived(totalLabels(view.isFlow, controls.bucket));
	const accountsFilter = $derived(accountFilter(controls));
	const MEASURES = [
		{ value: 'balances', label: 'Balances', icon: IconWallet },
		{ value: 'net', label: 'Net flow', icon: IconArrowsDownUp },
		{ value: 'spending', label: 'Spending', icon: IconReceipt },
		{ value: 'income', label: 'Income', icon: IconCoin }
	] as const;
	const VIEWS = [
		{ value: 'bar', label: 'Bars', icon: IconChartBar },
		{ value: 'area', label: 'Area', icon: IconChartAreaFilled },
		{ value: 'line', label: 'Line', icon: IconChartLine },
		{ value: 'overview', label: 'Overview', icon: IconLayoutGrid }
	] as const;
	const BUCKETS: Record<Bucket, string> = { day: 'Daily', week: 'Weekly', month: 'Monthly' };
	const GROUP_LABELS: Record<GroupBy, string> = {
		account: 'By account',
		bank: 'By bank',
		type: 'By type',
		asset: 'By asset class',
		category: 'By category'
	};
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
		credit_card: 'Credit cards',
		p2p: 'P2P',
		brokerage: 'Brokerage',
		ira: 'IRA',
		'401k': '401(k)',
		cash: 'Cash',
		stored_value: 'Stored value',
		security_deposit: 'Security deposits'
	};
	function labelFor(key: string, start = viewState.dateStart, end = viewState.dateEnd): string {
		if (key === FRIEND_PAID) return 'Friend-paid';
		if (key === REWARDS_PAID) return 'Points-paid';
		if (groupBy === 'asset') return CLASS_LABELS[key as AssetClass] ?? key;
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
	// Inline SVG data URLs so canvas legends and tooltips draw these icons without a request.
	const ownIcons: Record<string, string> = {
		[FRIEND_PAID]: `data:image/svg+xml,${encodeURIComponent(arrowsDownUpSvg)}`,
		[REWARDS_PAID]: `data:image/svg+xml,${encodeURIComponent(giftSvg)}`
	};
	function iconFor(key: string): string | undefined {
		if (groupBy !== 'category' && key in ownIcons) return ownIcons[key];
		if (groupBy === 'account') return accounts.find((a) => a.id === key)?.logo;
		if (groupBy === 'bank') return accounts.find((a) => a.bank === key && a.logo)?.logo;
		const category =
			groupBy === 'category' ? categories.find((c) => c.name === ownerOf(key)) : undefined;
		return category && 'iconUrl' in category && typeof category.iconUrl === 'string'
			? category.iconUrl
			: undefined;
	}
	/** Latest principal event on or before the shown end for the deposits behind a key. */
	function depositAsOf(key: string): string | null | undefined {
		const ids = new Set(assets.filter((a) => accountGroup(a, groupBy) === key).map((a) => a.id));
		if (!ids.size) return undefined;
		return (
			data.txns.filter((t) => ids.has(t.account_id ?? '') && t.date <= viewState.dateEnd).at(-1)
				?.date ?? null
		);
	}
	function iconComponent(key: string) {
		if (key === FRIEND_PAID) return IconArrowsDownUp;
		if (key === REWARDS_PAID) return IconGift;
		if (groupBy === 'asset')
			return key === 'cash' ? IconCash : key === 'deposits' ? IconLockDollar : IconChartPie;
		if (groupBy !== 'category' && depositAsOf(key) !== undefined) return IconLockDollar;
		if (
			(groupBy === 'account' && accounts.find((a) => a.id === key)?.type === 'cash') ||
			(groupBy === 'type' && key === 'cash')
		)
			return IconCash;
		return groupBy === 'category' ? IconHelp : groupBy === 'bank' ? IconBuildingBank : IconWallet;
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
	const money = (v: number): string => formatMoney(v, controls.hideAmounts);
	const coverageText = (c: AccountCoverage) => formatCoverage(c, controls.hideAmounts);
	const selectedCoverage = $derived(
		data.coverage.filter((c) => view.accountIds.includes(c.account_id))
	);
	const incomplete = $derived(
		selectedCoverage.some((c) => c.status !== 'verified' || (c.basis !== 'money' && !c.valuedAsOf))
	);
	async function refresh(): Promise<void> {
		refreshing = true;
		refreshError = '';
		try {
			const result = await readDashboard<Estate>('/api/finance', fetch, {
				refresh: true,
				timeoutMs: 45_000
			});
			data = { ...result.data, savedAt: result.savedAt };
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
		void loadMarkers().catch(() => {
			markersError = 'Markers are unavailable. Financial data is still shown.';
		});
		const url = new URL(window.location.href);
		url.search = clearControlParams(url.searchParams).toString();
		if (url.href !== window.location.href)
			window.history.replaceState(window.history.state, '', url);
	});
</script>

<Seo title="networth" description="Money over time, across every account." />

<main class="mx-auto flex max-w-7xl flex-col gap-4 p-4 sm:p-6">
	<header class="flex flex-wrap items-end justify-between gap-2">
		<div>
			<h1 class="text-lg font-semibold tracking-tight">networth</h1>
			<p class="text-sm text-muted-foreground">Money over time, across every account</p>
		</div>
		<div class="sm:text-right">
			<div
				class="text-2xl font-semibold tabular-nums"
				title={view.isFlow
					? 'Sum of the visible categorized amounts in this date range, using your shares and excluding internal transfers.'
					: 'Sum of the visible verified transaction ledgers and refundable deposits. Credit-card debt subtracts from the subtotal.'}
			>
				{!view.isFlow && !view.summary.some((row) => row.value !== null)
					? 'Unavailable'
					: money(view.total)}
			</div>
			<div class="flex items-center gap-1.5 text-xs text-muted-foreground sm:justify-end">
				{view.title}
				{view.cumulative && !view.isFlow
					? `as of ${viewState.dateEnd}`
					: `${viewState.dateStart} to ${viewState.dateEnd}`}
			</div>
		</div>
	</header>
	{#if data.savedAt}<p class="text-xs text-muted-foreground" role="status">
			Showing saved data from {new Date(data.savedAt).toLocaleString()}.
			<a href="/?online=1" data-sveltekit-reload class="underline">Reconnect</a>
		</p>{/if}

	<div class="flex flex-wrap items-center justify-between gap-2">
		<nav aria-label="Pages" class="flex flex-wrap gap-1">
			<Button href="/rewards" variant="ghost" class="min-h-9"><IconGift size={16} />Rewards</Button>
			<Button href="/investments" variant="ghost" class="min-h-9"
				><IconChartLine size={16} />Investments</Button
			>
			<Button href="/benefits" variant="ghost" class="min-h-9"
				><IconHeartHandshake size={16} />Benefits</Button
			>
		</nav>
		<div class="flex flex-wrap gap-2">
			<Button
				variant="outline"
				class="min-h-9"
				disabled={controls.hideAmounts || !markersLoaded}
				title={controls.hideAmounts
					? 'Show amounts to edit marker text'
					: markersLoaded
						? 'Add or edit event markers'
						: 'Loading markers'}
				onclick={() => (markersOpen = true)}><IconFlag size={16} />Markers</Button
			>
			<Button
				variant="outline"
				class="min-h-9"
				aria-pressed={controls.hideAmounts}
				title="Conceal amounts on this device; account names and chart shapes stay visible"
				onclick={() => (controls.hideAmounts = !controls.hideAmounts)}
			>
				{#if controls.hideAmounts}<IconEye size={16} />Show amounts{:else}<IconEyeOff
						size={16}
					/>Hide amounts{/if}
			</Button>
			<Button
				variant="outline"
				class="min-h-9"
				title="Reload the latest data from the hub; this does not start a bank sync"
				onclick={refresh}
				disabled={refreshing}
				><IconRefresh size={16} class={refreshing ? 'animate-spin' : ''} />{refreshing
					? 'Refreshing'
					: 'Refresh'}</Button
			>
		</div>
	</div>
	{#if refreshError}<p class="text-sm text-destructive" role="alert">{refreshError}</p>{/if}

	<div class="flex flex-wrap items-center gap-2" role="group" aria-label="Chart controls">
		<Select.Root
			type="single"
			value={measure}
			onValueChange={(v) => Object.assign(controls, setMeasure(controls, v as Measure))}
		>
			<Select.Trigger class="min-h-9" aria-label="Measure">
				{@const M = MEASURES.find((m) => m.value === measure) ?? MEASURES[0]}
				<M.icon size={16} class="text-muted-foreground" />{M.label}
			</Select.Trigger>
			<Select.Content>
				{#each MEASURES as m (m.value)}
					<Select.Item value={m.value} label={m.label}
						><m.icon size={16} class="text-muted-foreground" />{m.label}</Select.Item
					>
				{/each}
			</Select.Content>
		</Select.Root>

		<Select.Root
			type="single"
			value={controls.activePreset}
			onValueChange={(v) => (controls.activePreset = v as PresetLabel)}
		>
			<Select.Trigger class="min-h-9" aria-label="Date range">
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
			<Select.Trigger class="min-h-9" aria-label="Bucket">
				<IconCalendarStats size={16} class="text-muted-foreground" />
				{BUCKETS[controls.bucket]}
			</Select.Trigger>
			<Select.Content>
				{#each Object.entries(BUCKETS) as [value, label] (value)}
					<Select.Item {value} {label} />
				{/each}
			</Select.Content>
		</Select.Root>

		<Select.Root
			type="single"
			value={groupBy}
			onValueChange={(v) => {
				controls.groupBy = v as GroupBy;
				// Categories group flows only: balances have no category.
				if (v === 'category') controls.measure = 'activity';
			}}
		>
			<Select.Trigger class="min-h-9" aria-label="Group by">
				<IconStack2 size={16} class="text-muted-foreground" />
				{GROUP_LABELS[groupBy]}
			</Select.Trigger>
			<Select.Content>
				{#each Object.entries(GROUP_LABELS) as [value, label] (value)}
					<Select.Item {value} {label} />
				{/each}
			</Select.Content>
		</Select.Root>

		<Select.Root
			type="single"
			value={controls.presentation === 'overview' ? 'overview' : controls.kind}
			onValueChange={(v) => {
				controls.presentation = v === 'overview' ? 'overview' : 'chart';
				if (v !== 'overview') controls.kind = v as Controls['kind'];
			}}
		>
			<Select.Trigger class="min-h-9" aria-label="View">
				{@const V =
					VIEWS.find(
						(x) => x.value === (controls.presentation === 'overview' ? 'overview' : controls.kind)
					) ?? VIEWS[0]}
				<V.icon size={16} class="text-muted-foreground" />{V.label}
			</Select.Trigger>
			<Select.Content>
				{#each VIEWS as v (v.value)}
					{#if v.value === 'overview'}<Select.Separator />{/if}
					<Select.Item value={v.value} label={v.label}
						><v.icon size={16} class="text-muted-foreground" />{v.label}</Select.Item
					>
				{/each}
			</Select.Content>
		</Select.Root>

		<Select.Root
			type="single"
			disabled={controls.presentation === 'overview'}
			value={view.cumulative ? 'cumulative' : 'bucket'}
			onValueChange={(v) => (controls.cumulativeChoice = v === 'cumulative')}
		>
			<Select.Trigger class="min-h-9" aria-label="Per bucket or running total">
				<IconSum size={16} class="text-muted-foreground" />
				{view.cumulative ? totals.cumulative : totals.bucket}
			</Select.Trigger>
			<Select.Content>
				<Select.Item value="bucket" label={totals.bucket} />
				<Select.Item value="cumulative" label={totals.cumulative} />
			</Select.Content>
		</Select.Root>

		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<Button
						{...props}
						variant={accountsFilter.narrowed ? 'default' : 'outline'}
						size="sm"
						class="min-h-9 max-w-72 font-normal"
						aria-label={`Accounts: ${accountsFilter.label}`}
						title={accountsFilter.label}
					>
						<IconBuildingBank
							size={16}
							class={accountsFilter.narrowed ? '' : 'text-muted-foreground'}
						/>
						<span class="truncate">{accountsFilter.label}</span>
						<IconChevronDown
							size={16}
							class={accountsFilter.narrowed ? '' : 'text-muted-foreground'}
						/>
					</Button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content class="max-h-96 w-72 overflow-y-auto">
				<DropdownMenu.Label>Status</DropdownMenu.Label>
				{#each ACCOUNT_STATUSES as status (status)}
					<DropdownMenu.CheckboxItem
						checked={controls.accountStatuses.includes(status)}
						closeOnSelect={false}
						onCheckedChange={() =>
							(controls.accountStatuses = toggleChoice(
								controls.accountStatuses,
								status,
								ACCOUNT_STATUSES
							))}>{STATUS_LABELS[status]}</DropdownMenu.CheckboxItem
					>
				{/each}
				<DropdownMenu.Separator />
				<DropdownMenu.Label>Asset class</DropdownMenu.Label>
				{#each ASSET_CLASSES as asset (asset)}
					<DropdownMenu.CheckboxItem
						checked={controls.assetClassFilter.includes(asset)}
						closeOnSelect={false}
						onCheckedChange={() =>
							(controls.assetClassFilter = toggleChoice(
								controls.assetClassFilter,
								asset,
								ASSET_CLASSES
							))}>{CLASS_LABELS[asset]}</DropdownMenu.CheckboxItem
					>
				{/each}
				<DropdownMenu.Separator />
				<DropdownMenu.Label>Source</DropdownMenu.Label>
				{#each BALANCE_SOURCES as source (source)}
					<DropdownMenu.CheckboxItem
						checked={controls.balanceSources.includes(source)}
						closeOnSelect={false}
						onCheckedChange={() =>
							(controls.balanceSources = toggleChoice(
								controls.balanceSources,
								source,
								BALANCE_SOURCES
							))}>{SOURCE_LABELS[source]}</DropdownMenu.CheckboxItem
					>
				{/each}
				{#if accountsFilter.narrowed}
					<DropdownMenu.Separator />
					<DropdownMenu.Item
						onclick={() => {
							controls.accountStatuses = [...ACCOUNT_STATUSES];
							controls.assetClassFilter = [...ASSET_CLASSES];
							controls.balanceSources = [...BALANCE_SOURCES];
						}}>Show all</DropdownMenu.Item
					>
				{/if}
				<p class="px-2 py-1 text-xs text-muted-foreground">
					Cash includes balances outside investment accounts, net of credit-card debt. Deposits are
					refundable principal someone else holds; they count in net worth but are not spendable.
					Wallets & rewards are stored-value balances, points-paid spending and points.
				</p>
			</DropdownMenu.Content>
		</DropdownMenu.Root>

		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<Button
						{...props}
						variant={excluded.length ? 'default' : 'outline'}
						size="sm"
						class="min-h-9 font-normal"
						aria-label="Series"
					>
						<IconFilter size={16} class={excluded.length ? '' : 'text-muted-foreground'} />
						{excluded.length === 0 ? 'All series' : `Hiding ${excluded.length}`}
						<IconChevronDown size={16} class={excluded.length ? '' : 'text-muted-foreground'} />
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
	{#if groupBy === 'category' && drillPath.length}
		<nav aria-label="Category breadcrumb" class="flex flex-wrap items-center gap-1 text-sm">
			<Button
				variant="outline"
				size="sm"
				class="min-h-9"
				onclick={() => (controls.categoryNode = drillPath.at(-2)?.id ?? '')}
				><IconArrowLeft size={16} />Back</Button
			>
			<button
				type="button"
				class="min-h-9 rounded px-1.5 text-muted-foreground hover:text-foreground"
				onclick={() => (controls.categoryNode = '')}>All categories</button
			>
			{#each drillPath as crumb, i (crumb.id)}
				<IconChevronRight size={14} class="text-muted-foreground" aria-hidden="true" />
				{#if i === drillPath.length - 1}
					<span class="px-1.5 font-medium" aria-current="page">{crumb.name}</span>
				{:else}
					<button
						type="button"
						class="min-h-9 rounded px-1.5 text-muted-foreground hover:text-foreground"
						onclick={() => (controls.categoryNode = crumb.id)}>{crumb.name}</button
					>
				{/if}
			{/each}
		</nav>
	{/if}
	{#if controls.presentation === 'overview'}
		<section
			aria-label={view.title}
			class="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6"
		>
			{#each view.summary as row (row.key)}
				{@const account =
					groupBy === 'account' ? accounts.find((a) => a.id === row.key) : undefined}
				{@const coverage = account
					? data.coverage.find((c) => c.account_id === account.id)
					: undefined}
				<article
					class="flex min-w-0 flex-col gap-1 rounded-md border p-2"
					class:opacity-60={row.value === null && view.isFlow}
					title={row.value === null && !view.isFlow
						? coverage
							? coverageText(coverage).details
							: undefined
						: undefined}
				>
					<div class="flex items-start gap-2 text-xs">
						{#if iconFor(row.key) && (groupBy === 'account' || groupBy === 'bank')}<img
								src={iconFor(row.key)}
								alt=""
								class="size-5 shrink-0 rounded-sm bg-white p-0.5"
							/>
						{:else if iconFor(row.key)}<span
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
						{#if view.drill.drillable.includes(row.key)}<button
								type="button"
								class="-m-2 ml-auto flex size-9 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
								aria-label={`Show the ${labelFor(row.key)} breakdown`}
								title={`Show the ${labelFor(row.key)} breakdown`}
								onclick={() => drill(row.key)}><IconChevronRight size={16} /></button
							>{/if}
					</div>
					<div class="text-lg font-semibold tabular-nums">
						{row.value === null ? (view.isFlow ? money(0) : 'Unavailable') : money(row.value)}
					</div>
					<p class="text-xs text-muted-foreground">
						{#if account?.closed}Closed ·
						{/if}
						{#if view.isFlow}{row.value === null ? 'No categorized activity' : view.title}
						{:else if depositAsOf(row.key) !== undefined}Not spendable{depositAsOf(row.key)
								? ` · as of ${depositAsOf(row.key)}`
								: ''}
						{:else if row.value === null}{coverage
								? coverageText(coverage).label
								: 'Not verified'}{#if coverage?.status === 'investment-unvalued' && coverage.reasons.length}{` · ${coverageText(coverage).details}`}{/if}
						{:else if pricedAsOf(row.key)}{pricedAsOf(row.key)}
						{:else if coverage?.asOf}Checked {coverage.asOf.slice(0, 10)}
						{:else}Verified subtotal{/if}
					</p>
				</article>
			{/each}
		</section>
	{:else}
		<BalanceChart
			data={view.data}
			markers={visibleMarkers(markers, viewState.dateStart, viewState.dateEnd)}
			hideAmounts={controls.hideAmounts}
			bucket={controls.bucket}
			kind={controls.kind}
			net={measure === 'net'}
			{labelFor}
			{iconFor}
			{iconComponent}
			legendKeys={view.keys}
			slotFor={(key) => paletteKeys.indexOf(groupBy === 'category' ? ownerOf(key) : key)}
			drillable={view.drill.drillable}
			onDrill={drill}
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
	<p class="text-xs text-muted-foreground">
		{incomplete
			? 'Incomplete coverage. Charts include verified monetary accounts and investment market values on days every holding has a current price (workplace plan NAVs carry forward between captures); gaps are unavailable, never zero.'
			: 'Balances include verified monetary accounts and priced investment holdings.'}{assets.length
			? ' Deposits come from evidenced principal events.'
			: ''}
	</p>
	<FinanceRunCard accounts={data.accounts} />
	{#if markersError}<p class="text-sm text-destructive" role="alert">
			{markersError}
			<button
				class="underline"
				onclick={() => {
					void loadMarkers().catch(() => {
						markersError = 'Markers are unavailable. Try again later.';
					});
				}}>Retry markers</button
			>
		</p>{/if}
	<details class="rounded-lg border p-3">
		<summary class="cursor-pointer text-sm">Balance coverage · selected accounts</summary>
		<ul class="mt-3 space-y-3 text-xs">
			{#each selectedCoverage as c (c.account_id)}
				<li class="break-words">
					<span class="font-medium"
						>{accounts.find((a) => a.id === c.account_id)?.name ?? c.account_id}</span
					>: {coverageText(c).label}
					{#if c.asOf}<span class="text-muted-foreground">
							· checked {c.asOf.slice(0, 10)}</span
						>{/if}
					{#if c.valuedAsOf}<span class="text-muted-foreground">
							· market value as of {c.valuedAsOf}</span
						>{/if}
					{#if c.reasons.length}<p class="mt-1 text-muted-foreground">
							{coverageText(c).details}
						</p>{/if}
				</li>
			{/each}
		</ul>
	</details>
	{#if controls.balanceSources.includes('rewards') && controls.assetClassFilter.includes('cash')}
		<div>
			<p class="mb-2 text-xs text-muted-foreground">
				Points · all programs · latest snapshots on or before {viewState.dateEnd}
			</p>
			<div class="flex flex-wrap gap-2">
				{#each selectedPoints as p (p.program)}
					<div class="rounded-lg border px-3 py-2">
						<div class="flex flex-wrap items-baseline gap-2">
							<span class="text-sm font-medium">{p.program}</span><span class="text-sm tabular-nums"
								>{formatUnits(p.points, controls.hideAmounts)} pts</span
							><span class="text-xs text-muted-foreground"
								>{p.estValue === null ? 'Value unavailable' : `≈ ${money(p.estValue)}`}</span
							>
						</div>
						<p class="mt-1 text-xs text-muted-foreground">as of {p.scrapedAt?.slice(0, 10)}</p>
					</div>
				{/each}
			</div>
		</div>
	{/if}
</main>

{#if markersOpen && !controls.hideAmounts}
	<MarkersDialog
		open={markersOpen}
		{markers}
		onSave={saveMarker}
		onDelete={deleteMarker}
		onReload={loadMarkers}
		onClose={() => (markersOpen = false)}
	/>
{/if}
