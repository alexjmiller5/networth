import {
	PRICE_SOURCE_URLS,
	parsePriceHistory,
	priceRequestIssue,
	unavailablePriceHistory,
	type PriceRequest,
	type PriceFetchResult
} from './prices';

/** Server-only read adapter. No ambient credentials, retries, persistence, or valuation side effects. */
export async function fetchPriceHistory(
	request: PriceRequest,
	options: {
		fetcher?: typeof fetch;
		now?: () => Date;
		alphaVantageKey?: string;
		tiingoKey?: string;
	} = {}
): Promise<PriceFetchResult> {
	const fetchedAt = (options.now ?? (() => new Date()))().toISOString();
	const issue = priceRequestIssue(request, fetchedAt);
	if (issue) return issue;
	const key = { tiingo: options.tiingoKey, alphavantage: options.alphaVantageKey, fidelity: '-' }[
		request.provider
	];
	if (!key?.trim())
		return unavailablePriceHistory(
			request,
			fetchedAt,
			'missing-key',
			'A caller-supplied server API key is required.'
		);
	const url = new URL(
		request.provider === 'tiingo'
			? `${PRICE_SOURCE_URLS.tiingo}${encodeURIComponent(request.identifier)}/prices`
			: PRICE_SOURCE_URLS[request.provider]
	);
	const init: RequestInit = {
		redirect: 'manual',
		credentials: 'omit',
		headers: { Accept: 'application/json' },
		signal: AbortSignal.timeout(10_000)
	};
	if (request.provider === 'fidelity') {
		const formDate = (date: string) =>
			`${date.slice(5, 7)}/${date.slice(8, 10)}/${date.slice(0, 4)}`;
		init.method = 'POST';
		init.headers = { ...init.headers, 'Content-Type': 'application/x-www-form-urlencoded' };
		init.body = new URLSearchParams({
			fundNo: request.identifier,
			startDate: formDate(request.start),
			endDate: formDate(request.end)
		}).toString();
	} else if (request.provider === 'tiingo') {
		// The token travels in a header so a logged or echoed URL never carries it.
		init.headers = { ...init.headers, Authorization: `Token ${options.tiingoKey}` };
		url.search = new URLSearchParams({
			startDate: request.start,
			endDate: request.end
		}).toString();
	} else {
		url.search = new URLSearchParams({
			function: 'TIME_SERIES_DAILY',
			symbol: request.identifier,
			outputsize: 'compact',
			datatype: 'json',
			apikey: options.alphaVantageKey!
		}).toString();
	}
	try {
		const response = await (options.fetcher ?? fetch)(url, init);
		if (!response.ok || response.redirected)
			return unavailablePriceHistory(
				request,
				fetchedAt,
				'transport-error',
				'Provider HTTP request failed or redirected.'
			);
		if (
			response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !==
			'application/json'
		)
			return unavailablePriceHistory(
				request,
				fetchedAt,
				'invalid-response',
				'Provider did not return JSON.'
			);
		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			return unavailablePriceHistory(
				request,
				fetchedAt,
				'invalid-response',
				'Provider returned malformed JSON.'
			);
		}
		return parsePriceHistory(request, payload, fetchedAt);
	} catch {
		// Fetch errors can contain the credential-bearing request URL. Never propagate them.
		return unavailablePriceHistory(
			request,
			fetchedAt,
			'transport-error',
			'Provider request failed or exceeded the 10-second timeout.'
		);
	}
}
