import { json, type RequestHandler } from '@sveltejs/kit';
import { parseAccountIds } from '$lib/finance/run-contract';
import {
	FinanceRuns,
	RunBusyError,
	RunConflictError,
	runsDatabase
} from '$lib/server/finance-runs';
import {
	widgetBody,
	widgetFailure as fail,
	widgetHeaders as headers,
	widgetOwner
} from '$lib/server/widget-http';

export const GET: RequestHandler = async ({ platform, request }) => {
	if (!widgetOwner(request)) return fail(403, 'Open finance runs from the dashboard.');
	const db = runsDatabase(platform);
	if (!db) return fail(503, 'Finance runs are not configured.');
	try {
		return json({ runs: await new FinanceRuns(db).list(10) }, { headers });
	} catch {
		return fail(503, 'Finance runs are unavailable.');
	}
};

export const POST: RequestHandler = async ({ platform, request, url }) => {
	if (!widgetOwner(request) || request.headers.get('origin') !== url.origin)
		return fail(403, 'Start finance runs from the dashboard.');
	const body = await widgetBody(request, 8192);
	const accountIds = parseAccountIds(body?.account_ids);
	if (
		!body ||
		Object.keys(body).some((k) => k !== 'request_id' && k !== 'account_ids') ||
		typeof body.request_id !== 'string' ||
		!/^[A-Za-z0-9-]{8,64}$/.test(body.request_id) ||
		!accountIds
	)
		return fail(400, 'Choose at least one account.');
	const db = runsDatabase(platform);
	if (!db) return fail(503, 'Finance runs are not configured.');
	try {
		const run = await new FinanceRuns(db).create(
			{ requestId: body.request_id, accountIds },
			Date.now()
		);
		return json({ run }, { status: 201, headers });
	} catch (error) {
		if (error instanceof RunBusyError)
			return json(
				{
					error: `A finance review is already ${error.active.status}. Cancel it or wait for it to finish.`,
					run: error.active
				},
				{ status: 409, headers }
			);
		if (error instanceof RunConflictError)
			return fail(409, 'That request was already used for other accounts. Try again.');
		return fail(503, 'The run could not be saved. Try again.');
	}
};
