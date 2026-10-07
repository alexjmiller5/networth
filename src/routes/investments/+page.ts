import { readDashboard } from '$lib/offline';
import type { Investments } from '$lib/finance/investments';
import type { PageLoad } from './$types';
export const load: PageLoad = async ({ fetch }) => {
	try {
		const result = await readDashboard<Investments>('/api/investments', fetch);
		return { ...result.data, savedAt: result.savedAt, unavailable: false };
	} catch {
		return { instruments: [], savedAt: null, unavailable: true };
	}
};
