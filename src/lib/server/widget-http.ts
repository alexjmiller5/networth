import { json } from '@sveltejs/kit';
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
export async function widgetBody(request: Request): Promise<Record<string, unknown> | null> {
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
			if (size > 2048) {
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
