import { json, error } from '@sveltejs/kit';
import { env as privateEnv } from '$env/dynamic/private';
import type { RequestHandler } from './$types';
import { pullNativeTable } from '$lib/server/native-finance';
import { assembleRewards } from '$lib/finance/rewards';
const LEGACY = ['id', 'program', 'points', 'scraped_at', 'deleted_at'];
const TABLES = {
	reward_programs: ['id', 'label', 'provider', 'account_id', 'deleted_at'],
	reward_components: [
		'id',
		'program_id',
		'component_key',
		'label',
		'unit',
		'role',
		'currency',
		'deleted_at'
	],
	reward_events: [
		'id',
		'component_id',
		'event_key',
		'kind',
		'state',
		'event_date',
		'occurred_at',
		'posted_date',
		'units_delta',
		'observed_at',
		'supersedes_id',
		'deleted_at'
	],
	points_balances: [
		...LEGACY,
		'component_id',
		'exact_amount',
		'basis',
		'source_as_of',
		'source_date',
		'period_start',
		'period_end_exclusive',
		'supersedes_id'
	]
};
export const GET: RequestHandler = async ({ platform, fetch }) => {
	const env = { ...privateEnv, ...platform?.env } as {
		LIFE_HUB_URL?: string;
		LIFE_HUB_TOKEN?: string;
	};
	const hub = env.LIFE_HUB_URL?.replace(/\/$/, ''),
		token = env.LIFE_HUB_TOKEN;
	if (!hub || !token) throw error(503, 'Rewards are not configured yet.');
	const headers = { 'cache-control': 'private, no-store' };
	try {
		const [programs, components, events, balances] = await Promise.all(
			Object.entries(TABLES).map(([table, columns]) =>
				pullNativeTable(hub, token, table, columns, fetch)
			)
		);
		return json(
			{
				...assembleRewards(programs.rows, components.rows, events.rows, balances.rows, {
					complete: [programs, components, events, balances].every((r) => r.complete)
				}),
				typedUnavailable: false
			},
			{ headers }
		);
	} catch {
		// Historical untyped observations remain readable while typed source publication is unavailable.
		// The fallback uses only the same dedicated reader and never infers program/component identity.
		try {
			const legacy = await pullNativeTable(hub, token, 'points_balances', LEGACY, fetch);
			return json(
				{
					...assembleRewards([], [], [], legacy.rows, { complete: false }),
					typedUnavailable: true
				},
				{ headers }
			);
		} catch {
			throw error(502, 'Rewards could not be loaded. Try refreshing.');
		}
	}
};
