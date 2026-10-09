import { json, type RequestHandler } from '@sveltejs/kit';
import { FinanceRuns, runsDatabase } from '$lib/server/finance-runs';
import {
	hostDevice,
	widgetBody,
	widgetFailure as fail,
	widgetHeaders as headers
} from '$lib/server/widget-http';

// Bypasses browser Access; only an approved host device gets past hostDevice().
const POLL_MS = 2000;

export const POST: RequestHandler = async ({ platform, request }) => {
	const first = await hostDevice(platform, request);
	if (first instanceof Response) return first;
	const body = await widgetBody(request);
	const wait = body?.wait_seconds ?? 0;
	if (
		!body ||
		Object.keys(body).some((k) => k !== 'wait_seconds') ||
		!Number.isInteger(wait) ||
		(wait as number) < 0 ||
		(wait as number) > 25
	)
		return fail(400, 'Invalid claim request.');
	const db = runsDatabase(platform);
	if (!db) return fail(503, 'Finance runs are not configured.');
	const store = new FinanceRuns(db),
		deadline = Date.now() + (wait as number) * 1000;
	try {
		for (let host = first; ;) {
			const run = await store.claim(host.id, Date.now());
			if (run || Date.now() >= deadline) return json({ run }, { headers });
			await new Promise((resolve) => setTimeout(resolve, POLL_MS));
			// Revocation during the hold takes effect before the next claim.
			const again = await hostDevice(platform, request);
			if (again instanceof Response) return again;
			host = again;
		}
	} catch {
		return fail(503, 'Finance runs are unavailable.');
	}
};
