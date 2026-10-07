<script lang="ts">
	import { untrack } from 'svelte';
	import Seo from '$lib/components/seo.svelte';
	import { Button } from '$lib/components/ui/button';
	import IconArrowLeft from '@tabler/icons-svelte/icons/arrow-left';
	import IconEye from '@tabler/icons-svelte/icons/eye';
	import IconEyeOff from '@tabler/icons-svelte/icons/eye-off';
	import IconRefresh from '@tabler/icons-svelte/icons/refresh';
	import { readDashboard } from '$lib/offline';
	import { readBenefitPrivacy, writeBenefitPrivacy } from '$lib/finance/benefits';
	import {
		INVESTMENT_METRICS,
		type Investments,
		type InvestmentObservation,
		type InvestmentGroup
	} from '$lib/finance/investments';
	let { data }: { data: Investments & { savedAt: string | null; unavailable: boolean } } = $props();
	let storage: Storage | undefined;
	try {
		storage = window.localStorage;
	} catch {
		/* Storage may be disabled. */
	}
	let hidden = $state(untrack(() => readBenefitPrivacy(storage)));
	let loading = $state(false),
		refreshError = $state('');
	const labels: Record<InvestmentGroup['status'], string> = {
		available: 'Source reported',
		missing: 'Not reported',
		conflict: 'Conflicting source observations',
		'invalid-history': 'Correction history needs review',
		incomplete: 'Complete history unavailable',
		undated: 'Source date unknown',
		unresolved: 'Instrument classification unresolved'
	};
	function amount(row: InvestmentObservation): string {
		if (hidden) return 'Hidden';
		if (row.exact_amount === null) return 'Not reported';
		return `${row.exact_amount}${row.currency ? ` ${row.currency}` : ' native units'}`;
	}
	function toggle() {
		hidden = !hidden;
		writeBenefitPrivacy(storage, hidden);
	}
	async function refresh() {
		loading = true;
		refreshError = '';
		try {
			const result = await readDashboard<Investments>('/api/investments', fetch, { refresh: true });
			data = { ...result.data, savedAt: result.savedAt, unavailable: false };
		} catch {
			refreshError =
				'Could not reload investment observations. Any previous observations remain shown.';
		} finally {
			loading = false;
		}
	}
</script>

<Seo
	title="Investments · networth"
	description="Native investment observations and their independent source dates."
/>
<main
	class="mx-auto flex max-w-7xl flex-col gap-5 px-4 py-6 sm:px-6 sm:py-8"
	data-investments-ready
