import { error } from '@sveltejs/kit';
import { readDashboard } from '$lib/offline';
import type { PageLoad } from './$types';
import type { Benefits } from '$lib/finance/benefits';
export const load: PageLoad = async ({ fetch }) => {
	try {
		const result = await readDashboard<Benefits>('/api/benefits', fetch);
		return { ...result.data, savedAt: result.savedAt };
	} catch {
		throw error(503, 'Benefits could not be loaded. Check your connection and reload.');
	}
};
