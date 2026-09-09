import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import type { Estate } from '$lib/finance/assemble';

// Client-only page (layout sets ssr=false): the estate comes from the
// Worker's /api/finance, which is the only thing that talks to the hub.
export const load: PageLoad = async ({ fetch, depends }) => {
	depends('finance:data');
	const res = await fetch('/api/finance');
	if (!res.ok) throw error(res.status, 'Finance data could not be loaded. Try refreshing.');
	const estate = (await res.json()) as Estate;
	return estate;
};
