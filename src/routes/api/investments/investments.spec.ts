import { expect, it, vi } from 'vitest';
import { GET } from './+server';
import type { Investments } from '$lib/finance/investments';
const environment = { SOMA_HUB_URL: 'https://hub.example', SOMA_HUB_TOKEN: 'synthetic-token' };
const event = (fetch: typeof globalThis.fetch, env = environment) =>
	({
		fetch,
		platform: { env },
		url: new URL('https://site.example/api/investments')
	}) as unknown as Parameters<typeof GET>[0];
const instrument = {
	id: 'instrument',
	account_id: 'account',
	provider_source: 'provider',
	provider_plan_id: 'plan',
	native_id_kind: 'plan_fund_code',
	native_security_id: '001',
	representation: 'security',
	identity_observed_at: '2024-01-03T00:00:00.000Z'
};
const observation = {
	id: 'observation',
	instrument_id: 'instrument',
	metric: 'unit_price',
	exact_amount: '12.5',
	currency: 'USD',
	value_status: 'reported',
	price_kind: 'nav',
	source_date: '2024-01-02',
	time_basis: 'nav_as_of',
	captured_at: '2024-01-03T00:00:00.000Z',
	capture_key: 'private-evidence'
};
it('uses fixed projections and server auth, strips evidence and never computes a portfolio total', async () => {
	const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
		expect(url).toBe('https://hub.example/v1/rows/pull');
		expect(init?.redirect).toBe('manual');
		expect(init?.headers).toMatchObject({ authorization: 'Bearer synthetic-token' });
		const body = JSON.parse(String(init?.body));
		expect(body.limit).toBeUndefined();
		expect(body.columns).not.toContain('raw');
		return Response.json({
			rows:
				body.table === 'investment_instruments'
					? [{ ...instrument, raw: 'private' }]
					: [observation]
		});
	});
	const response = await GET(event(fetch));
	const body = await response.text();
	expect(response.headers.get('cache-control')).toBe('private, no-store');
	expect(JSON.parse(body).instruments[0].groups[0]).toMatchObject({
		status: 'available',
		selected: { exact_amount: '12.5' }
	});
	expect(body).not.toMatch(/private-evidence|synthetic-token|"raw"|"total"/);
});
it('does not claim complete correction membership from multiple independent pages', async () => {
	const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
		const body = JSON.parse(String(init?.body));
		if (body.table === 'investment_instruments') return Response.json({ rows: [instrument] });
		return Response.json(
			body.after
				? { rows: [], next_cursor: null }
				: { rows: [observation], next_cursor: 'cursor-1' }
		);
	});
	const result = (await (await GET(event(fetch))).json()) as Investments;
	expect(result.instruments[0].groups[0]).toMatchObject({ status: 'incomplete', selected: null });
	expect(fetch).toHaveBeenCalledTimes(3);
});
it.each([
	() => new Response(null, { status: 302, headers: { location: 'https://other.example' } }),
	() => Response.json({ rows: [null] }),
	() => Response.json({ rows: [], next_cursor: 'next' }),
	() => Response.json({ rows: [instrument], next_cursor: 4 }),
	() => new Response('secret error', { status: 500 })
])('rejects malformed upstream reads without leaking diagnostics', async (response) => {
	await expect(GET(event(vi.fn(async () => response())))).rejects.toMatchObject({
		status: 502,
		body: { message: 'Investment observations could not be loaded. Try refreshing.' }
	});
});
it('does not fall back to operator auth when the consumer credential is absent', async () => {
	const fetch = vi.fn<typeof globalThis.fetch>();
	await expect(GET(event(fetch, { ...environment, SOMA_HUB_TOKEN: '' }))).rejects.toMatchObject({
		status: 503
	});
	expect(fetch).not.toHaveBeenCalled();
});
