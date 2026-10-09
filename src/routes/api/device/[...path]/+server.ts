import { json, type RequestHandler } from '@sveltejs/kit';
import { WidgetDevices } from '$lib/server/widget-devices';
import {
	widgetDatabase,
	widgetFailure as fail,
	widgetHeaders as headers
} from '$lib/server/widget-http';
import { widgetBalances } from '$lib/finance/widget-snapshot';
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
		const response = await financeGET(event, true);
		if (!response.ok) return fail(502, 'The latest snapshot is unavailable.');
		const estate = (await response.json()) as Estate;
		const fetchedAt = new Date().toISOString();
		const balances = widgetBalances(
			estate.accounts,
			estate.txns,
			estate.coverage,
			fetchedAt.slice(0, 10)
		);
		// Revocation while a slow source read is in flight must suppress delivery too.
		if ((await store.authenticate(token, Date.now()))?.state !== 'active')
			return fail(403, 'Device access was revoked.');
		return json({ version: 1, fetchedAt, balances }, { headers });
	} catch {
		return fail(502, 'The latest snapshot is unavailable. Your saved snapshot is unchanged.');
	}
};
export const GET = handle;
export const DELETE = handle;
export const POST = handle;
export const fallback = handle;
