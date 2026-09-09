<script lang="ts">
	import { page } from '$app/state';
	import Seo from '$lib/components/seo.svelte';
</script>

<Seo
	title={page.status === 404 ? 'Page not found | Networth' : 'Networth unavailable'}
	description="Private financial dashboard"
/>

<main
	class="bg-background text-foreground grid min-h-svh place-content-center gap-4 px-6 text-center"
>
	<p class="text-muted-foreground text-sm font-medium">Networth</p>
	<h1 class="text-2xl font-semibold">
		{page.status === 404 ? 'Page not found' : 'Unable to load your dashboard'}
	</h1>
	<p class="text-muted-foreground">
		{page.status === 404
			? 'This page does not exist.'
			: (page.error?.message ?? 'Please try again in a moment.')}
	</p>
	<a
		href="/"
		class="text-primary text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4"
		>{page.status === 404 ? 'Back to dashboard' : 'Try again'}</a
	>
</main>
