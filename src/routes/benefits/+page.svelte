<script lang="ts">
	import { untrack } from 'svelte';
	import Seo from '$lib/components/seo.svelte';
	import { Button } from '$lib/components/ui/button';
	import IconArrowLeft from '@tabler/icons-svelte/icons/arrow-left';
	import IconEye from '@tabler/icons-svelte/icons/eye';
	import IconEyeOff from '@tabler/icons-svelte/icons/eye-off';
	import IconRefresh from '@tabler/icons-svelte/icons/refresh';
	import IconHeartHandshake from '@tabler/icons-svelte/icons/heart-handshake';
	import { readDashboard } from '$lib/offline';
	import {
		BENEFIT_METRICS,
		benefitMoney,
		readBenefitPrivacy,
		writeBenefitPrivacy,
		type Benefits,
		type BenefitObservation
	} from '$lib/finance/benefits';
	let { data }: { data: Benefits & { savedAt: string | null } } = $props();
	let storage: Storage | undefined;
	try {
		storage = window.localStorage;
	} catch {
		/* Storage may be blocked. */
	}
	let hideAmounts = $state(untrack(() => readBenefitPrivacy(storage)));
	let refreshing = $state(false);
	let refreshError = $state('');
	const metrics = Object.entries(BENEFIT_METRICS) as [keyof typeof BENEFIT_METRICS, string][];
	function toggleAmounts() {
		hideAmounts = !hideAmounts;
		writeBenefitPrivacy(storage, hideAmounts);
	}
	async function refresh() {
		refreshing = true;
		refreshError = '';
		try {
			const result = await readDashboard<Benefits>('/api/benefits', fetch, { refresh: true });
			data = { ...result.data, savedAt: result.savedAt };
		} catch {
			refreshError = 'Could not reload benefits. Previous observations are still shown.';
		} finally {
			refreshing = false;
		}
	}
	function metricText(observation: BenefitObservation, key: keyof typeof BENEFIT_METRICS) {
		if (key === 'vested_balance' && observation.vested_visibility === 'suppressed')
			return 'Suppressed by provider';
		return benefitMoney(observation[key], observation.currency, hideAmounts);
	}
	const capturedAt = (value: string) => `${value.slice(0, 10)} ${value.slice(11, 19)} UTC`;
</script>

<Seo
	title="Benefits · networth"
	description="Provider benefit observations, plan years, and source dates."
