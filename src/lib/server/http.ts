import { json } from '@sveltejs/kit';
import { Hosts, type Host } from './hosts';
export const privateHeaders = { 'cache-control': 'private, no-store' };
export const failure = (status: number, error: string) =>
	json({ error }, { status, headers: privateHeaders });
/** Access protects this route at the edge; presence is defense in depth, not JWT verification. */
export function accessOwner(request: Request): boolean {
	return Boolean(request.headers.get('Cf-Access-Jwt-Assertion')?.trim());
}
export function hostsDatabase(platform: App.Platform | undefined): D1Database | undefined {
	return (platform?.env as (Env & { HOSTS_DB?: D1Database }) | undefined)?.HOSTS_DB;
}
export async function jsonBody(
	request: Request,
	limit = 2048
): Promise<Record<string, unknown> | null> {
	if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') return null;
	const reader = request.body?.getReader();
	if (!reader) return null;
	const decoder = new TextDecoder('utf-8', { fatal: true });
	let size = 0,
		text = '';
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > limit) {
				await reader.cancel();
				return null;
			}
			text += decoder.decode(value, { stream: true });
		}
		text += decoder.decode();
		const body: unknown = JSON.parse(text);
		return body && typeof body === 'object' && !Array.isArray(body)
			? (body as Record<string, unknown>)
			: null;
	} catch {
		return null;
	} finally {
		reader.releaseLock();
	}
}

/** The enrolled host behind a bearer credential, in any state; anyone else gets the failure. */
export async function bearerHost(
	platform: App.Platform | undefined,
	request: Request
): Promise<Host | Response> {
	const db = hostsDatabase(platform);
	if (!db) return failure(503, 'Hosts are not configured.');
	const token = /^Bearer (nw_[0-9a-f]{64})$/.exec(request.headers.get('authorization') ?? '')?.[1];
	const host = token ? await new Hosts(db).authenticate(token, Date.now()) : null;
	return host ?? failure(401, 'Enroll this host in Networth.');
}

/** Bearer auth for an approved finance host; any other caller gets the failure response. */
export async function activeHost(
	platform: App.Platform | undefined,
	request: Request
): Promise<Host | Response> {
	const host = await bearerHost(platform, request);
	if (host instanceof Response || host.state === 'active') return host;
	return failure(403, 'Host approval is required or has expired or been revoked.');
}
