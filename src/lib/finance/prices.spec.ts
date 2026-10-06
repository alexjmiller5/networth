import { describe, expect, it } from 'vitest';
import { parsePriceHistory, type PriceRequest } from './prices';

const request: PriceRequest = {
	provider: 'fidelity',
	instrumentId: 'instrument-1',
	identifier: '123456',
	currency: 'USD',
	start: '2024-02-28',
	end: '2024-03-04'
};
const fetchedAt = '2024-03-05T01:02:03.000Z';
function fidelity(overrides: Record<string, unknown> = {}) {
	return {
		status: 'success',
		fundNo: '123456',
		tradingSymbol: 'TESTX',
		cusipNo: '000000000',
		prices: [
			{ date: '2024-03-04', nav: '12.3400', pop: '13.00' },
			{ date: '2024-03-02', nav: '', pop: '' },
			{ date: '2024-02-29', nav: '12.10', pop: '13.00' }
		],
		...overrides
	};
}
const alphaRequest: PriceRequest = { ...request, provider: 'alphavantage', identifier: 'TEST.X' };
function alpha(overrides: Record<string, unknown> = {}) {
	return {
		'Meta Data': {
			'1. Information': 'Daily Prices (open, high, low, close) and Volumes',
			'2. Symbol': 'TEST.X',
			'3. Last Refreshed': '2024-03-04',
			'4. Output Size': 'Compact',
			'5. Time Zone': 'US/Eastern'
		},
		'Time Series (Daily)': {
			'2024-03-04': {
				'1. open': '10',
				'2. high': '15',
				'3. low': '10',
				'4. close': '12.3400',
				'5. volume': '100'
			},
			'2024-02-29': { '4. close': '12.10' }
		},
		...overrides
	};
}

