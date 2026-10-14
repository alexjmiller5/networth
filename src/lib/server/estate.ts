// Networth's one door to the Soma estate. Routes name the tables they need;
// soma's table-pull helper (vendored verbatim as table-pull.js) asks
// /v1/cursor once and pulls only tables whose mark moved, in batches. Rows and
// cursors live in Networth's own ESTATE_CACHE_DB, so a quiet load is one hub
// request. The cache is disposable: without it, or when it fails, every read
// is a full pull, never stale or partial data.
import { env as privateEnv } from '$env/dynamic/private';
import { BENEFIT_METRICS } from '$lib/finance/benefits';
import { pullTables } from './table-pull.js';

export type HubRow = Record<string, unknown>;

export const TXN_COLUMNS = [
	'id',
	'account_id',
	'date',
	// Posting date, bank label and name decide card reward eligibility (/api/rewards).
	'posted_date',
	'name',
	'bank_category',
	'amount',
	'status',
	'synthetic',
	'qty',
	'ticker',
	'deleted_at'
];
// One column list per table, the union of what every route reads, so the
// routes share one cached copy (another list would re-pull the table in full).
export const COLUMNS: Record<string, string[]> = {
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
	overlay: ['id', 'source', 'source_id', 'category', 'internal', 'excluded', 'deleted_at'],
	shares: ['id', 'source', 'source_id', 'date', 'amount', 'category', 'deleted_at'],
	categories: ['id', 'name', 'kind', 'icon', 'sort', 'parent_id', 'deleted_at'],
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
	points_balances: [
		'id',
		'program',
		'points',
		'est_value',
		'scraped_at',
		'component_id',
		'exact_amount',
		'basis',
		'source_as_of',
		'source_date',
		'period_start',
		'period_end_exclusive',
		'supersedes_id',
		'deleted_at'
	],
	reward_programs: ['id', 'label', 'provider', 'account_id', 'deleted_at'],
	reward_components: [
		'id',
		'program_id',
		'component_key',
		'label',
		'unit',
		'role',
		'currency',
		'deleted_at'
	],
	reward_events: [
		'id',
		'component_id',
		'event_key',
		'kind',
		'state',
		'event_date',
		'occurred_at',
		'posted_date',
		'units_delta',
		'observed_at',
		'period_start',
		'period_end_exclusive',
		'details',
		'supersedes_id',
		'deleted_at'
	],
	reward_terms: [
		'id',
		'program_id',
		'component_id',
		'term_key',
		'kind',
		'applicability',
		'effective_from',
		'effective_until',
		'source_as_of',
		'payload',
		'supersedes_id',
		'deleted_at'
	],
	redemption_valuations: [
		'id',
		'event_id',
		'basis',
		'comparable_amount',
		'currency',
		'comparable_scope',
		'reward_value',
		'rate_at_redemption',
		'units_consumed',
		'valued_at',
		'category',
		'supersedes_id',
		'deleted_at'
	],
	investment_instruments: [
		'id',
		'account_id',
		'provider_source',
		'provider_account_id',
		'provider_plan_id',
		'native_id_kind',
		'native_security_id',
		'representation',
		'native_label',
		'ticker',
		'share_class',
		'identity_observed_at',
		'deleted_at'
	],
	investment_observations: [
		'id',
		'instrument_id',
		'metric',
		'exact_amount',
		'currency',
		'value_status',
		'missing_reason',
		'price_kind',
		'source_date',
		'source_at',
		'time_basis',
		'quote_delay_seconds',
		'captured_at',
		'capture_key',
		'supersedes_id',
		'deleted_at'
	],
	benefit_plans: [
		'id',
		'provider',
		'native_plan_id',
		'name',
		'kind',
		'currency',
		'status',
		'income_category_id',
		'deleted_at'
	],
	benefit_transactions: [
		'id',
		'plan_id',
		'date',
		'amount',
		'currency',
		'kind',
		'status',
		'deleted_at'
	],
	benefit_snapshots: [
		'id',
		'plan_id',
		'plan_year',
		'observed_at',
		'source_as_of',
		'currency',
		...Object.keys(BENEFIT_METRICS),
		'eligibility_status',
		'vested_visibility',
		'source_record_ref',
		'deleted_at'
	]
};
// Equality slices of a table too large to copy. Each is re-read whole only
// when its table's mark moves (the helper's `watch`).
export const SLICES = {
	asset_evidence: {
		table: 'provenance',
		columns: ['id', 'to_ref', 'from_kind', 'from_ref', 'deleted_at'],
		where: { to_kind: 'asset_events', rel: 'evidence_of' }
	},
	reward_links: {
		table: 'provenance',
		columns: ['id', 'from_ref', 'to_ref', 'deleted_at'],
		where: { to_kind: 'reward_events', from_kind: 'txn', rel: 'evidence_of' }
	}
};
export type Slice = keyof typeof SLICES;

