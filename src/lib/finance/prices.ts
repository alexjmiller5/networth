import { isDate } from './presets';

export interface PriceRequest {
	provider: 'tiingo' | 'fidelity' | 'alphavantage';
	instrumentId: string;
	identifier: string;
	currency: string;
	start: string;
	end: string;
	/** Fidelity only: the ticker the fund number must resolve to (its payload names it). */
	expectedSymbol?: string;
}
export interface PriceObservation {
	instrumentId: string;
	provider: PriceRequest['provider'];
	identifier: string;
	date: string;
	price: string;
	currency: string;
	currencySource: 'mapping' | 'provider';
	basis: 'raw-nav' | 'raw-close';
	/** Tiingo's split factor on its ex-date, only when it is not 1. */
	splitFactor?: string;
}
export interface PriceGap {
	start: string;
	end: string;
	reason: 'empty-price' | 'outside-returned-range';
}
type UnavailableReason =
	'invalid-request' | 'invalid-response' | 'no-observations' | 'missing-key' | 'transport-error';
interface PriceResultBase {
	provider: PriceRequest['provider'];
	observations: PriceObservation[];
	gaps: PriceGap[];
	fetchedAt: string;
	sourceAsOf: string | null;
	sourceTimeZone: string | null;
	sourceUrl: string | null;
	completeness: 'unverified';
}
export type PriceFetchResult = PriceResultBase &
	({ status: 'available' } | { status: 'unavailable'; reason: UnavailableReason; detail: string });
export const PRICE_SOURCE_URLS = {
	tiingo: 'https://api.tiingo.com/tiingo/daily/',
	fidelity: 'https://institutional.fidelity.com/app/funds/historicalFundPricing',
	alphavantage: 'https://www.alphavantage.co/query'
} as const;

export function unavailablePriceHistory(
	request: PriceRequest,
	fetchedAt: string,
	reason: UnavailableReason,
	detail: string
): PriceFetchResult {
	return {
		status: 'unavailable',
		reason,
		detail,
		provider: request.provider,
		observations: [],
		gaps: [],
		fetchedAt,
		sourceAsOf: null,
		sourceTimeZone: null,
		sourceUrl: Object.hasOwn(PRICE_SOURCE_URLS, request.provider)
			? PRICE_SOURCE_URLS[request.provider]
			: null,
		completeness: 'unverified'
	};
}

export function priceRequestIssue(
	request: PriceRequest,
	fetchedAt: string
): PriceFetchResult | null {
	const validTimestamp =
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(fetchedAt) &&
		Number.isFinite(Date.parse(fetchedAt)) &&
		new Date(fetchedAt).toISOString() === fetchedAt;
	const validIdentifier =
		typeof request.identifier === 'string' &&
		(request.provider === 'fidelity'
			? /^\d{1,10}$/.test(request.identifier)
			: /^[A-Za-z0-9.^_-]{1,40}$/.test(request.identifier));
	if (
		!Object.hasOwn(PRICE_SOURCE_URLS, request.provider) ||
		!validTimestamp ||
		!validIdentifier ||
		typeof request.instrumentId !== 'string' ||
		!request.instrumentId.trim() ||
		request.instrumentId.trim() !== request.instrumentId ||
		!Intl.supportedValuesOf('currency').includes(request.currency) ||
		!isDate(request.start) ||
		!isDate(request.end) ||
		request.start > request.end
	) {
		return unavailablePriceHistory(
			request,
			fetchedAt,
			'invalid-request',
			'A supported provider, explicit instrument mapping and currency, valid date interval, and UTC retrieval timestamp are required.'
		);
	}
	return null;
}
function record(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function decimal(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		/^(0|[1-9]\d*)(\.\d+)?$/.test(value) &&
		Number.isFinite(Number(value))
	);
}
function nextDay(date: string, offset: number): string {
	return new Date(Date.parse(date) + offset * 86400000).toISOString().slice(0, 10);
}