/>
<main class="mx-auto flex max-w-7xl flex-col gap-5 px-4 py-6 sm:px-6 sm:py-8" data-benefits-ready>
	<header class="flex flex-wrap items-end justify-between gap-4">
		<div class="min-w-0">
			<a
				href="/"
				class="mb-3 inline-flex min-h-9 items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
				><IconArrowLeft size={16} />Networth</a
			>
			<h1 class="flex items-center gap-2 text-2xl font-semibold tracking-tight">
				<IconHeartHandshake size={24} />Benefits
			</h1>
			<p class="mt-1 max-w-xl text-sm text-muted-foreground">
				Provider-reported elections, claims, and conditional credits. Separate from liquid balances
				and net worth.
			</p>
		</div>
		<div class="flex flex-wrap gap-2">
			<Button
				variant="outline"
				class="min-h-11"
				aria-label={hideAmounts ? 'Show amounts' : 'Hide amounts'}
				aria-pressed={hideAmounts}
				onclick={toggleAmounts}
			>
				{#if hideAmounts}<IconEye size={16} />Show amounts{:else}<IconEyeOff size={16} />Hide
					amounts{/if}
			</Button>
			<Button
				variant="outline"
				class="min-h-11"
				aria-label="Reload benefits"
				disabled={refreshing}
				onclick={refresh}
				><IconRefresh size={16} class={refreshing ? 'animate-spin' : ''} />{refreshing
					? 'Reloading'
					: 'Reload'}</Button
			>
		</div>
	</header>
	{#if data.savedAt}<p role="status" class="text-sm text-muted-foreground">
			Showing saved data from {new Date(data.savedAt).toLocaleString()}.
			<a href="/benefits?online=1" data-sveltekit-reload class="underline">Reconnect</a>
		</p>{/if}
	{#if refreshError}<p
			role="alert"
			class="rounded-lg border border-destructive/30 p-3 text-sm text-destructive"
		>
			{refreshError}
		</p>{/if}
	{#if !data.plans.length}<div class="rounded-xl border border-dashed p-8 text-center">
			<h2 class="font-medium">No benefit plans available</h2>
			<p class="mt-1 text-sm text-muted-foreground">
				Provider observations will appear here when recorded.
			</p>
		</div>{/if}
	{#each data.plans as plan (plan.id)}
		<article class="min-w-0 overflow-hidden rounded-xl border bg-card" data-plan-id={plan.id}>
			<header class="flex flex-wrap items-start justify-between gap-3 border-b p-4 sm:p-6">
				<div class="min-w-0 break-words">
					<p class="text-xs font-medium text-muted-foreground">{plan.provider}</p>
					<h2 class="mt-1 text-lg font-semibold">{plan.name}</h2>
					<p class="mt-1 text-xs text-muted-foreground">
						{plan.kind === 'fsa' ? 'Flexible spending' : 'Conditional retiree health'} · {plan.currency}{#if plan.native_plan_id}
							· Plan {plan.native_plan_id}{/if}
					</p>
				</div>
				<span class="rounded-full bg-muted px-2.5 py-1 text-xs capitalize text-muted-foreground"
					>{plan.status}</span
				>
			</header>
			{#if !plan.years.length}<p class="p-4 text-sm text-muted-foreground sm:p-6">
					No observations recorded for this plan.
				</p>{/if}
			{#each plan.years as group (group.year)}
				<section
					class="border-b p-4 last:border-b-0 sm:p-6"
					aria-label={group.year ? `Plan year ${group.year}` : 'Plan year not reported'}
				>
					<h3 class="mb-3 text-sm font-semibold">
						{group.year ? `Plan year ${group.year}` : 'Plan year not reported'}
					</h3>
					{@render observationView(group.observations[0])}
					{#if group.observations.length > 1}<details class="mt-5 border-t pt-3">
							<summary class="min-h-9 cursor-pointer text-sm font-medium text-muted-foreground"
								>Other observations ({group.observations.length - 1})</summary
							>
							<div class="mt-3 flex flex-col gap-5">
								{#each group.observations.slice(1) as observation (observation.id)}<div
										class="rounded-lg border p-3 sm:p-4"
									>
										{@render observationView(observation)}
									</div>{/each}
							</div>
						</details>{/if}
				</section>
			{/each}
		</article>
	{/each}
	<p class="text-xs text-muted-foreground">
		Each amount is an independent source observation. Reload reads stored observations; it does not
		collect new provider data.
	</p>
</main>

{#snippet observationView(observation: BenefitObservation)}
	<div class="mb-4 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
		<p class="font-medium">Source as of {observation.source_as_of ?? 'unknown'}</p>
		<p>Captured at {capturedAt(observation.observed_at)}</p>
	</div>
	<dl class="grid grid-cols-2 gap-x-4 gap-y-5 lg:grid-cols-4">
		{#each metrics as [key, label]}<div class="min-w-0" data-benefit-metric={key}>
				<dt class="mb-1 text-xs text-muted-foreground">{label}</dt>
				<dd class="break-words text-base font-medium tabular-nums sm:text-lg">
					{metricText(observation, key)}
				</dd>
			</div>{/each}
	</dl>
	{#if observation.eligibility_status}<div class="mt-5 border-t pt-3 text-sm">
			<span class="font-medium">Eligibility</span>
			<p class="mt-1 break-words text-muted-foreground">
				{hideAmounts ? 'Hidden' : observation.eligibility_status}
			</p>
		</div>{/if}
{/snippet}
