import { json, type RequestHandler } from '@sveltejs/kit';
import { WidgetDevices } from '$lib/server/widget-devices';
import {
	widgetDatabase,
	widgetFailure as fail,
	widgetHeaders as headers
} from '$lib/server/widget-http';
import { widgetBalances, widgetRewards, type WidgetRewards } from '$lib/finance/widget-snapshot';
import { env as privateEnv } from '$env/dynamic/private';
import { loadRewards } from '$lib/server/rewards';
import type { Estate } from '$lib/finance/assemble';
import { GET as financeGET } from '../../finance/+server';
// Only this narrow path may bypass Access. No generic proxy or financial mutation.
const handle: RequestHandler = async (event) => {
	const path = event.params.path ?? '';
	if (!['session', 'snapshot'].includes(path)) return fail(404, 'Not found.');
	if (event.request.method !== 'GET' && !(path === 'session' && event.request.method === 'DELETE'))
		return fail(405, 'Method not allowed.');
	const db = widgetDatabase(event.platform);
	if (!db) return fail(503, 'Widgets are not configured.');
	const token = /^Bearer (nw_[0-9a-f]{64})$/.exec(
		event.request.headers.get('authorization') ?? ''
	)?.[1];
	if (!token) return fail(401, 'Enroll this device in Networth.');
	try {
		const store = new WidgetDevices(db),
			device = await store.authenticate(token, Date.now());
		if (!device) return fail(401, 'Enroll this device in Networth.');
		if (path === 'session') {
			if (event.request.method === 'DELETE') {
				await store.revoke(device.id, Date.now());
				return new Response(null, { status: 204, headers });
			}
			return json(
				{
					id: device.id,
					state: device.state,
					expiresAt: device.expires_at,
					scope: device.kind === 'host' ? 'finance-host' : 'widgets:read'
				},
				{ headers }
			);
		}
		if (device.state !== 'active' || device.kind !== 'widget')
			return fail(403, 'Device approval is required or has expired or been revoked.');
		const fetchedAt = new Date().toISOString(),
			today = fetchedAt.slice(0, 10);
		const loading = financeGET(event, true).then(async (response) =>
			response.ok ? ((await response.json()) as Estate) : null
		);
		const rewards = readWidgetRewards(event, today, loading);
		const estate = await loading;
		if (!estate) return fail(502, 'The latest snapshot is unavailable.');
		const balances = widgetBalances(estate.accounts, estate.txns, estate.coverage, today);
		const extra = await rewards;
		// Revocation while a slow source read is in flight must suppress delivery too.
		if ((await store.authenticate(token, Date.now()))?.state !== 'active')
			return fail(403, 'Device access was revoked.');
		// Reward sections are optional within version 1; older apps ignore them.
		return json(
			{ version: 1, fetchedAt, balances, ...(extra ?? { rewardsUnavailable: true }) },
			{ headers }
		);
	} catch {
		return fail(502, 'The latest snapshot is unavailable. Your saved snapshot is unchanged.');
	}
};
/** Reward views degrade independently: a failed rewards read never withholds balances. */
async function readWidgetRewards(
	event: Parameters<RequestHandler>[0],
	today: string,
	estate: Promise<Estate | null>
): Promise<WidgetRewards | null> {
	const env = { ...privateEnv, ...event.platform?.env } as {
		LIFE_HUB_URL?: string;
		LIFE_HUB_TOKEN?: string;
	};
	const hub = env.LIFE_HUB_URL?.replace(/\/$/, '');
	if (!hub || !env.LIFE_HUB_TOKEN) return null;
	try {
		const rewards = await loadRewards({
			hub,
			token: env.LIFE_HUB_TOKEN,
			fetch: event.fetch,
			db: event.platform?.env.MARKERS_DB,
			today,
			estate: async () => (await estate) ?? Promise.reject(new Error('Ledger unavailable'))
		});
		const ledger = await estate;
		return ledger
			? widgetRewards(
					rewards,
					ledger.accounts,
					ledger.txns,
					today,
					!(ledger as Estate & { categoriesUnavailable?: boolean }).categoriesUnavailable
				)
			: null;
	} catch {
		return null;
	}
}
export const GET = handle;
export const DELETE = handle;
export const POST = handle;
export const fallback = handle;
