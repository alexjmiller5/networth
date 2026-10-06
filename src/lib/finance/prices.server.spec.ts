import { describe, expect, it, vi } from 'vitest';
import { fetchPriceHistory } from './prices.server';
import type { PriceRequest } from './prices';

const request: PriceRequest = {
	provider: 'fidelity',
	instrumentId: 'instrument-1',
	identifier: '123456',
	currency: 'USD',
	start: '2024-02-28',
	end: '2024-03-04'
};
const now = () => new Date('2024-03-05T01:02:03.000Z');
const payload = {
	status: 'success',
	fundNo: '123456',
	prices: [{ date: '2024-03-04', nav: '12.3400' }]
};
const alpha: PriceRequest = { ...request, provider: 'alphavantage', identifier: 'TEST.X' };
const syntheticKey = 'synthetic-test-credential';

describe('server price transport', () => {
	it('posts only the mapped issuer ID and inclusive interval to the public NAV endpoint', async () => {
		const fetcher = vi.fn<typeof fetch>(async (url, init) => {
			expect(String(url)).toBe(
				'https://institutional.fidelity.com/app/funds/historicalFundPricing'
			);
			expect(init).toMatchObject({
				method: 'POST',
				redirect: 'manual',
				credentials: 'omit',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }
			});
			expect(new URLSearchParams(init?.body as string)).toEqual(
				new URLSearchParams({ fundNo: '123456', startDate: '02/28/2024', endDate: '03/04/2024' })
			);
			expect(init?.signal).toBeInstanceOf(AbortSignal);
			return Response.json(payload);
		});
		const result = await fetchPriceHistory(request, { fetcher, now });
		expect(result).toMatchObject({
			status: 'available',
			fetchedAt: now().toISOString(),
			observations: [{ price: '12.3400', basis: 'raw-nav' }]
		});
		expect(fetcher).toHaveBeenCalledOnce();
	});
	it('uses only compact raw daily data with the caller key and never returns that key', async () => {
		const fetcher = vi.fn<typeof fetch>(async (input, init) => {
			const url = new URL(String(input));
			expect(url.origin + url.pathname).toBe('https://www.alphavantage.co/query');
			expect(Object.fromEntries(url.searchParams)).toEqual({
				function: 'TIME_SERIES_DAILY',
				symbol: 'TEST.X',
				outputsize: 'compact',
				datatype: 'json',
				apikey: syntheticKey
			});
			expect(init).toMatchObject({ redirect: 'manual', credentials: 'omit' });
			return Response.json({
				'Meta Data': {
					'2. Symbol': 'TEST.X',
					'3. Last Refreshed': '2024-03-04',
					'5. Time Zone': 'US/Eastern'
				},
				'Time Series (Daily)': { '2024-03-04': { '4. close': '12.34' } }
			});
		});
		const result = await fetchPriceHistory(alpha, { fetcher, now, alphaVantageKey: syntheticKey });
		expect(result.status).toBe('available');
		expect(JSON.stringify(result)).not.toContain(syntheticKey);
	});
	it.each([undefined, '', '   '])(
		'does not issue a request without a usable caller key',
		async (alphaVantageKey) => {
			const fetcher = vi.fn<typeof fetch>();
			expect(await fetchPriceHistory(alpha, { fetcher, now, alphaVantageKey })).toMatchObject({
				status: 'unavailable',
				reason: 'missing-key'
			});
			expect(fetcher).not.toHaveBeenCalled();
		}
	);
	it('does not request disabled providers or invalid mappings', async () => {
		const fetcher = vi.fn<typeof fetch>();
		for (const input of [
			{ ...request, provider: 'stooq' as const, identifier: 'TEST.US' },
			{ ...request, currency: 'ZZZ' }
		])
			expect((await fetchPriceHistory(input, { fetcher, now })).status).toBe('unavailable');
		expect(fetcher).not.toHaveBeenCalled();
	});
	it.each([
		() => new Response('Access denied', { status: 200 }),
		() => Response.json({ Information: 'quota' }),
		() => Response.json({ ...payload, fundNo: '654321' }),
		() => Response.json(payload, { status: 429 }),
		() => new Response(null, { status: 302, headers: { Location: 'https://other.example' } }),
		() => new Response('<html>Login</html>', { headers: { 'Content-Type': 'text/html' } }),
		() => new Response('not json', { headers: { 'Content-Type': 'application/json' } })
	])('never mistakes transport or provider failures for prices', async (response) => {
		expect(
			await fetchPriceHistory(request, {
				fetcher: vi.fn<typeof fetch>(async () => response()),
				now
			})
		).toMatchObject({ status: 'unavailable', observations: [] });
	});
	it('sanitizes transport errors instead of returning credential-bearing URLs', async () => {
		const fetcher = vi.fn<typeof fetch>(async () => {
			throw new Error(`failed URL with ${syntheticKey}`);
		});
		const result = await fetchPriceHistory(alpha, { fetcher, now, alphaVantageKey: syntheticKey });
		expect(result).toMatchObject({ status: 'unavailable', reason: 'transport-error' });
		expect(JSON.stringify(result)).not.toContain(syntheticKey);
	});
});
