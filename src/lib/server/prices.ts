// Networth's own daily price cache (PRICES_DB). Mappings are owner-entered data;
// closes are raw provider facts. Refresh backfills a new series once, then fetches
// a short overlapping window so late corrections land and missed days self-heal.
import { fetchPriceHistory } from '$lib/finance/prices.server';
import { addDays } from '$lib/finance/presets';
import { assetClass } from '$lib/finance/series';
import type { Estate, HubRow } from '$lib/finance/assemble';
import {
	MAX_PRICE_AGE_DAYS,
	valueAccounts,
	valuedCoverage,
	type ObservedUnits,
	type PriceBook,
	type PriceMapping
} from '$lib/finance/valuation';

export interface PriceKeys {
	tiingo?: string;
	alphaVantage?: string;
}
export interface StoredMapping extends PriceMapping {
	currency: string;
	revision: number;
}
export interface RefreshResult {
	provider: string;
	symbol: string;
	status: 'available' | 'unavailable';
	rows: number;
	from: string;
	detail?: string;
}

/** Tiingo returns its whole history from this date; Fidelity caps a request near a month. */
const BACKFILL_FROM = '1970-01-01';
const OVERLAP_DAYS = 10;
const FIDELITY_WINDOW_DAYS = 30;
const CHUNK = 500;

export async function readMappings(db: D1Database): Promise<StoredMapping[]> {
	const { results } = await db
		.prepare(
			'SELECT account_id, security_id, provider, symbol, currency, revision FROM price_mappings ORDER BY account_id, security_id'
		)
		.all<StoredMapping>();
	return results;
}

/** Cached closes for every mapped daily series from `from`, one primary-key range read per series. */
export async function readPrices(
	db: D1Database,
	mappings: PriceMapping[],
	from: string
): Promise<PriceBook> {
	const series = [
		...new Map(
			mappings
				.filter((m) => m.provider !== 'netbenefits' && m.symbol)
				.map((m) => [`${m.provider}:${m.symbol}`, [m.provider, m.symbol!]] as const)
		).values()
	];
	const book: PriceBook = new Map();
	const results = series.length
		? await db.batch(
				series.map(([provider, symbol]) =>
					db
						.prepare(
							'SELECT date, close, split_factor FROM price_closes WHERE provider = ? AND symbol = ? AND date >= ? ORDER BY date'
						)
						.bind(provider, symbol, from)
				)
			)
		: [];
	series.forEach(([provider, symbol], i) => {
		const rows = (results[i].results ?? []) as {
			date: string;
			close: string;
			split_factor: string | null;
		}[];
		book.set(
			`${provider}:${symbol}`,
			rows.map((r) => ({
				date: r.date,
				price: Number(r.close),
				...(r.split_factor ? { split: Number(r.split_factor) } : {})
			}))
		);
	});
	return book;
}

/** Fetch new closes for every mapped daily series. Unavailable responses never delete or zero a row. */
export async function refreshPrices(
	db: D1Database,
	keys: PriceKeys,
	options: { fetcher?: typeof fetch; now?: () => Date } = {}
): Promise<RefreshResult[]> {
	const now = options.now ?? (() => new Date());
	const today = now().toISOString().slice(0, 10);
	const mappings = await readMappings(db);
	const series = new Map<string, StoredMapping>();
	for (const m of mappings)
		if (m.provider !== 'netbenefits' && m.symbol) series.set(`${m.provider}:${m.symbol}`, m);
	const out: RefreshResult[] = [];
	for (const m of series.values()) {
		const last = await db
			.prepare('SELECT max(date) AS last FROM price_closes WHERE provider = ? AND symbol = ?')
			.bind(m.provider, m.symbol)
			.first<{ last: string | null }>();
		const from =
			m.provider === 'fidelity'
				? addDays(today, -FIDELITY_WINDOW_DAYS)
				: last?.last
					? addDays(last.last, -OVERLAP_DAYS)
					: m.provider === 'tiingo'
						? BACKFILL_FROM
						: addDays(today, -100);
		const result = await fetchPriceHistory(
			{
				provider: m.provider as 'tiingo' | 'fidelity' | 'alphavantage',
				instrumentId: `${m.provider}:${m.symbol}`,
				identifier: m.symbol!,
				currency: m.currency,
				start: from,
				end: today,
				...(m.provider === 'fidelity' ? { expectedSymbol: m.security_id } : {})
			},
			{
				fetcher: options.fetcher,
				now,
				tiingoKey: keys.tiingo,
				alphaVantageKey: keys.alphaVantage
			}
		);
		const rows = result.observations.map((o) => ({
			date: o.date,
			price: o.price,
			split: o.splitFactor ?? null
		}));
		for (let i = 0; i < rows.length; i += CHUNK)
			await db
				.prepare(
					`INSERT INTO price_closes (provider, symbol, date, close, currency, basis, split_factor, fetched_at)
					 SELECT ?1, ?2, j.value ->> 'date', j.value ->> 'price', ?3, ?4, j.value ->> 'split', ?5
					 FROM json_each(?6) AS j WHERE true
					 ON CONFLICT (provider, symbol, date) DO UPDATE SET
					   close = excluded.close, split_factor = excluded.split_factor, fetched_at = excluded.fetched_at
					 WHERE price_closes.close IS NOT excluded.close OR price_closes.split_factor IS NOT excluded.split_factor`
				)
				.bind(
					m.provider,
					m.symbol,
					m.currency,
					m.provider === 'fidelity' ? 'raw-nav' : 'raw-close',
					result.fetchedAt,
					JSON.stringify(rows.slice(i, i + CHUNK))
				)
				.run();
		out.push({
			provider: m.provider,
			symbol: m.symbol!,
			status: result.status,
			rows: rows.length,
			from,
			...(result.status === 'unavailable' ? { detail: result.detail } : {})
		});
	}
	return out;
}

