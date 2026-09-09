// The one data door: pull the finance tables from the life-data hub with a
// read-only token and hand the browser the assembled estate. Cloudflare
// Access in front of the site is the auth; the hub token never leaves the
// Worker. LIFE_HUB_URL is a var (wrangler.jsonc), LIFE_HUB_TOKEN a secret.
import { json, error } from '@sveltejs/kit';
import { env as privateEnv } from '$env/dynamic/private';
import type { RequestHandler } from './$types';
import { assemble, type HubRow } from '$lib/finance/assemble';
import { categoryIconUrl } from '$lib/server/categoryIcons';

const TXN_COLUMNS = [
	'id',
	'account_id',
	'date',
	'amount',
	'status',
	'synthetic',
	'qty',
	'ticker',
	'deleted_at'
];
const TABLES: Record<string, string[]> = {
	accounts: ['id', 'bank', 'name', 'type', 'source', 'currency', 'deleted_at'],
	overlay: ['source', 'source_id', 'category', 'internal', 'excluded', 'deleted_at'],
	shares: ['id', 'source', 'source_id', 'date', 'amount', 'category', 'deleted_at'],
	points: ['program', 'points', 'est_value', 'scraped_at', 'deleted_at'],
	categories: ['id', 'name', 'kind', 'icon', 'sort', 'deleted_at'],
	scrape_runs: [
		'id',
		'source',
		'finished_at',
		'status',
		'reconciled',
		'stated_balances',
		'deleted_at'
	],
	venmo_statement_lines: [
		'id',
		'txn_id',
		'datetime',
		'period',
		'type',
		'amount',
		'funding_source',
		'destination',
		'deleted_at'
	]
};

async function pull(
	hub: string,
	token: string,
	table: string,
	columns: string[],
	fetchFn: typeof fetch
): Promise<HubRow[]> {
	const res = await fetchFn(`${hub}/v1/rows/pull`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
		body: JSON.stringify({ table, columns, since: '' }),
		signal: AbortSignal.timeout(20_000),
		// Workers supports manual/follow only. Reject 3xx below, keeping the
		// credential on this exact configured destination.
		redirect: 'manual'
	});
	if (!res.ok) {
		console.error('Finance hub request failed', { table, status: res.status });
		throw new Error('Hub request failed');
	}
	const body: unknown = await res.json();
	if (
		!body ||
		typeof body !== 'object' ||
		!('rows' in body) ||
		!Array.isArray(body.rows) ||
		body.rows.some((row: unknown) => !row || typeof row !== 'object' || Array.isArray(row))
	) {
		throw new Error('Invalid hub response');
	}
	return body.rows as HubRow[];
}

export const GET: RequestHandler = async ({ platform, fetch }) => {
	const env = { ...privateEnv, ...platform?.env } as {
		LIFE_HUB_URL?: string;
		LIFE_HUB_TOKEN?: string;
	};
	const hub = env.LIFE_HUB_URL?.replace(/\/$/, '');
	const token = env.LIFE_HUB_TOKEN;
	if (!hub || !token) throw error(503, 'Finance data is not configured yet.');

	try {
		const [accounts, overlay, shares, points, categories, scrape_runs, venmo_statement_lines] =
			await Promise.all(
				Object.entries(TABLES).map(([t, cols]) =>
					pull(hub, token, t === 'points' ? 'points_balances' : t, cols, fetch)
				)
			);
		const sources = [...new Set(accounts.filter((a) => a.deleted_at == null).map((a) => a.source))];
		if (sources.some((s) => typeof s !== 'string' || !/^[a-z][a-z0-9_]*$/.test(s)))
			throw new Error('Invalid source');
		const txnRows = await Promise.all(
			sources.map((s) => pull(hub, token, `txns_${s}`, TXN_COLUMNS, fetch))
		);
		const txns = Object.fromEntries(sources.map((s, i) => [s, txnRows[i]]));
		const estate = assemble({
			accounts,
			overlay,
			shares,
			points,
			categories,
			scrape_runs,
			venmo_statement_lines,
			txns
		});
		return json(
			{
				...estate,
				categories: estate.categories.map((category) => ({
					...category,
					iconUrl: categoryIconUrl(category.icon)
				}))
			},
			{
				headers: { 'cache-control': 'private, no-store' }
			}
		);
	} catch (cause) {
		console.error(
			'Finance data load failed',
			cause instanceof Error
				? {
						type: cause.name,
						at: cause.stack?.split('\n').slice(1, 3)
					}
				: { type: 'Unknown' }
		);
		// Provider bodies and raw validation details can contain private data.
		throw error(502, 'Finance data could not be loaded. Try refreshing.');
	}
};
