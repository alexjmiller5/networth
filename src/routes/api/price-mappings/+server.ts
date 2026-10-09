import { json, type RequestHandler } from '@sveltejs/kit';
import { readMappings, type StoredMapping } from '$lib/server/prices';

// Owner-entered price sources: which provider series values each ledger security.
// Networth's own data (PRICES_DB), never source code or Soma.
const headers = { 'cache-control': 'private, no-store' };
const failure = (status: number, error: string) => json({ error }, { status, headers });
const unavailable = () => failure(503, 'Price sources are unavailable. Try again later.');
const PROVIDERS = ['tiingo', 'fidelity', 'alphavantage', 'netbenefits'];
const ID = /^[^\s\u0000-\u001f][^\u0000-\u001f]{0,99}$/;
const SYMBOL = {
	tiingo: /^[A-Za-z0-9.^_-]{1,40}$/,
	alphavantage: /^[A-Za-z0-9.^_-]{1,40}$/,
	fidelity: /^\d{1,10}$/
};
const columns = 'account_id, security_id, provider, symbol, currency, revision';

export const GET: RequestHandler = async ({ platform }) => {
	const db = platform?.env.PRICES_DB;
	if (!db) return unavailable();
	try {
		return json({ mappings: await readMappings(db) }, { headers });
	} catch {
		return unavailable();
	}
};

async function body(request: Request, url: URL) {
	if (request.headers.get('origin') !== url.origin)
		return failure(403, 'This request must come from the dashboard.');
	if (request.headers.get('content-type')?.split(';')[0] !== 'application/json')
		return failure(415, 'Use JSON.');
	const text = await request.text();
	if (text.length > 1024) return failure(413, 'Request is too large.');
	try {
		const parsed = JSON.parse(text);
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: failure(400, 'Invalid JSON.');
	} catch {
		return failure(400, 'Invalid JSON.');
	}
}
const revisionOk = (r: unknown) => r === null || (Number.isSafeInteger(r) && (r as number) >= 1);

export const PUT: RequestHandler = async ({ platform, request, url }) => {
	const input = await body(request, url);
	if (input instanceof Response) return input;
	const { account_id, security_id, provider, symbol, revision, ...rest } = input;
	const pattern = SYMBOL[provider as keyof typeof SYMBOL];
	if (
		Object.keys(rest).length ||
		typeof account_id !== 'string' ||
		!ID.test(account_id) ||
		typeof security_id !== 'string' ||
		!ID.test(security_id) ||
		!PROVIDERS.includes(provider as string) ||
		(provider === 'netbenefits'
			? symbol !== null
			: typeof symbol !== 'string' || !pattern.test(symbol)) ||
		!revisionOk(revision)
	)
		return failure(
			400,
			'Provide an account, the ledger security, a provider, its symbol (none for NetBenefits) and the revision.'
		);
	const db = platform?.env.PRICES_DB;
	if (!db) return unavailable();
	try {
		const row =
			revision === null
				? await db
						.prepare(
							`INSERT INTO price_mappings (account_id, security_id, provider, symbol) VALUES (?, ?, ?, ?)
							 ON CONFLICT DO NOTHING RETURNING ${columns}`
						)
						.bind(account_id, security_id, provider as string, symbol as string | null)
						.first<StoredMapping>()
				: await db
						.prepare(
							`UPDATE price_mappings SET provider = ?, symbol = ?, revision = revision + 1
							 WHERE account_id = ? AND security_id = ? AND revision = ? RETURNING ${columns}`
						)
						.bind(
							provider as string,
							symbol as string | null,
							account_id,
							security_id,
							revision as number
						)
						.first<StoredMapping>();
		return row
			? json(row, { headers })
			: failure(409, 'This price source changed elsewhere. Reload before saving again.');
	} catch {
		return unavailable();
	}
};

export const DELETE: RequestHandler = async ({ platform, request, url }) => {
	const input = await body(request, url);
	if (input instanceof Response) return input;
	const { account_id, security_id, revision, ...rest } = input;
	if (
		Object.keys(rest).length ||
		typeof account_id !== 'string' ||
		typeof security_id !== 'string' ||
		!Number.isSafeInteger(revision)
	)
		return failure(400, 'Provide the account, ledger security and revision.');
	const db = platform?.env.PRICES_DB;
	if (!db) return unavailable();
	try {
		const { meta } = await db
			.prepare(
				'DELETE FROM price_mappings WHERE account_id = ? AND security_id = ? AND revision = ?'
			)
			.bind(account_id, security_id, revision as number)
			.run();
		return meta.changes
			? new Response(null, { status: 204, headers })
			: failure(409, 'This price source changed elsewhere. Reload before saving again.');
	} catch {
		return unavailable();
	}
};