export const INSTRUMENT_COLUMNS = ['id', 'account_id', 'native_security_id', 'deleted_at'];
export const OBSERVATION_COLUMNS = [
	'instrument_id',
	'metric',
	'exact_amount',
	'currency',
	'value_status',
	'price_kind',
	'source_date',
	'time_basis',
	'captured_at',
	'deleted_at'
];

/** Value the estate's investment accounts from the cache plus Soma's native NAV and unit
 * observations, joined only within each observation's own account and security. */
export async function valueEstate(
	estate: Estate,
	db: D1Database,
	instruments: HubRow[],
	observations: HubRow[],
	end: string
): Promise<Pick<Estate, 'coverage' | 'valuations'>> {
	const invested = new Set(
		estate.accounts.filter((a) => assetClass(a) === 'investments').map((a) => a.id)
	);
	const first = estate.txns.find((t) => invested.has(t.account_id ?? ''))?.date;
	if (!first) return { coverage: estate.coverage, valuations: [] };
	const mappings = await readMappings(db);
	const prices = await readPrices(db, mappings, addDays(first, -MAX_PRICE_AGE_DAYS - 10));
	const live = (r: HubRow) => r.deleted_at == null;
	const instrumentOf = new Map(instruments.filter(live).map((i) => [String(i.id), i]));
	const navs = new Map<string, Map<string, number | null>>();
	const observed: ObservedUnits[] = [];
	for (const o of observations.filter(live)) {
		const instrument = instrumentOf.get(String(o.instrument_id));
		const amount = Number(o.exact_amount);
		if (!instrument || o.value_status !== 'reported' || !Number.isFinite(amount)) continue;
		const account_id = String(instrument.account_id);
		const security_id = String(instrument.native_security_id);
		if (o.metric === 'unit_price' && o.price_kind === 'nav' && o.currency === 'USD') {
			if (typeof o.source_date !== 'string') continue;
			const key = `netbenefits:${account_id}:${security_id}`;
			const byDate = navs.get(key) ?? new Map<string, number | null>();
			// Two different NAVs for one source date are ambiguous: use neither.
			byDate.set(
				o.source_date,
				byDate.has(o.source_date) && byDate.get(o.source_date) !== amount ? null : amount
			);
			navs.set(key, byDate);
		} else if (o.metric === 'position_units') {
			const date =
				typeof o.source_date === 'string'
					? o.source_date
					: o.time_basis === 'observation_only' && typeof o.captured_at === 'string'
						? o.captured_at.slice(0, 10)
						: null;
			if (date) observed.push({ account_id, security_id, date, units: amount });
		}
	}
	for (const [key, byDate] of navs)
		prices.set(
			key,
			[...byDate]
				.filter((entry): entry is [string, number] => entry[1] !== null)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([date, price]) => ({ date, price }))
		);
	const valuations = valueAccounts({
		accounts: estate.accounts,
		txns: estate.txns,
		coverage: estate.coverage,
		mappings,
		prices,
		observed,
		end
	});
	return { valuations, coverage: valuedCoverage(estate.coverage, valuations) };
}
