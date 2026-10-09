<script lang="ts">
	import { onMount } from 'svelte';
	import Seo from '$lib/components/seo.svelte';
	import type { WidgetDevice } from '$lib/server/widget-devices';
	let devices: WidgetDevice[] = $state([]);
	let candidate: { id: string; hash: string; kind: 'widget' | 'host' } | null = $state(null);
	let label = $state('');
	let busy = $state(false);
	let staged = $state(false);
	let error = $state('');
	let notice = $state('');
	async function readDevices() {
		const response = await fetch('/api/widget-devices');
		if (!response.ok) throw new Error('Device settings could not be loaded.');
		devices = ((await response.json()) as { devices: WidgetDevice[] }).devices;
	}
	onMount(() => {
		const capture = () => {
			const params = new URLSearchParams(location.hash.slice(1));
			const id = params.get('id'),
				hash = params.get('hash');
			if (!id || !hash) return;
			const kind = params.get('kind') === 'host' ? 'host' : 'widget';
			candidate = { id, hash, kind };
			label = params.get('label') ?? (kind === 'host' ? 'Finance host' : 'My phone');
			history.replaceState(null, '', location.pathname);
			staged = false;
			busy = true;
			error = '';
			notice = '';
			send('POST', { action: 'stage', id, hash, label, kind })
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
		readDevices().catch((e) => (error = e.message));
		return () => window.removeEventListener('hashchange', capture);
	});
	async function send(method: string, body: unknown) {
		const response = await fetch('/api/widget-devices', {
			method,
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		if (!response.ok) {
			const problem = (await response.json()) as { error?: string };
			throw new Error(problem.error ?? 'Device request failed.');
		}
	}
	async function approve() {
		if (!candidate || busy || !staged) return;
		busy = true;
		error = '';
		notice = '';
		try {
			await send('POST', { action: 'approve', id: candidate.id });
			const host = candidate.kind === 'host';
			candidate = null;
			notice = host
				? 'Host approved. Its enrollment command finishes on its own.'
				: 'Device approved. Return to the Networth app and check its connection.';
			await readDevices();
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
			notice =
				'Device access revoked. Saved data on an offline device remains until the app reconnects or is removed.';
			await readDevices();
		} catch (e) {
			error = (e as Error).message;
		} finally {
			busy = false;
		}
	}
</script>

<Seo title="Widgets" description="Connect and manage your Networth widgets." />
<main class="mx-auto max-w-2xl space-y-8 px-5 py-10">
	<header class="space-y-2">
		<a class="text-sm underline" href="/">Back to dashboard</a>
		<h1 class="text-2xl font-semibold">Widgets</h1>
		<p class="text-muted-foreground">
			Your phone shows saved card balances and reward details. Updates reflect each account’s source
			date.
		</p>
	</header>
	{#if error}<p role="alert" class="text-destructive">{error}</p>{/if}
	{#if notice}<p role="status">{notice}</p>{/if}
	{#if candidate}
		<section class="space-y-4 rounded-lg border p-5">
			<h2 class="text-lg font-semibold">Connect a device</h2>
			<p>
				Approve only a request you just started {candidate.kind === 'host'
					? 'with networth-host enroll. Compare this code with its terminal'
					: 'in the Networth app. Compare this code with your phone'}:
				<strong class="font-mono">{candidate.hash.slice(0, 8).toUpperCase()}</strong>
			</p>
			<label class="grid gap-2"
				>Device name<input
					class="rounded-md border bg-background p-2"
					maxlength="100"
					readonly
					bind:value={label}
				/></label
			>
			<p class="text-sm text-muted-foreground">
				{candidate.kind === 'host'
					? 'This computer can pick up finance reviews you start from the dashboard and report their progress. It cannot read balances, edit finances, make payments, or redeem rewards.'
					: 'This device can read widget snapshots. It cannot edit finances, make payments, redeem rewards, or start collection.'}
			</p>
			<button
				class="rounded-md bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50"
				disabled={busy || !staged || !label.trim()}
				onclick={approve}>{busy ? 'Connecting…' : 'Approve device'}</button
			>
		</section>
	{:else}<p class="text-muted-foreground">
			To connect a new device, start in the Networth iPhone app and open its approval page.
		</p>{/if}
	<section class="space-y-4">
		<h2 class="text-lg font-semibold">Devices</h2>
		{#each devices as device (device.id)}
			<div class="flex items-center justify-between gap-4 border-b py-3">
				<div>
					<p class="font-medium">{device.label}</p>
					<p class="text-sm text-muted-foreground">
						{device.kind === 'host' ? 'Finance host' : 'Widgets'} ·
						<span class="capitalize">{device.state}</span>
					</p>
				</div>
				{#if device.state === 'active' || device.state === 'pending'}<button
						class="rounded-md border px-3 py-2 disabled:opacity-50"
						disabled={busy}
						onclick={() => revoke(device.id)}>Revoke</button
					>{/if}
			</div>
		{:else}<p class="text-sm text-muted-foreground">No enrolled devices.</p>{/each}
	</section>
</main>
