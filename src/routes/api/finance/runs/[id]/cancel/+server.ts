import { json, type RequestHandler } from '@sveltejs/kit';
import { validRunId } from '$lib/finance/run-contract';
import { FinanceRuns, runsDatabase } from '$lib/server/finance-runs';
import {
	widgetFailure as fail,
	widgetHeaders as headers,
	widgetOwner
} from '$lib/server/widget-http';

export const POST: RequestHandler = async ({ platform, request, url, params }) => {
	if (!widgetOwner(request) || request.headers.get('origin') !== url.origin)
		return fail(403, 'Cancel finance runs from the dashboard.');
	if (!validRunId(params.id)) return fail(404, 'Run not found.');
	const db = runsDatabase(platform);
	if (!db) return fail(503, 'Finance runs are not configured.');
	try {
		const run = await new FinanceRuns(db).cancel(params.id, Date.now());
		return run ? json({ run }, { headers }) : fail(409, 'This run already finished.');
	} catch {
		return fail(503, 'The run could not be canceled. Try again.');
	}
};
