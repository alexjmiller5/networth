import { json, type RequestHandler } from '@sveltejs/kit';
import { readRewardValues, type RewardValue } from '$lib/server/rewards';

// Owner-entered dollars per native unit. Networth's own store; never a provider fact or Life Data.
const headers = { 'cache-control': 'private, no-store' };
const failure = (status: number, error: string) => json({ error }, { status, headers });
const unavailable = () => failure(503, 'Program values are unavailable. Try again later.');
const columns = 'program_id, value_per_unit, revision';
const DECIMAL = /^(0|[1-9]\d{0,11})(\.\d{0,11}[1-9])?$/;

export const GET: RequestHandler = async ({ platform }) => {
	const { values, unavailable: missing } = await readRewardValues(platform?.env.MARKERS_DB);
	return missing ? unavailable() : json({ values }, { headers });
};

export const PUT: RequestHandler = async ({ platform, request, url }) => {
	if (request.headers.get('origin') !== url.origin)
		return failure(403, 'This request must come from the dashboard.');
	if (request.headers.get('content-type')?.split(';')[0] !== 'application/json')
		return failure(415, 'Use JSON.');
	const text = await request.text();
	if (text.length > 1024) return failure(413, 'Request is too large.');
	let body: Record<string, unknown>;
	try {
		body = JSON.parse(text);
	} catch {
		return failure(400, 'Invalid JSON.');
	}
	const { program_id, value_per_unit, revision, ...rest } = body ?? {};
	if (
		Object.keys(rest).length ||
		typeof program_id !== 'string' ||
		!program_id.length ||
		program_id.length > 200 ||
		(value_per_unit !== null &&
			(typeof value_per_unit !== 'string' || !DECIMAL.test(value_per_unit))) ||
		(revision !== null && (!Number.isSafeInteger(revision) || (revision as number) < 1))
	)
		return failure(
			400,
			'Provide a program, a nonnegative decimal value (or null) and its revision.'
		);
	const db = platform?.env.MARKERS_DB;
	if (!db) return unavailable();
	const conflict = () =>
		failure(409, 'This value changed on another device. Reload rewards before saving again.');
	try {
		if (value_per_unit === null) {
			const { meta } = await db
				.prepare('DELETE FROM reward_values WHERE program_id = ? AND revision = ?')
				.bind(program_id, revision as number)
				.run();
			return meta.changes ? new Response(null, { status: 204, headers }) : conflict();
		}
		const row =
			revision === null
				? await db
						.prepare(
							`INSERT INTO reward_values (program_id, value_per_unit) VALUES (?, ?) ON CONFLICT(program_id) DO NOTHING RETURNING ${columns}`
						)
						.bind(program_id, value_per_unit)
						.first<RewardValue>()
				: await db
						.prepare(
							`UPDATE reward_values SET value_per_unit = ?, revision = revision + 1 WHERE program_id = ? AND revision = ? RETURNING ${columns}`
						)
						.bind(value_per_unit, program_id, revision as number)
						.first<RewardValue>();
		return row ? json(row, { headers }) : conflict();
	} catch {
		return unavailable();
	}
};
