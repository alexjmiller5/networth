<script lang="ts">
	import { onMount } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import IconDownload from '@tabler/icons-svelte/icons/download';
	import IconTrash from '@tabler/icons-svelte/icons/trash';
	import IconPencil from '@tabler/icons-svelte/icons/pencil';

	// Owner-entered price sources (Networth's PRICES_DB): which provider series values
	// each ledger security. The daily cron fills the cache; "Fetch prices" runs it now.
	interface Mapping {
		account_id: string;
		security_id: string;
		provider: 'tiingo' | 'fidelity' | 'alphavantage' | 'netbenefits';
		symbol: string | null;
		revision: number;
	}
	interface Result {
		provider: string;
		symbol: string;
		status: string;
		rows: number;
		detail?: string;
	}
	const PROVIDERS = {
		tiingo: 'Tiingo (daily close)',
		fidelity: 'Fidelity fund NAV (fund number)',
		alphavantage: 'Alpha Vantage (last 100 days)',
		netbenefits: 'NetBenefits NAV (finance runs)'
	};
	const SHORT = {
		tiingo: 'Tiingo',
		fidelity: 'Fidelity NAV',
		alphavantage: 'Alpha Vantage',
		netbenefits: 'NetBenefits'
	};
	let mappings = $state<Mapping[]>([]);
	let error = $state('');
	let saving = $state(false);
	let fetching = $state(false);
	let results = $state<Result[] | null>(null);
	let draft = $state({
		account_id: '',
		security_id: '',
		provider: 'tiingo' as Mapping['provider'],
		symbol: '',
		revision: null as number | null
	});

	async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T | null> {
		const response = await fetch(path, {
			method,
			cache: 'no-store',
			redirect: 'error',
			signal: AbortSignal.timeout(60_000),
			...(body === undefined
				? {}
				: { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
		});
		if (response.status === 204) return null;
		const result = (await response.json().catch(() => ({}))) as T & { error?: string };
		if (!response.ok) throw new Error(result.error ?? 'Request failed. Try again.');
		return result;
	}
	async function load() {
		try {
			mappings = (await request<{ mappings: Mapping[] }>('/api/price-mappings'))!.mappings;
			error = '';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Price sources are unavailable.';
		}
	}
	async function save(event: SubmitEvent) {
		event.preventDefault();
		saving = true;
		try {
			await request('/api/price-mappings', 'PUT', {
				...draft,
				symbol: draft.provider === 'netbenefits' ? null : draft.symbol.trim()
			});
			draft = { account_id: '', security_id: '', provider: 'tiingo', symbol: '', revision: null };
			await load();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not save.';
		} finally {
			saving = false;
		}
	}
	async function remove(m: Mapping) {
		try {
			await request('/api/price-mappings', 'DELETE', {
				account_id: m.account_id,
				security_id: m.security_id,
				revision: m.revision
			});
			await load();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not remove.';
		}
	}
	async function fetchPrices() {
		fetching = true;
		try {
			results = (await request<{ results: Result[] }>('/api/prices/refresh', 'POST'))!.results;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Prices could not be fetched.';
		} finally {
			fetching = false;
		}
	}
	onMount(load);
</script>

<section class="min-w-0 rounded-xl border bg-card p-4 sm:p-6" aria-labelledby="price-sources">
	<div class="flex flex-wrap items-start justify-between gap-3">
		<div class="min-w-0">
			<h2 id="price-sources" class="text-lg font-semibold">Price sources</h2>
			<p class="mt-1 max-w-2xl text-sm text-muted-foreground">
				Each ledger security's price series. A holding without one, or without a close for the day,
				leaves its account's market value unavailable.
			</p>
		</div>
		<Button variant="outline" class="min-h-11" disabled={fetching} onclick={fetchPrices}
			><IconDownload size={16} />{fetching ? 'Fetching' : 'Fetch prices'}</Button
		>
	</div>
	{#if error}<p role="alert" class="mt-3 text-sm text-destructive">{error}</p>{/if}
	{#if results}<ul class="mt-3 space-y-1 text-xs text-muted-foreground" role="status">
			{#each results as r (`${r.provider}:${r.symbol}`)}
				<li class="break-words">
					{r.symbol} ({r.provider}): {r.status === 'available'
						? `${r.rows.toLocaleString('en-US')} closes`
						: `unavailable - ${r.detail ?? 'no data'}`}
				</li>
			{/each}
		</ul>{/if}
	<ul class="mt-4 divide-y border-y text-sm">
		{#each mappings as m (`${m.account_id}:${m.security_id}`)}
			<li class="flex items-center justify-between gap-2 py-2">
				<div class="min-w-0">
					<p class="font-medium break-words">{m.security_id} · {m.account_id}</p>
					<p class="text-xs text-muted-foreground" title={PROVIDERS[m.provider]}>
						{SHORT[m.provider]}{m.symbol ? ` · ${m.symbol}` : ''}
					</p>
				</div>
				<div class="flex shrink-0 gap-1">
					<Button
						variant="ghost"
						size="icon"
						class="size-9"
						aria-label={`Edit ${m.account_id} ${m.security_id}`}
						onclick={() =>
							(draft = {
								account_id: m.account_id,
								security_id: m.security_id,
								provider: m.provider,
								symbol: m.symbol ?? '',
								revision: m.revision
							})}><IconPencil size={16} /></Button
					>
					<Button
						variant="ghost"
						size="icon"
						class="size-9"
						aria-label={`Remove ${m.account_id} ${m.security_id}`}
						onclick={() => remove(m)}><IconTrash size={16} /></Button
					>
				</div>
			</li>
		{:else}
			<li class="py-3 text-muted-foreground">No price sources yet.</li>
		{/each}
	</ul>
	<form class="mt-4 grid gap-2 sm:grid-cols-[1fr_1fr_1fr_1fr_auto]" onsubmit={save}>
		<Input
			aria-label="Account id"
			placeholder="Account id"
			class="min-h-11"
			bind:value={draft.account_id}
			readonly={draft.revision !== null}
			required
		/>
		<Input
			aria-label="Ledger security"
			placeholder="Ledger security"
			class="min-h-11"
			bind:value={draft.security_id}
			readonly={draft.revision !== null}
			required
		/>
		<select
			aria-label="Source"
			class="min-h-11 rounded-md border bg-background px-2 text-sm"
			bind:value={draft.provider}
		>
			{#each Object.entries(PROVIDERS) as [value, label] (value)}<option {value}>{label}</option
				>{/each}
		</select>
		<Input
			aria-label="Provider symbol"
			placeholder={draft.provider === 'fidelity' ? 'Fund number' : 'Symbol'}
			class="min-h-11"
			bind:value={draft.symbol}
			disabled={draft.provider === 'netbenefits'}
			required={draft.provider !== 'netbenefits'}
		/>
		<Button type="submit" class="min-h-11" disabled={saving}
			>{draft.revision === null ? 'Add' : 'Save'}</Button
		>
	</form>
</section>
