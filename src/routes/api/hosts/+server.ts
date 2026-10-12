import { json, type RequestHandler } from '@sveltejs/kit';
import { Hosts, validHostId } from '$lib/server/hosts';
import {
	jsonBody,
	hostsDatabase,
	failure as fail,
	privateHeaders as headers,
	accessOwner
} from '$lib/server/http';
export const GET: RequestHandler = async ({ platform, request }) => {
	if (!accessOwner(request)) return fail(403, 'Open host settings from the dashboard.');
	const db = hostsDatabase(platform);
	if (!db) return fail(503, 'Hosts are not configured.');
	try {
		return json({ hosts: await new Hosts(db).list(Date.now()) }, { headers });
	} catch {
		return fail(503, 'Host settings are unavailable.');
	}
};
const mutate: RequestHandler = async ({ platform, request, url }) => {
	if (!accessOwner(request) || request.headers.get('origin') !== url.origin)
		return fail(403, 'Use the dashboard to manage hosts.');
	const body = await jsonBody(request);
	if (!body) return fail(400, 'Invalid host request.');
	const stage = request.method === 'POST' && body.action === 'stage';
	const keys = stage
		? ['action', 'id', 'hash', 'label']
		: request.method === 'DELETE'
			? ['id']
			: ['action', 'id'];
	if (
		Object.keys(body).some((k) => !keys.includes(k)) ||
		!validHostId(body.id) ||
		(!stage && request.method !== 'DELETE' && body.action !== 'approve')
	)
		return fail(400, 'Invalid host request.');
	if (
		stage &&
		(typeof body.hash !== 'string' ||
			!/^[0-9a-f]{64}$/.test(body.hash) ||
			typeof body.label !== 'string' ||
			!body.label.trim() ||
			body.label.trim().length > 100 ||
			/[\u0000-\u001f\u007f]/.test(body.label))
	)
		return fail(400, 'Invalid host request.');
	const db = hostsDatabase(platform);
	if (!db) return fail(503, 'Hosts are not configured.');
	const store = new Hosts(db);
	try {
		if (stage) {
			const host = await store.stage(
				{ id: body.id, hash: body.hash as string, label: body.label as string },
				Date.now()
			);
			return json(host, { status: 201, headers });
		}
		const ok =
			request.method === 'DELETE'
				? await store.revoke(body.id, Date.now())
				: await store.approve(body.id, Date.now());
		if (!ok)
			return fail(
				409,
				'This enrollment expired, was revoked, or is missing. Run networth-host enroll again.'
			);
		return request.method === 'DELETE'
			? new Response(null, { status: 204, headers })
			: json({ approved: true }, { headers });
	} catch {
		return fail(409, 'The host request could not be saved. Refresh and try again.');
	}
};
export const POST = mutate;
export const DELETE = mutate;
