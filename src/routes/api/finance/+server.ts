// The one data door: read the finance tables from the soma hub with a
// read-only token and hand the browser the assembled estate. Cloudflare
// Access in front of the site is the auth; the hub token never leaves the
// Worker. SOMA_HUB_URL is a var (wrangler.jsonc), SOMA_HUB_TOKEN a secret.
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { assemble, type HubRow } from '$lib/finance/assemble';
import { categoryIconUrl } from '$lib/server/categoryIcons';
import { estateSource, readEstate } from '$lib/server/estate';
import { valueEstate } from '$lib/server/prices';

const TABLES = [
	'accounts',
	'overlay',
	'shares',
	'points_balances',
	'categories',
	'scrape_runs',
	'venmo_statement_lines',
	'assets',
	'asset_events',
	'reward_components',
	'reward_events',
	'redemption_valuations',
	'benefit_plans',
	'benefit_transactions'
];
// Native NAV and unit observations, read only when prices can use them.
const NATIVE = ['investment_instruments', 'investment_observations'];

// Every live source's ledger.
function ledgers(rows: Record<string, HubRow[]>) {
	const sources = [
		...new Set((rows.accounts ?? []).filter((a) => a.deleted_at == null).map((a) => a.source))
	];
	if (sources.some((s) => typeof s !== 'string' || !/^[a-z][a-z0-9_]*$/.test(s)))
		throw new Error('Invalid source');
	return sources.map((s) => `txns_${s}`);
}

export async function GET({ platform, fetch }: Parameters<RequestHandler>[0]) {
	const source = estateSource({ platform, fetch });
	if (!source) throw error(503, 'Finance data is not configured yet.');
	const prices = platform?.env?.PRICES_DB;
	try {
		const read = (tables: string[]) =>
			readEstate(source, tables, { slices: ['asset_evidence'], expand: ledgers });
		let rows: Record<string, HubRow[]>,
			native = !!prices;
		try {
			({ rows } = await read(native ? [...TABLES, ...NATIVE] : TABLES));
		} catch (cause) {
			// Valuation is additive: a failed native read never blocks the estate.
			if (!native) throw cause;
			({ rows } = await read(TABLES));
			native = false;
		}
		const estate = assemble({
			accounts: rows.accounts,
			overlay: rows.overlay,
			shares: rows.shares,
			points: rows.points_balances,
			categories: rows.categories,
			scrape_runs: rows.scrape_runs,
			venmo_statement_lines: rows.venmo_statement_lines,
			assets: rows.assets,
			asset_events: rows.asset_events,
			asset_evidence: rows.asset_evidence,
			benefit_plans: rows.benefit_plans,
			benefit_transactions: rows.benefit_transactions,
			reward_components: rows.reward_components,
			reward_events: rows.reward_events,
			redemption_valuations: rows.redemption_valuations,
			txns: Object.fromEntries(ledgers(rows).map((t) => [t.slice('txns_'.length), rows[t]]))
		});
		let valued: Pick<typeof estate, 'coverage' | 'valuations'> = { coverage: estate.coverage };
		if (native && prices)
			try {
				valued = await valueEstate(
					estate,
					prices,
					rows.investment_instruments,
					rows.investment_observations,
					new Date().toISOString().slice(0, 10)
				);
			} catch (cause) {
				// Valuation is additive: without it investments stay explicitly unvalued.
				console.error('Investment valuation unavailable', {
					type: cause instanceof Error ? cause.name : 'Unknown'
				});
			}
		return json(
			{
				...estate,
				...valued,
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
}
