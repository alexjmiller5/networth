import { json, type RequestHandler } from '@sveltejs/kit';
import { WidgetDevices, validWidgetId } from '$lib/server/widget-devices';
import {
	widgetBody,
	widgetDatabase,
	widgetFailure as fail,
	widgetHeaders as headers,
	widgetOwner
} from '$lib/server/widget-http';
export const GET: RequestHandler = async ({ platform, request }) => {
	if (!widgetOwner(request)) return fail(403, 'Open device settings from the dashboard.');
	const db = widgetDatabase(platform);
	if (!db) return fail(503, 'Widgets are not configured.');
	try {
		return json({ devices: await new WidgetDevices(db).list(Date.now()) }, { headers });
	} catch {
		return fail(503, 'Device settings are unavailable.');
	}
};
const mutate: RequestHandler = async ({ platform, request, url }) => {
	if (!widgetOwner(request) || request.headers.get('origin') !== url.origin)
		return fail(403, 'Use the dashboard to manage devices.');
	const body = await widgetBody(request);
	if (!body) return fail(400, 'Invalid device request.');
	const stage = request.method === 'POST' && body.action === 'stage';
	const keys = stage
		? ['action', 'id', 'hash', 'label']
		: request.method === 'DELETE'
			? ['id']
			: ['action', 'id'];
	if (
		Object.keys(body).some((k) => !keys.includes(k)) ||
		!validWidgetId(body.id) ||
		(!stage && request.method !== 'DELETE' && body.action !== 'approve')
	)
		return fail(400, 'Invalid device request.');
	if (
		stage &&
		(typeof body.hash !== 'string' ||
			!/^[0-9a-f]{64}$/.test(body.hash) ||
			typeof body.label !== 'string' ||
			!body.label.trim() ||
			body.label.trim().length > 100 ||
			/[\u0000-\u001f\u007f]/.test(body.label))
	)
		return fail(400, 'Invalid device request.');
	const db = widgetDatabase(platform);
	if (!db) return fail(503, 'Widgets are not configured.');
	const store = new WidgetDevices(db);
	try {
		if (stage) {
			const device = await store.stage(
				{ id: body.id, hash: body.hash as string, label: body.label as string },
				Date.now()
			);
			return json(device, { status: 201, headers });
		}
		const ok =
			request.method === 'DELETE'
				? await store.revoke(body.id, Date.now())
				: await store.approve(body.id, Date.now());
		if (!ok)
			return fail(
				409,
				'This enrollment expired, was revoked, or is missing. Start again in the app.'
			);
		return request.method === 'DELETE'
			? new Response(null, { status: 204, headers })
			: json({ approved: true }, { headers });
	} catch {
		return fail(409, 'The device request could not be saved. Refresh and try again.');
	}
};
export const POST = mutate;
export const DELETE = mutate;
