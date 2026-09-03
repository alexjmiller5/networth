<script lang="ts">
	import { page } from '$app/state';
</script>

<svelte:head>
	<title>{page.status}</title>
</svelte:head>

<main class="grid min-h-svh place-content-center gap-4 text-center">
	<p class="text-muted-foreground text-7xl font-bold">{page.status}</p>
	<p class="text-lg">{page.error?.message ?? 'Something went wrong'}</p>
	<a href="/" class="text-primary text-sm underline underline-offset-4">Back home</a>
</main>
