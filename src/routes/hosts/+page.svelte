<script lang="ts">
	import { onMount } from 'svelte';
	import Seo from '$lib/components/seo.svelte';
	import type { Host } from '$lib/server/hosts';
	let hosts: Host[] = $state([]);
	let candidate: { id: string; hash: string } | null = $state(null);
	let label = $state('');
	let busy = $state(false);
	let staged = $state(false);
	let error = $state('');
	let notice = $state('');
	async function readHosts() {
		const response = await fetch('/api/hosts');
		if (!response.ok) throw new Error('Host settings could not be loaded.');
		hosts = ((await response.json()) as { hosts: Host[] }).hosts;
	}
	onMount(() => {
		const capture = () => {
			const params = new URLSearchParams(location.hash.slice(1));
			const id = params.get('id'),
				hash = params.get('hash');
			if (!id || !hash) return;
			candidate = { id, hash };
			label = params.get('label') ?? 'Finance host';
			history.replaceState(null, '', location.pathname);
			staged = false;
			busy = true;
			error = '';
			notice = '';
			send('POST', { action: 'stage', id, hash, label })
				.then(() => {
					if (candidate?.id === id) staged = true;
				})
				.catch((e) => {
					if (candidate?.id === id) error = e.message;
				})
				.finally(() => {
					if (candidate?.id === id) busy = false;
				});
		};
		capture();
		window.addEventListener('hashchange', capture);
		readHosts().catch((e) => (error = e.message));
		return () => window.removeEventListener('hashchange', capture);
	});
	async function send(method: string, body: unknown) {
		const response = await fetch('/api/hosts', {
			method,
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		if (!response.ok) {
			const problem = (await response.json()) as { error?: string };
			throw new Error(problem.error ?? 'Host request failed.');
		}
	}
	async function approve() {
		if (!candidate || busy || !staged) return;
		busy = true;
		error = '';
		notice = '';
		try {
			await send('POST', { action: 'approve', id: candidate.id });
			candidate = null;
			notice = 'Host approved. Its enrollment command finishes on its own.';
			await readHosts();
		} catch (e) {
			error = (e as Error).message;
		} finally {
			busy = false;
		}
	}
	async function revoke(id: string) {
		busy = true;
		error = '';
		notice = '';
		try {
			await send('DELETE', { id });
			notice = 'Host access revoked.';
			await readHosts();
		} catch (e) {
			error = (e as Error).message;
		} finally {
			busy = false;
		}
	}
</script>

<Seo title="Hosts" description="Approve and manage the computers that run finance reviews." />
<main class="mx-auto max-w-2xl space-y-8 px-5 py-10">
	<header class="space-y-2">
		<a class="text-sm underline" href="/">Back to dashboard</a>
		<h1 class="text-2xl font-semibold">Hosts</h1>
		<p class="text-muted-foreground">
			A host computer picks up the finance reviews you start from the dashboard.
		</p>
	</header>
	{#if error}<p role="alert" class="text-destructive">{error}</p>{/if}
	{#if notice}<p role="status">{notice}</p>{/if}
	{#if candidate}
		<section class="space-y-4 rounded-lg border p-5">
			<h2 class="text-lg font-semibold">Approve a host</h2>
			<p>
				Approve only a request you just started with networth-host enroll. Compare this code with
				its terminal:
				<strong class="font-mono">{candidate.hash.slice(0, 8).toUpperCase()}</strong>
			</p>
			<label class="grid gap-2"
				>Host name<input
					class="rounded-md border bg-background p-2"
					maxlength="100"
					readonly
					bind:value={label}
				/></label
			>
			<p class="text-sm text-muted-foreground">
				This computer can pick up finance reviews you start from the dashboard and report their
				progress. It cannot read balances, edit finances, make payments, or redeem rewards.
			</p>
			<button
				class="rounded-md bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50"
				disabled={busy || !staged || !label.trim()}
				onclick={approve}>{busy ? 'Approving…' : 'Approve host'}</button
			>
		</section>
	{:else}<p class="text-muted-foreground">
			To add a host, run <code class="font-mono">networth-host enroll</code> on it and open the link it
			prints.
		</p>{/if}
	<section class="space-y-4">
		<h2 class="text-lg font-semibold">Enrolled hosts</h2>
		{#each hosts as host (host.id)}
			<div class="flex items-center justify-between gap-4 border-b py-3">
				<div>
					<p class="font-medium">{host.label}</p>
					<p class="text-sm text-muted-foreground capitalize">{host.state}</p>
				</div>
				{#if host.state === 'active' || host.state === 'pending'}<button
						class="rounded-md border px-3 py-2 disabled:opacity-50"
						disabled={busy}
						onclick={() => revoke(host.id)}>Revoke</button
					>{/if}
			</div>
		{:else}<p class="text-sm text-muted-foreground">No enrolled hosts.</p>{/each}
	</section>
</main>