export interface EstateSource {
	hub: string;
	token: string;
	fetch: typeof fetch;
	db?: D1Database;
}

/** The configured hub and this server's own token, or null when either is missing. */
export function estateSource(event: {
	platform?: App.Platform;
	fetch: typeof fetch;
}): EstateSource | null {
	const env = { ...privateEnv, ...event.platform?.env } as {
		SOMA_HUB_URL?: string;
		SOMA_HUB_TOKEN?: string;
		ESTATE_CACHE_DB?: D1Database;
	};
	const hub = env.SOMA_HUB_URL?.replace(/\/$/, '');
	if (!hub || !env.SOMA_HUB_TOKEN) return null;
	return { hub, token: env.SOMA_HUB_TOKEN, fetch: event.fetch, db: env.ESTATE_CACHE_DB };
}

type Held = { endpoint: string; columns: string; since: string; n: number };
const CHUNK = 500;
const byId = (a: HubRow, b: HubRow) => (String(a.id) < String(b.id) ? -1 : 1);

/**
 * Current rows (tombstones included) of `tables` and `slices`, plus the tables
 * `expand` names from them (each source's ledger). `complete` is false when a
 * table walked several pages in this read: no snapshot spans them.
 */
export async function readEstate(
	source: EstateSource,
	tables: string[],
	options: {
		slices?: Slice[];
		expand?: (rows: Record<string, HubRow[]>) => string[];
		/** Read these tables with other columns (bypass the cache when used). */
		columns?: Record<string, string[]>;
	} = {}
): Promise<{ rows: Record<string, HubRow[]>; complete: boolean }> {
	const { hub, token } = source,
		{ slices = [], expand } = options;
	const signal = AbortSignal.timeout(20_000);
	// Workers support manual/follow only: a 3xx is then a failed response, so the
	// credential never leaves this exact configured hub.
	const fetch = (url: string, init: RequestInit) =>
		source.fetch(url, { ...init, redirect: 'manual', signal });
	const columnsOf = (t: string) => {
		const columns =
			options.columns?.[t] ?? COLUMNS[t] ?? (/^txns_[a-z][a-z0-9_]*$/.test(t) ? TXN_COLUMNS : null);
		if (!columns) throw new Error(`No columns for ${t}`);
		return columns;
	};

	let db = source.db;
	const held = new Map<string, Held>(),
		copies = new Map<string, Map<string, HubRow>>();
	const load = async (names: string[], state = false) => {
		if (!db || !names.length) return;
		try {
			const [rows, cursors] = await db.batch([
				db
					.prepare(
						'SELECT tbl, row FROM pull_rows WHERE tbl IN (SELECT value FROM json_each(?)) ORDER BY tbl, id'
					)
					.bind(JSON.stringify(names)),
				...(state ? [db.prepare('SELECT * FROM pull_state')] : [])
			]);
			for (const { tbl, row } of rows.results as { tbl: string; row: string }[]) {
				const parsed = JSON.parse(row) as HubRow;
				if (!copies.has(tbl)) copies.set(tbl, new Map());
				copies.get(tbl)!.set(String(parsed.id), parsed);
			}
			for (const cursor of (cursors?.results ?? []) as (Held & { tbl: string })[])
				held.set(cursor.tbl, cursor);
		} catch (cause) {
			// Without a consistent copy, read everything in full and keep nothing.
			console.error('Estate cache unavailable', { type: errorType(cause) });
			db = undefined;
			held.clear();
			copies.clear();
		}
	};
	const view = () =>
		Object.fromEntries([...copies].map(([t, copy]) => [t, [...copy.values()].sort(byId)]));

	let complete = true;
	const written = new Map<string, { full: boolean; rows: HubRow[] }>(),
		next = new Map<string, Held>();
	const watch = [...new Set(slices.map((s) => SLICES[s].table))];
	let watched: Record<string, { mark: string; n: number }> = {};
	const round = async (names: string[], marks: boolean) => {
		const out = await pullTables({
			endpoint: hub,
			token,
			fetch,
			tables: Object.fromEntries(names.map((t) => [t, columnsOf(t)])),
			state: {
				v: 1,
				endpoint: hub,
				tables: Object.fromEntries(
					names.flatMap((t) => {
						const h = held.get(t);
						return h?.endpoint === hub ? [[t, { columns: h.columns, since: h.since, n: h.n }]] : [];
					})
				)
			},
			watch: marks ? watch : []
		});
		// One cursor request plus one batch: no table needed a second page.
		if (out.requests > 2) complete = false;
		if (marks) watched = out.watched;
		for (const [t, change] of Object.entries(out.changes)) {
			const pulled = [...change.rows, ...change.tombstones];
			const copy = change.full ? new Map<string, HubRow>() : (copies.get(t) ?? new Map());
			for (const row of pulled) copy.set(row.id, row);
			copies.set(t, copy);
			if (change.full || pulled.length) written.set(t, { full: change.full, rows: pulled });
			next.set(t, { endpoint: hub, ...out.state.tables[t] });
		}
	};

	if (options.columns) db = undefined;
	await load([...tables, ...slices], true);
	let names = [...tables];
	if (expand) {
		// A cached copy is only a guess at the ledgers to ask for; a bad one never blocks the read.
		let guess: string[] = [];
		try {
			guess = expand(view()).filter((t) => !names.includes(t));
		} catch {
			guess = [];
		}
		await load(guess);
		names = [...names, ...guess];
	}
	await round(names, true);
	let result = names;
	if (expand) {
		const wanted = expand(view());
		const later = wanted.filter((t) => !names.includes(t));
		await load(later);
		if (later.length) await round(later, false);
		result = [...tables, ...wanted];
	}

	const definition = (s: Slice) => JSON.stringify(SLICES[s]);
	const moved = slices.filter((s) => {
		const h = held.get(s),
			{ mark, n } = watched[SLICES[s].table];
		return !(h?.endpoint === hub && h.columns === definition(s) && h.since === mark && h.n === n);
	});
	await Promise.all(
		moved.map(async (s) => {
			const { table, columns, where } = SLICES[s];
			const { mark, n } = watched[table];
			// A slice is small: one complete read (no limit) answers it whole.
			const response = await fetch(`${hub}/v1/rows/pull`, {
				method: 'POST',
				headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({ table, columns, since: '', where })
			});
			if (!response.ok) throw new Error(`Hub slice read failed (${response.status})`);
			const rows = ((await response.json()) as { rows?: unknown } | null)?.rows;
			if (!Array.isArray(rows) || rows.some((r) => typeof r?.id !== 'string'))
				throw new Error('Invalid hub response');
			copies.set(s, new Map(rows.map((r: HubRow) => [String(r.id), r])));
			written.set(s, { full: true, rows });
			next.set(s, { endpoint: hub, columns: definition(s), since: mark, n });
		})
	);

	if (db) await save(db, written, next, held);
	const rows = view();
	return {
		rows: Object.fromEntries([...result, ...slices].map((t) => [t, rows[t] ?? []])),
		complete
	};
}

