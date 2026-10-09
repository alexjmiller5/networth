import { json } from '@sveltejs/kit';
import { WidgetDevices, type WidgetDevice } from './widget-devices';
export const widgetHeaders = { 'cache-control': 'private, no-store' };
export const widgetFailure = (status: number, error: string) =>
	json({ error }, { status, headers: widgetHeaders });
/** Access protects this route at the edge; presence is defense in depth, not JWT verification. */
export function widgetOwner(request: Request): boolean {
	return Boolean(request.headers.get('Cf-Access-Jwt-Assertion')?.trim());
}
export function widgetDatabase(platform: App.Platform | undefined): D1Database | undefined {
	return (platform?.env as (Env & { WIDGETS_DB?: D1Database }) | undefined)?.WIDGETS_DB;
}
export async function widgetBody(
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

/** Bearer auth for an approved finance host device; any other caller gets the failure response. */
export async function hostDevice(
	platform: App.Platform | undefined,
	request: Request
): Promise<WidgetDevice | Response> {
	const db = widgetDatabase(platform);
	if (!db) return widgetFailure(503, 'Hosts are not configured.');
	const token = /^Bearer (nw_[0-9a-f]{64})$/.exec(request.headers.get('authorization') ?? '')?.[1];
	const device = token ? await new WidgetDevices(db).authenticate(token, Date.now()) : null;
	if (!device) return widgetFailure(401, 'Enroll this host in Networth.');
	if (device.kind !== 'host' || device.state !== 'active')
		return widgetFailure(403, 'Host approval is required or has expired or been revoked.');
	return device;
}
