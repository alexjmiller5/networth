import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { estateSource, readEstate } from '$lib/server/estate';
import { LEGACY, loadRewards } from '$lib/server/rewards';
import { assembleRewards } from '$lib/finance/rewards';
import type { Estate } from '$lib/finance/assemble';
import { GET as financeGET } from '../finance/+server';
export const GET: RequestHandler = async (event) => {
	const source = estateSource(event);
	if (!source) throw error(503, 'Rewards are not configured yet.');
	const headers = { 'cache-control': 'private, no-store' };
	const today = new Date().toISOString().slice(0, 10);
	try {
		return json(
			await loadRewards({
				source,
				db: event.platform?.env.MARKERS_DB,
				today,
				estate: async () => (await financeGET(event)).json() as Promise<Estate>
			}),
			{ headers }
		);
	} catch {
		// Historical untyped observations remain readable while typed source publication is unavailable.
		// The fallback uses only the same dedicated reader and never infers program/component identity.
		try {
			const { rows } = await readEstate(source, ['points_balances'], {
				columns: { points_balances: LEGACY }
			});
			return json(
				{
					...assembleRewards([], [], [], rows.points_balances, { complete: false, today }),
					typedUnavailable: true,
					valuesUnavailable: true,
					today
				},
				{ headers }
			);
		} catch {
			throw error(502, 'Rewards could not be loaded. Try refreshing.');
		}
	}
};
