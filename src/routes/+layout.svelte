<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { replaceState } from '$app/navigation';
	onMount(async () => {
		document.getElementById('dashboard-loading')?.remove();
		await tick();
		const url = new URL(location.href);
		if (url.searchParams.has('online')) {
			url.searchParams.delete('online');
			replaceState(url, {});
		}
	});
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';

	let { children } = $props();
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>
{@render children()}
