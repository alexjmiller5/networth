import { json, type RequestHandler } from '@sveltejs/kit';
import { bearerHost, privateHeaders as headers } from '$lib/server/http';

// Bypasses browser Access: `networth-host enroll` polls its own state here until approved.
export const GET: RequestHandler = async ({ platform, request }) => {
	const host = await bearerHost(platform, request);
	if (host instanceof Response) return host;
	return json({ id: host.id, state: host.state, expiresAt: host.expires_at }, { headers });
};
