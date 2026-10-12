import { json, type RequestHandler } from '@sveltejs/kit';
import { parseHostPatch, validRunId } from '$lib/finance/run-contract';
import { FinanceRuns, runsDatabase } from '$lib/server/finance-runs';
import { activeHost, jsonBody, failure as fail, privateHeaders as headers } from '$lib/server/http';

// Bypasses browser Access; a host sees and reports only runs it claimed.
export const GET: RequestHandler = async ({ platform, request, params }) => {
	const host = await activeHost(platform, request);
	if (host instanceof Response) return host;
	const db = runsDatabase(platform);
	if (!db) return fail(503, 'Finance runs are not configured.');
	if (!validRunId(params.id)) return fail(404, 'Run not found.');
	try {
		const run = await new FinanceRuns(db).get(params.id);
		return run?.host_id === host.id ? json({ run }, { headers }) : fail(404, 'Run not found.');
	} catch {
		return fail(503, 'Finance runs are unavailable.');
	}
};

export const PATCH: RequestHandler = async ({ platform, request, params }) => {
	const host = await activeHost(platform, request);
	if (host instanceof Response) return host;
	const body = await jsonBody(request);
	const patch = body && parseHostPatch(body);
	if (!patch) return fail(400, 'Invalid run report.');
	const db = runsDatabase(platform);
	if (!db) return fail(503, 'Finance runs are not configured.');
	if (!validRunId(params.id)) return fail(404, 'Run not found.');
	try {
		const run = await new FinanceRuns(db).update(params.id, host.id, patch, Date.now());
		return run ? json({ run }, { headers }) : fail(409, 'This run is not active for this host.');
	} catch {
		return fail(503, 'The report could not be saved. Try again.');
	}
};
