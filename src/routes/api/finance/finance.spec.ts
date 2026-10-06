import { describe, expect, it, vi } from 'vitest';
import { GET } from './+server';
import type { Estate } from '$lib/finance/assemble';

const environment = { LIFE_HUB_URL: 'https://hub.example', LIFE_HUB_TOKEN: 'test-read-token' };
const event = (fetch: typeof globalThis.fetch, env = environment) =>
	({ fetch, platform: { env } }) as unknown as Parameters<typeof GET>[0];

describe('finance endpoint', () => {
	it('requires the configured hub and token before making requests', async () => {
		const fetch = vi.fn();
		await expect(GET(event(fetch, { ...environment, LIFE_HUB_TOKEN: '' }))).rejects.toMatchObject({
			status: 503
		});
		await expect(GET(event(fetch, { ...environment, LIFE_HUB_URL: '' }))).rejects.toMatchObject({
			status: 503
		});
		expect(fetch).not.toHaveBeenCalled();
	});

	it('rejects malformed upstream data instead of returning a successful empty estate', async () => {
		const fetch = vi.fn(async () => new Response(JSON.stringify({ unexpected: [] })));
		await expect(GET(event(fetch))).rejects.toMatchObject({ status: 502 });
	});

	it('rejects redirects without forwarding the hub credential', async () => {
		const fetch = vi.fn(
			async () =>
				new Response(null, { status: 302, headers: { location: 'https://other.example' } })
		);
		await expect(GET(event(fetch))).rejects.toMatchObject({ status: 502 });
		for (const [url, init] of fetch.mock.calls as unknown as [string, RequestInit][]) {
			expect(url).toBe(`${environment.LIFE_HUB_URL}/v1/rows/pull`);
			expect(init.redirect).toBe('manual');
		}
	});

	it('contains network and upstream errors without revealing their bodies', async () => {
		const fetch = vi.fn().mockRejectedValue(new Error('internal credential-bearing error'));
		await expect(GET(event(fetch))).rejects.toMatchObject({
			status: 502,
			body: { message: 'Finance data could not be loaded. Try refreshing.' }
		});
	});

	it('keeps the response private and does not expose the hub credential', async () => {
		const fetch = vi.fn(async () => new Response(JSON.stringify({ rows: [] })));
		const response = await GET(event(fetch));
		expect(response.headers.get('cache-control')).toBe('private, no-store');
		expect(await response.text()).not.toContain(environment.LIFE_HUB_TOKEN);
	});
});

it('never queries a retired source table even when its retained registry history exists', async () => {
	const requested: string[] = [];
	const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
		const { table } = JSON.parse(String(init?.body));
		requested.push(table);
		if (table === 'txns_retired') throw new Error('retired source must not be queried');
		const rows =
			table === 'accounts'
				? [{ id: 'retired-account', source: 'retired', deleted_at: '2030-01-01T00:00:00.000Z' }]
				: [];
		return Response.json({ rows });
	});
	const response = await GET(event(fetch));
	expect(response.status).toBe(200);
	expect(requested).not.toContain('txns_retired');
	expect(await response.json()).toMatchObject({ accounts: [] });
});

const account = (id: string, source = 'bank') => ({
	id,
	bank: 'Example Bank',
	name: id,
	type: 'checking',
	source,
	currency: 'USD'
});
const transaction = (id: string, amount: number) => ({
	id,
	account_id: 'account-1',
	date: '2026-01-05',
	amount,
	status: 'posted'
});

