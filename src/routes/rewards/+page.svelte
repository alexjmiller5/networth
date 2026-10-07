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
	import type { Rewards } from '$lib/finance/rewards';
	import { rewardActivity } from '$lib/finance/reward-activity';
	import RewardActivityChart from '$lib/components/RewardActivityChart.svelte';
	type View = Rewards & { typedUnavailable: boolean; savedAt: string | null; unavailable: boolean };
	let { data }: { data: View } = $props();
	let storage: Storage | undefined;
	try {
		storage = window.localStorage;
	} catch {
		/* Storage can be disabled. */
	}
	let hidden = $state(untrack(() => readBenefitPrivacy(storage))),
		loading = $state(false),
		message = $state('');
	const amount = (value: string | null, unit: string) =>
		hidden ? 'Hidden' : value === null ? 'Not established' : `${value} ${unit}`;
	function toggle() {
		hidden = !hidden;
		writeBenefitPrivacy(storage, hidden);
	}
	async function refresh() {
		loading = true;
		message = '';
		try {
			const result = await readDashboard<Rewards & { typedUnavailable: boolean }>(
				'/api/rewards',
				fetch,
				{ refresh: true }
			);
			data = { ...result.data, savedAt: result.savedAt, unavailable: false };
		} catch {
			message = 'Could not reload rewards. Previous observations remain shown.';
		} finally {
			loading = false;
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
</script>

<Seo
	title="Rewards · networth"
	description="Native reward histories, available balances, earning and redemption activity."
/>
<main class="mx-auto flex max-w-7xl flex-col gap-5 px-4 py-6 sm:px-6 sm:py-8" data-rewards-ready>
	<header class="flex flex-wrap items-end justify-between gap-4">
		<div>
			<a href="/" class="mb-3 inline-flex min-h-9 items-center gap-1 text-sm text-muted-foreground"
				><IconArrowLeft size={16} />Networth</a
			>
			<h1 class="text-2xl font-semibold tracking-tight">Rewards</h1>
			<p class="mt-1 max-w-2xl text-sm text-muted-foreground">
				What you earned, what is pending, what is available, and what you redeemed. Native units
				stay separate from cash received.
			</p>
		</div>
		<div class="flex flex-wrap gap-2">
			<Button variant="outline" class="min-h-11" aria-pressed={hidden} onclick={toggle}
				>{#if hidden}<IconEye size={16} />Show amounts{:else}<IconEyeOff size={16} />Hide amounts{/if}</Button
			><Button variant="outline" class="min-h-11" disabled={loading} onclick={refresh}
				><IconRefresh size={16} />{loading ? 'Reloading' : 'Reload'}</Button
			>
		</div>
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
	{#each data.programs as program (program.id)}<article
			class="min-w-0 rounded-xl border bg-card p-4 sm:p-6"
		>
			<header class="mb-5">
				<p class="text-xs text-muted-foreground">{program.provider}</p>
				<h2 class="mt-1 break-words text-lg font-semibold">{program.label}</h2>
			</header>
			{#each program.components as component (component.id)}
				{@const activity = rewardActivity(component.events, component.diagnostics.length === 0)}
				<section class="border-t py-5 first:border-t-0 first:pt-0 last:pb-0">
					<h3 class="mb-4 text-sm font-semibold">{component.label} · {component.unit}</h3>
					<dl class="grid grid-cols-2 gap-5 lg:grid-cols-4">
						{#each [['Known earned', component.earned], ['Pending earnings', component.pendingEarned], ['Known redeemed', component.redeemed], ['Known expired', component.expired]] as [label, value]}<div
								class="min-w-0"
							>
								<dt class="text-xs text-muted-foreground">{label}</dt>
								<dd class="mt-1 break-words text-lg font-medium tabular-nums">
									{amount(value, component.unit)}
								</dd>
							</div>{/each}
					</dl>
					{#each component.diagnostics as diagnostic}<p class="mt-3 text-sm text-muted-foreground">
							{diagnostic}
						</p>{/each}
					{#if component.balanceGroups.length}<div class="mt-5 grid gap-3 sm:grid-cols-2">
							{#each component.balanceGroups as group (group.key)}<div
									class="min-w-0 rounded-lg border p-3"
								>
									<h4 class="text-xs font-medium capitalize text-muted-foreground">
										{group.basis.replaceAll('_', ' ')} balance · {group.precision}
									</h4>
									<p class="mt-1 break-words font-medium tabular-nums">
										{group.selected
											? amount(group.selected.exact_amount, component.unit)
											: group.status.replaceAll('-', ' ')}
									</p>
									{#if group.selected}<p class="mt-2 break-words text-xs text-muted-foreground">
											Source as of {group.selected.source_date ??
												group.selected.source_as_of ??
												'unknown'}<br />Captured at {group.selected.scraped_at}
										</p>{/if}
								</div>{/each}
						</div>{/if}
					{#if activity.length}{#key `${activity[0].date}:${activity.at(-1)?.date}`}<RewardActivityChart
								entries={activity}
								unit={component.unit}
								{hidden}
								componentId={component.id}
							/>{/key}{/if}
					<details class="mt-5">
						<summary class="min-h-11 cursor-pointer text-sm font-medium"
							>Native event history ({component.events.length})</summary
						>
						<div class="flex flex-col divide-y">
							{#each component.events as event, index (`${event.id}:${index}`)}<div
									class="flex flex-wrap justify-between gap-3 py-3 text-sm"
								>
									<div>
										<p class="capitalize">{event.kind} · {event.state}</p>
										<p class="mt-1 text-xs text-muted-foreground">
											{event.event_date ?? event.occurred_at ?? 'Date unknown'}
										</p>
										{#if event.supersedes_id}<p class="mt-1 text-xs text-muted-foreground">
												Explicit source correction
											</p>{/if}
									</div>
									<p class="min-w-0 break-words font-medium tabular-nums">
										{amount(event.units_delta, component.unit)}
									</p>
								</div>{/each}
						</div>
					</details>
					<p class="mt-3 text-xs text-muted-foreground">
						Totals cover known event heads, not a claim of complete lifetime activity. Redeemed
						units do not establish the cash or noncash value received.
					</p>
				</section>{/each}
		</article>{/each}
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