describe('raw NAV observations', () => {
	it('retains precise NAV, identity, provenance, and dates separately from retrieval time', () => {
		const result = parsePriceHistory(request, fidelity(), fetchedAt);
		expect(result.status).toBe('available');
		expect(result.observations).toEqual([
			{
				instrumentId: 'instrument-1',
				provider: 'fidelity',
				identifier: '123456',
				date: '2024-02-29',
				price: '12.10',
				currency: 'USD',
				currencySource: 'mapping',
				basis: 'raw-nav'
			},
			{
				instrumentId: 'instrument-1',
				provider: 'fidelity',
				identifier: '123456',
				date: '2024-03-04',
				price: '12.3400',
				currency: 'USD',
				currencySource: 'mapping',
				basis: 'raw-nav'
			}
		]);
		expect(result).toMatchObject({
			fetchedAt,
			sourceAsOf: '2024-03-04',
			sourceTimeZone: null,
			completeness: 'unverified',
			sourceUrl: 'https://institutional.fidelity.com/app/funds/historicalFundPricing'
		});
	});
	it('reports blank values and uncovered edges without inventing non-trading-day prices', () => {
		const result = parsePriceHistory(request, fidelity(), fetchedAt);
		expect(result.gaps).toEqual([
			{ start: '2024-02-28', end: '2024-02-28', reason: 'outside-returned-range' },
			{ start: '2024-03-02', end: '2024-03-02', reason: 'empty-price' }
		]);
		expect(result.observations.some((p) => p.date === '2024-03-02')).toBe(false);
	});
	it.each(['2024-02-30', '2024-2-29', 'not-a-date'])('rejects invalid date %s', (date) => {
		expect(
			parsePriceHistory(request, fidelity({ prices: [{ date, nav: '2' }] }), fetchedAt)
		).toMatchObject({ status: 'unavailable', reason: 'invalid-response', observations: [] });
	});
	it.each([' 12.00', '1e3', 'NaN', 'Infinity', '-2', '00.10', 12.34, null])(
		'rejects malformed decimal %s instead of coercing it',
		(nav) => {
			expect(
				parsePriceHistory(request, fidelity({ prices: [{ date: '2024-03-04', nav }] }), fetchedAt)
			).toMatchObject({ status: 'unavailable', reason: 'invalid-response', observations: [] });
		}
	);
	it('preserves explicit numeric zero and reports an all-empty response as unavailable', () => {
		expect(
			parsePriceHistory(
				request,
				fidelity({ prices: [{ date: '2024-03-04', nav: '0.00' }] }),
				fetchedAt
			).observations[0].price
		).toBe('0.00');
		expect(
			parsePriceHistory(request, fidelity({ prices: [{ date: '2024-03-04', nav: '' }] }), fetchedAt)
		).toMatchObject({ status: 'unavailable', reason: 'no-observations' });
	});
	it('rejects identity mismatch, errors, duplicate dates, and provider currency mismatch', () => {
		for (const payload of [
			fidelity({ fundNo: '654321' }),
			fidelity({ status: 'error' }),
			fidelity({
				prices: [
					{ date: '2024-03-04', nav: '1' },
					{ date: '2024-03-04', nav: '2' }
				]
			}),
			fidelity({ currency: 'EUR' })
		]) {
			expect(parsePriceHistory(request, payload, fetchedAt).status).toBe('unavailable');
		}
	});
	it('preserves matching reported currency provenance', () => {
		const result = parsePriceHistory(request, fidelity({ currency: 'USD' }), fetchedAt);
		expect(result.observations[0]).toMatchObject({ currency: 'USD', currencySource: 'provider' });
	});
	it('filters the requested interval without losing the provider as-of date', () => {
		const result = parsePriceHistory({ ...request, end: '2024-02-29' }, fidelity(), fetchedAt);
		expect(result.observations.map((p) => p.date)).toEqual(['2024-02-29']);
		expect(result.sourceAsOf).toBe('2024-03-04');
	});
});
describe('Alpha Vantage raw daily observations', () => {
	it('uses raw close, preserves publisher date/timezone, and never substitutes adjusted close', () => {
		const payload = alpha();
		(payload['Time Series (Daily)']['2024-03-04'] as Record<string, string>)['5. adjusted close'] =
			'999';
		const result = parsePriceHistory(alphaRequest, payload, fetchedAt);
		expect(result.observations.at(-1)).toMatchObject({
			price: '12.3400',
			basis: 'raw-close',
			currencySource: 'mapping'
		});
		expect(result).toMatchObject({
			sourceAsOf: '2024-03-04',
			sourceTimeZone: 'US/Eastern',
			fetchedAt,
			completeness: 'unverified'
		});
	});
	it('rejects adjusted-only data, wrong identity, absent metadata, and ambiguous publisher times', () => {
		for (const payload of [
			alpha({ 'Time Series (Daily)': { '2024-03-04': { '5. adjusted close': '1' } } }),
			alpha({
				'Meta Data': {
					'2. Symbol': 'OTHER',
					'3. Last Refreshed': '2024-03-04',
					'5. Time Zone': 'US/Eastern'
				}
			}),
			alpha({ 'Meta Data': null }),
			alpha({
				'Meta Data': {
					'2. Symbol': 'TEST.X',
					'3. Last Refreshed': '2024-03-04 12:00:00',
					'5. Time Zone': 'US/Eastern'
				}
			})
		])
			expect(parsePriceHistory(alphaRequest, payload, fetchedAt).status).toBe('unavailable');
	});
	it.each([
		{ Information: 'premium or quota' },
		{ Note: 'limit' },
		{ 'Error Message': 'invalid' },
		'Access denied',
		'<html>Login</html>'
	])('rejects provider error payloads', (payload) => {
		expect(parsePriceHistory(alphaRequest, payload, fetchedAt)).toMatchObject({
			status: 'unavailable',
			observations: []
		});
	});
	it('reports an interval outside the returned compact history without backfilling', () => {
		const result = parsePriceHistory(
			{ ...alphaRequest, start: '2020-01-01', end: '2020-02-01' },
			alpha(),
			fetchedAt
		);
		expect(result).toMatchObject({
			status: 'unavailable',
			reason: 'no-observations',
			gaps: [{ start: '2020-01-01', end: '2020-02-01', reason: 'outside-returned-range' }]
		});
	});
});
describe('request boundary', () => {
	it.each([
		{ start: '2024-02-30' },
		{ start: '2024-03-05' },
		{ currency: 'ZZZ' },
		{ currency: 'usd' },
		{ identifier: '123bad' },
		{ instrumentId: '' }
	])('rejects malformed request fields', (invalid) => {
		expect(parsePriceHistory({ ...request, ...invalid }, fidelity(), fetchedAt)).toMatchObject({
			status: 'unavailable',
			reason: 'invalid-request'
		});
	});
	it('rejects invalid fetch timestamps and unknown providers', () => {
		expect(parsePriceHistory(request, fidelity(), '2024-02-30T00:00:00Z').status).toBe(
			'unavailable'
		);
		expect(
			parsePriceHistory(
				{ ...request, provider: 'unknown' } as unknown as PriceRequest,
				fidelity(),
				fetchedAt
			).status
		).toBe('unavailable');
	});
	it('keeps Stooq disabled until machine transport and adjustment basis are verified', () => {
		expect(
			parsePriceHistory(
				{ ...request, provider: 'stooq', identifier: 'TEST.US' },
				fidelity(),
				fetchedAt
			)
		).toMatchObject({
			status: 'unavailable',
			reason: 'provider-disabled',
			observations: [],
			detail:
				'Stooq CSV returned HTTP 404 outside the browser and HTTP 200 Access denied in the browser; the raw-price adjustment basis is unverified.'
		});
	});
});

it('does not expose object prototype fields as a source URL for an invalid provider', () => {
	for (const provider of ['constructor', '__proto__']) {
		expect(
			parsePriceHistory({ ...request, provider } as PriceRequest, fidelity(), fetchedAt)
		).toMatchObject({ status: 'unavailable', reason: 'invalid-request', sourceUrl: null });
	}
});