>
	<header class="flex flex-wrap items-end justify-between gap-4">
		<div>
			<a
				href="/"
				class="mb-3 inline-flex min-h-9 items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
				><IconArrowLeft size={16} />Networth</a
			>
			<h1 class="text-2xl font-semibold tracking-tight">Investments</h1>
			<p class="mt-1 max-w-2xl text-sm text-muted-foreground">
				Native units, prices, and provider values, each with its own source date. These observations
				do not establish a complete portfolio valuation.
			</p>
		</div>
		<div class="flex flex-wrap gap-2">
			<Button variant="outline" class="min-h-11" aria-pressed={hidden} onclick={toggle}
				>{#if hidden}<IconEye size={16} />Show amounts{:else}<IconEyeOff size={16} />Hide amounts{/if}</Button
			>
			<Button variant="outline" class="min-h-11" disabled={loading} onclick={refresh}
				><IconRefresh size={16} />{loading ? 'Reloading' : 'Reload'}</Button
			>
		</div>
	</header>
	{#if data.savedAt}<p role="status" class="text-sm text-muted-foreground">
			Showing saved observations from {new Date(data.savedAt).toLocaleString()}.
			<a href="/investments?online=1" data-sveltekit-reload class="underline">Reconnect</a>
		</p>{/if}
	{#if refreshError}<p role="alert" class="rounded-lg border border-destructive/30 p-3 text-sm">
			{refreshError}
		</p>{/if}
	{#if data.unavailable}<section role="status" class="rounded-xl border border-dashed p-8">
			<h2 class="font-medium">Investment observations unavailable</h2>
			<p class="mt-2 text-sm text-muted-foreground">
				The source could not be read. Reload to try again. Your ledger balances remain available on
				the dashboard.
			</p>
		</section>{:else if !data.instruments.length}<section
			class="rounded-xl border border-dashed p-8"
		>
			<h2 class="font-medium">No native observations recorded</h2>
			<p class="mt-2 text-sm text-muted-foreground">
				No observations means unknown, not a zero balance.
			</p>
		</section>{/if}
	{#each data.instruments as instrument (instrument.id)}
		<article class="min-w-0 rounded-xl border bg-card p-4 sm:p-6">
			<header class="mb-5 min-w-0 break-words">
				<p class="text-xs text-muted-foreground">{instrument.provider_source}</p>
				<h2 class="mt-1 text-lg font-semibold">
					{instrument.native_label ?? instrument.native_security_id}
				</h2>
				<p class="mt-1 text-xs text-muted-foreground">
					{instrument.native_security_id}{#if instrument.share_class}
						· {instrument.share_class}{/if}{#if instrument.representation === 'custody_cash'}
						· Custody cash cross-check, not an additional asset{/if}
				</p>
			</header>
			<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
				{#each instrument.groups as group (group.key)}<section
						class="min-w-0 rounded-lg border p-4"
					>
						<h3 class="text-sm font-medium">
							{INVESTMENT_METRICS[group.metric]}{#if group.price_kind}
								· {group.price_kind.replaceAll('_', ' ')}{/if}
						</h3>
						<p class="mt-2 break-words text-lg font-semibold tabular-nums">
							{group.selected ? amount(group.selected) : labels[group.status]}
						</p>
						<p class="mt-2 text-xs text-muted-foreground">
							{group.time_basis.replaceAll('_', ' ')} · {group.precision === 'date'
								? 'Date only'
								: group.precision === 'timestamp'
									? 'Timestamp'
									: 'Undated'}
						</p>
						{#if group.selected}{@render timing(group.selected)}{/if}
					</section>{/each}
			</div>
			{#if !instrument.groups.length}<p class="text-sm text-muted-foreground">
					No eligible current observations. Future source dates never value an earlier view.
				</p>{/if}
			<details class="mt-5 border-t pt-3">
				<summary class="min-h-11 cursor-pointer text-sm font-medium"
					>Source history ({instrument.observations.length})</summary
				>
				<div class="flex flex-col divide-y">
					{#each instrument.observations as row, index (`${row.id}:${index}`)}<div
							class="min-w-0 py-3"
						>
							<p class="text-sm font-medium">
								{INVESTMENT_METRICS[row.metric]}{#if row.price_kind}
									· {row.price_kind.replaceAll('_', ' ')}{/if}
							</p>
							<p class="mt-1 break-words font-medium tabular-nums">{amount(row)}</p>
							{@render timing(row)}
							{#if row.supersedes_id}<p class="mt-1 text-xs text-muted-foreground">
									Explicit correction of an earlier observation
								</p>{/if}
							{#if row.missing_reason}<p class="mt-1 break-words text-xs text-muted-foreground">
									{hidden ? 'Hidden' : row.missing_reason}
								</p>{/if}
						</div>{/each}
				</div>
			</details>
		</article>
	{/each}
	<p class="text-xs text-muted-foreground">
		Units from different instruments are never added together. Trade execution prices do not fill
		missing NAVs. Reload reads saved source observations; it does not collect new provider data.
	</p>
</main>
{#snippet timing(row: InvestmentObservation)}
	<p class="mt-2 break-words text-xs text-muted-foreground">
		Source as of {row.source_date ?? row.source_at ?? 'unknown'}
	</p>
	<p class="mt-1 break-words text-xs text-muted-foreground">Captured at {row.captured_at}</p>
	{#if row.quote_delay_seconds !== null}<p class="mt-1 text-xs text-muted-foreground">
			Source-reported delay: {row.quote_delay_seconds} seconds
		</p>{/if}
{/snippet}
