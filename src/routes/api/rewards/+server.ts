import { json, error } from '@sveltejs/kit';
import { env as privateEnv } from '$env/dynamic/private';
import type { RequestHandler } from './$types';
import { pullNativeTable } from '$lib/server/native-finance';
import { LEGACY, loadRewards } from '$lib/server/rewards';
import { assembleRewards } from '$lib/finance/rewards';
import type { Estate } from '$lib/finance/assemble';
import { GET as financeGET } from '../finance/+server';
export const GET: RequestHandler = async (event) => {
	const { platform, fetch } = event;
	const env = { ...privateEnv, ...platform?.env } as {
		SOMA_HUB_URL?: string;
		SOMA_HUB_TOKEN?: string;
	};
	const hub = env.SOMA_HUB_URL?.replace(/\/$/, ''),
		token = env.SOMA_HUB_TOKEN;
	if (!hub || !token) throw error(503, 'Rewards are not configured yet.');
	const headers = { 'cache-control': 'private, no-store' };
	const today = new Date().toISOString().slice(0, 10);
	try {
		return json(
			await loadRewards({
				hub,
				token,
				fetch,
				db: platform?.env.MARKERS_DB,
				today,
				estate: async () => (await financeGET(event)).json() as Promise<Estate>
			}),
			{ headers }
		);
	} catch {
		// Historical untyped observations remain readable while typed source publication is unavailable.
		// The fallback uses only the same dedicated reader and never infers program/component identity.
		try {
			const legacy = await pullNativeTable(hub, token, 'points_balances', LEGACY, fetch);
			return json(
				{
					...assembleRewards([], [], [], legacy.rows, { complete: false, today }),
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
