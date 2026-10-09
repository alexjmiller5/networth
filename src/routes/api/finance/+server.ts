// The one data door: pull the finance tables from the soma hub with a
// read-only token and hand the browser the assembled estate. Cloudflare
// Access in front of the site is the auth; the hub token never leaves the
// Worker. SOMA_HUB_URL is a var (wrangler.jsonc), SOMA_HUB_TOKEN a secret.
import { json, error } from '@sveltejs/kit';
import { env as privateEnv } from '$env/dynamic/private';
import type { RequestHandler } from '@sveltejs/kit';
import { assemble, type EstateTables, type HubRow } from '$lib/finance/assemble';
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
	accounts: [
		'id',
		'bank',
		'name',
		'type',
		'source',
		'currency',
		'closed',
		'is_closed',
		'name_history',
		'logo',
		'deleted_at'
	],
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
	],
	assets: ['id', 'kind', 'name', 'currency', 'deleted_at'],
	asset_events: [
		'id',
		'asset_id',
		'kind',
		'date',
		'amount',
		'source',
		'source_id',
		'share_id',
		'deleted_at'
	],
	asset_evidence: ['to_ref', 'from_kind', 'from_ref', 'deleted_at']
};
// Tables read under another hub name, optionally as an indexed equality slice.
const HUB_TABLE: Record<string, { table: string; where?: Record<string, string> }> = {
	points: { table: 'points_balances' },
	asset_evidence: { table: 'provenance', where: { to_kind: 'asset_events', rel: 'evidence_of' } }
};

async function pull(
	hub: string,
	token: string,
	table: string,
	columns: string[],
	fetchFn: typeof fetch,
	where?: Record<string, string>
): Promise<HubRow[]> {
	const rows: HubRow[] = [];
	let after = '';
	const signal = AbortSignal.timeout(20_000);
	while (true) {
		const res = await fetchFn(`${hub}/v1/rows/pull`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			// The hub's supported complete-table read avoids serial round trips on cold loads.
			// Continue with bounded pages only when the hub actually returns a cursor.
			body: JSON.stringify({
				table,
				columns,
				since: '',
				...(where ? { where } : {}),
				...(after ? { after, limit: 200 } : {})
			}),
			signal,
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
		const cursor = 'next_cursor' in body ? body.next_cursor : null;
		if (cursor != null && (typeof cursor !== 'string' || cursor <= after || !body.rows.length))
			throw new Error('Invalid hub cursor');
		for (const row of body.rows) rows.push(row as HubRow);
		if (cursor == null) return rows; // Legacy hubs return the complete table without a cursor.
		after = cursor;
	}
}

export async function GET({ platform, fetch }: Parameters<RequestHandler>[0], widgetsOnly = false) {
	const env = { ...privateEnv, ...platform?.env } as {
		SOMA_HUB_URL?: string;
		SOMA_HUB_TOKEN?: string;
	};
	const hub = env.SOMA_HUB_URL?.replace(/\/$/, '');
	const token = env.SOMA_HUB_TOKEN;
	if (!hub || !token) throw error(503, 'Finance data is not configured yet.');

	try {
		// Widgets need balances first. Card categories (for guidance) are best-effort there,
		// so an unrelated source failure never blocks a balance refresh.
		const optional = ['overlay', 'shares', 'categories'];
		const pulled: Record<string, HubRow[] | null> = Object.fromEntries(
			await Promise.all(
				Object.entries(TABLES).map(async ([t, cols]) => [
					t,
					widgetsOnly && !['accounts', 'scrape_runs', ...optional].includes(t)
						? []
						: await pull(
								hub,
								token,
								HUB_TABLE[t]?.table ?? t,
								cols,
								fetch,
								HUB_TABLE[t]?.where
							).catch((e) => {
								if (widgetsOnly && optional.includes(t)) return null;
								throw e;
							})
				])
			)
		);
		// Partial category data would mislabel spend: use none of it.
		const categoriesUnavailable = optional.some((t) => pulled[t] === null);
		if (categoriesUnavailable) for (const t of optional) pulled[t] = [];
		const { accounts } = pulled as Record<string, HubRow[]>;
		// Reuse registry normalization, including both supported closure fields.
		const cardIds = widgetsOnly
			? new Set(
					assemble({
						accounts,
						overlay: [],
						shares: [],
						points: [],
						categories: [],
						scrape_runs: [],
						venmo_statement_lines: [],
						txns: {}
					})
						.accounts.filter((a) => a.type === 'credit_card' && !a.closed)
						.map((a) => a.id)
				)
			: null;
		const selectedAccounts = cardIds ? accounts.filter((a) => cardIds.has(String(a.id))) : accounts;
		const sources = [
			...new Set(selectedAccounts.filter((a) => a.deleted_at == null).map((a) => a.source))
		];
		if (sources.some((s) => typeof s !== 'string' || !/^[a-z][a-z0-9_]*$/.test(s)))
			throw new Error('Invalid source');
		const txnRows = await Promise.all(
			sources.map((s) => pull(hub, token, `txns_${s}`, TXN_COLUMNS, fetch))
		);
		const txns = Object.fromEntries(
			sources.map((s, i) => [
				s,
				cardIds ? txnRows[i].filter((t) => cardIds.has(String(t.account_id))) : txnRows[i]
			])
		);
		const estate = assemble({
			...(pulled as Omit<EstateTables, 'accounts' | 'txns'>),
			accounts: selectedAccounts,
			txns
		});
		return json(
			{
				...estate,
				categories: estate.categories.map((category) => ({
					...category,
					iconUrl: categoryIconUrl(category.icon)
				})),
				...(widgetsOnly ? { categoriesUnavailable } : {})
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
}