describe('hub pagination', () => {
	it('assembles all account and transaction pages using the same allowlisted request and destination', async () => {
		const requests: Record<string, unknown>[] = [];
		const fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
			expect(url).toBe('https://hub.example/v1/rows/pull');
			expect(init?.redirect).toBe('manual');
			expect(init?.headers).toEqual({
				'content-type': 'application/json',
				authorization: 'Bearer test-read-token'
			});
			const body = JSON.parse(String(init?.body));
			expect(body.since).toBe('');
			expect(body.limit).toBe(body.after ? 200 : undefined);
			requests.push(body);
			if (body.table === 'accounts') {
				if (!body.after)
					return Response.json({ rows: [account('account-1')], next_cursor: 'account-1' });
				expect(body.after).toBe('account-1');
				return Response.json({ rows: [account('account-2', 'second')], next_cursor: null });
			}
			if (body.table === 'txns_bank') {
				if (!body.after)
					return Response.json({ rows: [transaction('txn-1', 10)], next_cursor: 'txn-1' });
				if (body.after === 'txn-1')
					return Response.json({ rows: [transaction('txn-2', -3)], next_cursor: 'txn-2' });
				expect(body.after).toBe('txn-2');
				return Response.json({ rows: [transaction('txn-3', 2)], next_cursor: null });
			}
			return Response.json({ rows: [] });
		});
		const response = await GET(event(fetch));
		const estate = (await response.json()) as Estate;
		expect(estate.accounts.map((row: { id: string }) => row.id)).toEqual([
			'account-1',
			'account-2'
		]);
		expect(estate.txns.map((row: { amount: number }) => row.amount)).toEqual([10, -3, 2]);
		const bodies = requests;
		expect(bodies.some((body) => body.table === 'txns_second')).toBe(true);
		for (const table of ['accounts', 'txns_bank']) {
			const pages = bodies.filter((body) => body.table === table);
			for (const page of pages) expect(page.columns).toEqual(pages[0].columns);
		}
		expect(bodies.find((body) => body.table === 'txns_bank')?.columns).toEqual([
			'id',
			'account_id',
			'date',
			'amount',
			'status',
			'synthetic',
			'qty',
			'ticker',
			'deleted_at'
		]);
	});

	it.each([
		['non-string', { rows: [account('account-2')], next_cursor: 4 }],
		['empty cursor', { rows: [account('account-2')], next_cursor: '' }],
		['repeated cursor', { rows: [account('account-2')], next_cursor: 'cursor-2' }],
		['backward cursor', { rows: [account('account-2')], next_cursor: 'cursor-1' }],
		['empty continuing page', { rows: [], next_cursor: 'cursor-3' }],
		['missing rows', { next_cursor: null }],
		['malformed row', { rows: [null], next_cursor: null }]
	])('rejects the entire response for a %s after a valid first page', async (_label, badPage) => {
		let calls = 0;
		const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
			const { table } = JSON.parse(String(init?.body));
			if (table !== 'accounts') return Response.json({ rows: [] });
			calls++;
			if (calls === 1)
				return Response.json({ rows: [account('account-1')], next_cursor: 'cursor-2' });
			if (calls > 2) throw new Error('pagination should already have stopped');
			return Response.json(badPage);
		});
		await expect(GET(event(fetch))).rejects.toMatchObject({
			status: 502,
			body: { message: 'Finance data could not be loaded. Try refreshing.' }
		});
		expect(calls).toBe(2);
	});

	it('rejects later-page redirects without following a cursor as a URL', async () => {
		let calls = 0;
		const fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
			expect(url).toBe('https://hub.example/v1/rows/pull');
			expect(init?.redirect).toBe('manual');
			const body = JSON.parse(String(init?.body));
			if (body.table !== 'accounts') return Response.json({ rows: [] });
			calls++;
			if (calls === 1)
				return Response.json({
					rows: [account('account-1')],
					next_cursor: 'https://other.example/credential-trap'
				});
			expect(body.after).toBe('https://other.example/credential-trap');
			return new Response(null, { status: 302, headers: { location: 'https://other.example' } });
		});
		await expect(GET(event(fetch))).rejects.toMatchObject({ status: 502 });
		expect(calls).toBe(2);
	});

	it('accepts an empty terminal page and legacy complete responses', async () => {
		let calls = 0;
		const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body));
			if (body.table !== 'accounts') return Response.json({ rows: [] });
			calls++;
			return Response.json(
				body.after
					? { rows: [], next_cursor: null }
					: { rows: [account('account-1')], next_cursor: 'cursor-1' }
			);
		});
		expect(await (await GET(event(fetch))).json()).toMatchObject({
			accounts: [{ id: 'account-1' }]
		});
		expect(calls).toBe(2);
	});
});

// The hub supports complete-table responses when limit is omitted. Splitting a
// cold read into many serial pages can exceed both endpoint and browser deadlines.
it('loads a large complete table without forcing serial small-page round trips', async () => {
	const requests: string[] = [];
	const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body));
		requests.push(body.table);
		expect(body.limit).toBeUndefined();
		if (body.table === 'accounts') return Response.json({ rows: [account('account-1')] });
		if (body.table === 'txns_bank')
			return Response.json({
				rows: Array.from({ length: 1001 }, (_, i) => transaction(`txn-${i}`, 1))
			});
		return Response.json({ rows: [] });
	});
	const data = (await (await GET(event(fetch))).json()) as Estate;
	expect(data.txns).toHaveLength(1001);
	expect(requests.filter((table) => table === 'txns_bank')).toHaveLength(1);
});