/** Raw provider observations only. Availability never certifies interval coverage or holdings. */
export function parsePriceHistory(
	request: PriceRequest,
	payload: unknown,
	fetchedAt: string
): PriceFetchResult {
	const issue = priceRequestIssue(request, fetchedAt);
	if (issue) return issue;
	const invalid = () =>
		unavailablePriceHistory(
			request,
			fetchedAt,
			'invalid-response',
			'Provider payload is invalid, reports an error, or does not match the requested identity/currency.'
		);
	let rows: { date: unknown; price: unknown; split?: unknown }[];
	let sourceAsOf: string | null = null;
	let sourceTimeZone: string | null = null;
	let sourceCurrency: unknown;
	if (request.provider === 'tiingo') {
		// Raw `close`, never `adjClose`; dates are UTC-midnight instants of the trading day.
		if (!Array.isArray(payload) || !payload.every(record)) return invalid();
		rows = payload.map((row) => ({
			date:
				typeof row.date === 'string' && /T00:00:00(\.000)?Z$/.test(row.date)
					? row.date.slice(0, 10)
					: null,
			price: typeof row.close === 'number' && Number.isFinite(row.close) ? String(row.close) : null,
			split: row.splitFactor
		}));
		if (rows.some((r) => typeof r.split !== 'number' || !(Number(r.split) > 0))) return invalid();
	} else if (
		!record(payload) ||
		['Information', 'Note', 'Error Message', 'error', 'AccessDenied'].some((key) =>
			Object.hasOwn(payload, key)
		) ||
		((sourceCurrency = payload.currency) !== undefined && sourceCurrency !== request.currency)
	)
		return invalid();
	else if (request.provider === 'fidelity') {
		if (
			payload.status !== 'success' ||
			payload.fundNo !== request.identifier ||
			(request.expectedSymbol !== undefined && payload.tradingSymbol !== request.expectedSymbol) ||
			!Array.isArray(payload.prices) ||
			!payload.prices.every(record)
		)
			return invalid();
		rows = payload.prices.map((row) => ({ date: row.date, price: row.nav }));
	} else {
		const metadata = payload['Meta Data'];
		const series = payload['Time Series (Daily)'];
		if (
			!record(metadata) ||
			metadata['2. Symbol'] !== request.identifier ||
			!isDate(metadata['3. Last Refreshed']) ||
			typeof metadata['5. Time Zone'] !== 'string' ||
			!record(series)
		)
			return invalid();
		sourceAsOf = metadata['3. Last Refreshed'];
		sourceTimeZone = metadata['5. Time Zone'];
		try {
			new Intl.DateTimeFormat('en', { timeZone: sourceTimeZone });
		} catch {
			return invalid();
		}
		rows = Object.entries(series).map(([date, row]) => ({
			date,
			price: record(row) ? row['4. close'] : undefined
		}));
	}
	const seen = new Set<string>();
	const observations: PriceObservation[] = [];
	const gaps: PriceGap[] = [];
	for (const { date, price, split } of rows) {
		if (
			!isDate(date) ||
			seen.has(date) ||
			(price !== '' && !decimal(price)) ||
			(request.provider !== 'fidelity' && price === '')
		)
			return invalid();
		seen.add(date);
		if (sourceAsOf && request.provider === 'alphavantage' && date > sourceAsOf) return invalid();
		if (price !== '' && request.provider !== 'alphavantage' && (!sourceAsOf || date > sourceAsOf))
			sourceAsOf = date;
		if (date < request.start || date > request.end) continue;
		if (price === '') {
			gaps.push({ start: date, end: date, reason: 'empty-price' });
			continue;
		}
		observations.push({
			instrumentId: request.instrumentId,
			provider: request.provider,
			identifier: request.identifier,
			date,
			price: price as string,
			currency: request.currency,
			currencySource: sourceCurrency === undefined ? 'mapping' : 'provider',
			basis: request.provider === 'fidelity' ? 'raw-nav' : 'raw-close',
			...(split !== undefined && split !== 1 ? { splitFactor: String(split) } : {})
		});
	}
	const dates = [...seen].sort();
	if (!dates.length || request.end < dates[0] || request.start > dates.at(-1)!) {
		gaps.push({ start: request.start, end: request.end, reason: 'outside-returned-range' });
	} else {
		if (request.start < dates[0])
			gaps.push({
				start: request.start,
				end: nextDay(dates[0], -1),
				reason: 'outside-returned-range'
			});
		if (request.end > dates.at(-1)!)
			gaps.push({
				start: nextDay(dates.at(-1)!, 1),
				end: request.end,
				reason: 'outside-returned-range'
			});
	}
	const base: PriceResultBase = {
		provider: request.provider,
		observations: observations.sort((a, b) => a.date.localeCompare(b.date)),
		gaps: gaps.sort((a, b) => a.start.localeCompare(b.start)),
		fetchedAt,
		sourceAsOf,
		sourceTimeZone,
		sourceUrl: PRICE_SOURCE_URLS[request.provider],
		completeness: 'unverified'
	};
	return observations.length
		? { ...base, status: 'available' }
		: {
				...base,
				status: 'unavailable',
				reason: 'no-observations',
				detail: 'No usable raw prices were returned in the requested interval.'
			};
}
