import { json, type RequestHandler } from '@sveltejs/kit';
import { parseMarker, type Marker } from '$lib/finance/markers';

const headers = { 'cache-control': 'private, no-store' };
const failure = (status: number, error: string) => json({ error }, { status, headers });
const unavailable = () => failure(503, 'Markers are unavailable. Try again later.');
const columns = 'id, date, end, title, revision';
const identity = (body: Record<string, unknown>) => {
	if (
		typeof body.id !== 'string' ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.id) ||
		!Number.isSafeInteger(body.revision) ||
		Number(body.revision) < 1 ||
		Number(body.revision) >= Number.MAX_SAFE_INTEGER
	)
		throw new Error('Provide a valid marker id and revision.');
	return { id: body.id, revision: body.revision as number };
};

export const GET: RequestHandler = async ({ platform }) => {
	const db = platform?.env.MARKERS_DB;
	if (!db) return unavailable();
	try {
		const { results } = await db
			.prepare(`SELECT ${columns} FROM markers ORDER BY date, title, id`)
			.all<Marker>();
		return json({ markers: results }, { headers });
	} catch {
		return unavailable();
	}
};

const mutate: RequestHandler = async ({ platform, request, url }) => {
	if (request.headers.get('origin') !== url.origin)
		return failure(403, 'This request must come from the dashboard.');
	if (request.headers.get('content-type')?.split(';')[0] !== 'application/json')
		return failure(415, 'Use JSON.');
	const text = await request.text();
	if (new TextEncoder().encode(text).length > 8192)
		return failure(413, 'Marker request is too large.');
	let body: Record<string, unknown>;
	let marker: ReturnType<typeof parseMarker> | undefined;
	let key: ReturnType<typeof identity> | undefined;
	try {
		body = JSON.parse(text);
		if (!body || typeof body !== 'object' || Array.isArray(body))
			throw new Error('Invalid marker request.');
		if (request.method === 'POST') {
			key = identity({ id: body.id, revision: 1 });
			const { id: _id, ...fields } = body;
			marker = parseMarker(fields);
		} else {
			key = identity(body);
			const { id: _id, revision: _revision, ...fields } = body;
			if (request.method === 'PUT') marker = parseMarker(fields);
			else if (Object.keys(fields).length) throw new Error('Unexpected marker field.');
		}
	} catch (e) {
		return failure(400, e instanceof SyntaxError ? 'Invalid JSON.' : (e as Error).message);
	}
	const db = platform?.env.MARKERS_DB;
	if (!db) return unavailable();
	try {
		if (request.method === 'POST') {
			const row = await db
				.prepare(
					`INSERT INTO markers (id, date, end, title) SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM deleted_marker_ids WHERE id = ?) ON CONFLICT(id) DO NOTHING RETURNING ${columns}`
				)
				.bind(key!.id, marker!.date, marker!.end, marker!.title, key!.id)
				.first<Marker>();
			if (row) return json(row, { status: 201, headers });
			const existing = await db
				.prepare(`SELECT ${columns} FROM markers WHERE id = ?`)
				.bind(key!.id)
				.first<Marker>();
			return existing &&
				existing.date === marker!.date &&
				existing.end === marker!.end &&
				existing.title === marker!.title
				? json(existing, { headers })
				: failure(
						409,
						'This draft was already saved with different content or deleted. Reload markers or start a new draft.'
					);
		}
		if (request.method === 'PUT') {
			const row = await db
				.prepare(
					`UPDATE markers SET date = ?, end = ?, title = ?, revision = revision + 1 WHERE id = ? AND revision = ? RETURNING ${columns}`
				)
				.bind(marker!.date, marker!.end, marker!.title, key!.id, key!.revision)
				.first<Marker>();
			return row
				? json(row, { headers })
				: failure(409, 'This marker changed or was deleted. Reload markers before trying again.');
		}
		const { meta } = await db
			.prepare('DELETE FROM markers WHERE id = ? AND revision = ?')
			.bind(key!.id, key!.revision)
			.run();
		return meta.changes
			? new Response(null, { status: 204, headers })
			: failure(409, 'This marker changed or was deleted. Reload markers before trying again.');
	} catch {
		return unavailable();
	}
};
export const POST = mutate;
export const PUT = mutate;
export const DELETE = mutate;
