import { readDashboard } from '$lib/offline';
import type { Rewards } from '$lib/finance/rewards';
import type { PageLoad } from './$types';
export const load: PageLoad = async ({ fetch }) => {
	try {
		const result = await readDashboard<Rewards & { typedUnavailable: boolean }>(
			'/api/rewards',
			fetch
		);
		return { ...result.data, savedAt: result.savedAt, unavailable: false };
	} catch {
		return {
			programs: [],
			legacyBalances: [],
			typedUnavailable: true,
			savedAt: null,
			unavailable: true
		};
	}
};