/** Write what this read changed, rows and cursors together in one transaction. */
async function save(
	db: D1Database,
	written: Map<string, { full: boolean; rows: HubRow[] }>,
	next: Map<string, Held>,
	held: Map<string, Held>
) {
	const statements: D1PreparedStatement[] = [];
	for (const [t, { full, rows }] of written) {
		if (full) statements.push(db.prepare('DELETE FROM pull_rows WHERE tbl = ?').bind(t));
		for (let i = 0; i < rows.length; i += CHUNK)
			statements.push(
				db
					.prepare(
						"INSERT OR REPLACE INTO pull_rows (tbl, id, row) SELECT ?, json_extract(value, '$.id'), value FROM json_each(?)"
					)
					.bind(t, JSON.stringify(rows.slice(i, i + CHUNK)))
			);
	}
	for (const [t, s] of next) {
		const h = held.get(t);
		if (h?.endpoint === s.endpoint && h.columns === s.columns && h.since === s.since && h.n === s.n)
			continue;
		statements.push(
			db
				.prepare(
					'INSERT OR REPLACE INTO pull_state (tbl, endpoint, columns, since, n) VALUES (?, ?, ?, ?, ?)'
				)
				.bind(t, s.endpoint, s.columns, s.since, s.n)
		);
	}
	if (!statements.length) return;
	try {
		await db.batch(statements);
	} catch (cause) {
		console.error('Estate cache write failed', { type: errorType(cause) });
	}
}

const errorType = (cause: unknown) => (cause instanceof Error ? cause.name : 'Unknown');
