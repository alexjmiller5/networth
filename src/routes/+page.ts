import { error } from '@sveltejs/kit';
import { readDashboard } from '$lib/offline';
import type { PageLoad } from './$types';
import type { Estate } from '$lib/finance/assemble';

// Client-only page (layout sets ssr=false): the estate comes from the
// Worker's /api/finance, which is the only thing that talks to the hub.
export const load: PageLoad = async ({ fetch, depends }) => {
	depends('finance:data');
	try {
		const result = await readDashboard<Estate>('/api/finance', fetch);
		return { ...result.data, savedAt: result.savedAt };
	} catch (failure) {
		throw error(
			503,
			failure instanceof Error ? failure.message : 'Check your connection and try again.'
		);
	}
};
