<script lang="ts">
	import { onMount } from 'svelte';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Button } from '$lib/components/ui/button';
	import { Badge, type BadgeVariant } from '$lib/components/ui/badge';
	import { Input } from '$lib/components/ui/input';
	import IconBuildingBank from '@tabler/icons-svelte/icons/building-bank';
	import IconChevronDown from '@tabler/icons-svelte/icons/chevron-down';
	import IconPlayerPlay from '@tabler/icons-svelte/icons/player-play';
	import IconPlayerStop from '@tabler/icons-svelte/icons/player-stop';
	import IconTerminal2 from '@tabler/icons-svelte/icons/terminal-2';
	import { isActive, type FinanceRun, type RunStatus } from '$lib/finance/run-contract';
	import type { Account } from '$lib/finance/types';

	let { accounts }: { accounts: Account[] } = $props();
	const open = $derived(accounts.filter((a) => !a.closed));
	const KEY = 'networth-finance-run';
	// null = every open account, so accounts added later are included by default.
	let chosen = $state<string[] | null>(null);
	let search = $state('');
	let runs = $state<FinanceRun[]>([]);
	let loaded = $state(false);
	let busy = $state(false);
	let error = $state('');
	const selected = $derived(
		chosen === null ? open.map((a) => a.id) : chosen.filter((id) => open.some((a) => a.id === id))
	);
	const latest = $derived(runs[0]);
	const nameOf = (id: string) => accounts.find((a) => a.id === id)?.name ?? id;
	const LABELS: Record<RunStatus, [string, BadgeVariant]> = {
		queued: ['Queued for the Mac mini', 'secondary'],
		claimed: ['Starting agent', 'secondary'],
		running: ['Running', 'default'],
		done: ['Done', 'outline'],
		failed: ['Failed', 'destructive'],
		canceled: ['Canceled', 'outline']
	};
	const when = (ms: number | null) =>
		ms === null ? '' : new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

	async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
		const response = await fetch(path, {
			method,
			cache: 'no-store',
			redirect: 'error',
			signal: AbortSignal.timeout(10000),
			...(body === undefined
				? {}
				: { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
		});
		const result = (await response.json().catch(() => ({}))) as T & { error?: string };
		if (!response.ok) throw new Error(result.error ?? 'Finance run request failed. Try again.');
		return result;
	}
	async function load() {
		runs = (await request<{ runs: FinanceRun[] }>('/api/finance/runs')).runs;
		loaded = true;
	}
	async function act(fn: () => Promise<unknown>) {
		busy = true;
		error = '';
		try {
			await fn();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Finance run request failed. Try again.';
		} finally {
			busy = false;
			await load().catch(() => {});
		}
	}
	const start = () =>
		act(() =>
			request('/api/finance/runs', 'POST', {
				request_id: crypto.randomUUID(),
				account_ids: selected
			})
		);
	const cancel = (id: string) => act(() => request(`/api/finance/runs/${id}/cancel`, 'POST'));
	function toggle(id: string, on: boolean) {
		const next = on ? [...selected, id] : selected.filter((s) => s !== id);
		save(next.length === open.length ? null : next);
	}
	function save(next: string[] | null) {
		chosen = next;
		try {
			localStorage.setItem(KEY, JSON.stringify({ accounts: next }));
		} catch {
			// Preferences are a convenience; private windows still work.
		}
	}
	onMount(() => {
		try {
			const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null')?.accounts;
			if (Array.isArray(saved) && saved.every((s) => typeof s === 'string')) chosen = saved;
		} catch {
			chosen = null;
		}
		let timer: ReturnType<typeof setTimeout>;
		const tick = async () => {
			await load().catch(() => {
				if (!loaded) error = 'Finance runs are unavailable. Reconnect and try again.';
			});
			timer = setTimeout(tick, latest && isActive(latest.status) ? 5000 : 30000);
		};
		void tick();
		return () => clearTimeout(timer);
	});
</script>

<section class="rounded-lg border p-3 sm:p-4" aria-labelledby="finance-run-title">
	<div class="flex flex-wrap items-center justify-between gap-2">
		<div>
			<h2 id="finance-run-title" class="text-sm font-medium">Finance review</h2>
			<p class="text-xs text-muted-foreground">Collects the selected accounts on the Mac mini</p>
		</div>
		<div class="flex flex-wrap items-center gap-2">
			<DropdownMenu.Root>
				<DropdownMenu.Trigger>
					{#snippet child({ props })}
						<Button
							{...props}
							variant={chosen === null ? 'outline' : 'default'}
							size="sm"
							class="min-h-9 font-normal"
							aria-label="Accounts to review"
						>
							<IconBuildingBank size={16} />
							{selected.length === open.length
								? `All accounts (${open.length})`
								: selected.length === 0
									? 'Choose accounts'
									: selected.length === 1
										? nameOf(selected[0])
										: `${selected.length} accounts`}
							<IconChevronDown size={16} class="text-muted-foreground" />
						</Button>
					{/snippet}
				</DropdownMenu.Trigger>
				<DropdownMenu.Content class="max-h-96 w-72 overflow-y-auto">
					<div class="sticky top-0 z-10 bg-popover pb-2">
						<Input bind:value={search} aria-label="Search accounts" placeholder="Search accounts" />
					</div>
					{#each open.filter((a) => `${a.name} ${a.bank} ${a.id}`
							.toLowerCase()
							.includes(search.toLowerCase())) as account (account.id)}
						<DropdownMenu.CheckboxItem
							checked={selected.includes(account.id)}
							closeOnSelect={false}
							onCheckedChange={(on) => toggle(account.id, on)}
							>{account.name}</DropdownMenu.CheckboxItem
						>
					{/each}
					<DropdownMenu.Separator />
					{#if chosen !== null}
						<DropdownMenu.Item onclick={() => save(null)}>Select all</DropdownMenu.Item>
					{/if}
					{#if selected.length}
						<DropdownMenu.Item onclick={() => save([])}>Clear</DropdownMenu.Item>
					{/if}
				</DropdownMenu.Content>
			</DropdownMenu.Root>
			<Button
				class="min-h-9"
				size="sm"
				onclick={start}
				disabled={busy || !loaded || !selected.length}><IconPlayerPlay size={16} />Run</Button
			>
		</div>
	</div>
	{#if latest}
		{@const [label, variant] = LABELS[latest.status]}
		<div class="mt-3 grid gap-1.5 text-xs" role="status" aria-live="polite">
			<div class="flex flex-wrap items-center gap-2">
				<Badge {variant}
					>{latest.cancel_requested && isActive(latest.status) ? 'Cancel requested' : label}</Badge
				>
				<span class="text-muted-foreground"
					>{latest.account_ids.length === 1
						? nameOf(latest.account_ids[0])
						: `${latest.account_ids.length} accounts`}</span
				>
				{#if isActive(latest.status) && !latest.cancel_requested}
					<Button
						variant="outline"
						size="sm"
						class="ml-auto min-h-9"
						disabled={busy}
						onclick={() => cancel(latest.id)}><IconPlayerStop size={16} />Cancel</Button
					>
				{/if}
			</div>
			{#if latest.tab_label || latest.agent_name}
				<p class="flex flex-wrap items-center gap-1.5 break-all">
					<IconTerminal2 size={14} class="text-muted-foreground" aria-hidden="true" />
					{latest.tab_label ?? 'Herdr tab pending'}{#if latest.agent_name}<span
							class="text-muted-foreground"
							>· agent {latest.agent_name}{latest.agent_kind ? ` (${latest.agent_kind})` : ''}</span
						>{/if}
				</p>
			{/if}
			<p class="text-muted-foreground">
				Requested {when(latest.created_at)}{#if latest.started_at}
					· started {when(latest.started_at)}{/if}{#if latest.finished_at}
					· finished {when(latest.finished_at)}{/if}
			</p>
			{#if latest.summary}<p class="break-words">{latest.summary}</p>{/if}
		</div>
	{:else if loaded}
		<p class="mt-3 text-xs text-muted-foreground">No finance review has run from here yet.</p>
	{/if}
	{#if error}<p class="mt-2 text-sm text-destructive" role="alert">{error}</p>{/if}
</section>
