import { expect, it, vi } from 'vitest';
import type { Benefits } from '$lib/finance/benefits';
import { GET } from './+server';
const environment = { SOMA_HUB_URL: 'https://hub.example', SOMA_HUB_TOKEN: 'synthetic-token' };
const event = (fetch: typeof globalThis.fetch, env = environment) =>
	({ fetch, platform: { env } }) as unknown as Parameters<typeof GET>[0];
const plan = {
	id: 'plan-1',
	name: 'Example plan',
	provider: 'Example provider',
	kind: 'fsa',
	currency: 'USD',
	status: 'active'
};
const snapshot = {
	id: 'obs-1',
	plan_id: 'plan-1',
	plan_year: 2024,
	observed_at: '2024-04-06T12:00:00Z',
	source_as_of: '2024-04-05',
	currency: 'USD',
	annual_election: 700,
	available_benefit: 0,
	vested_visibility: 'not_exposed',
	source_record_ref: 'private-archive-record'
};
it('reads only fixed tables and columns with the existing server credential and returns a whitelisted model', async () => {
	const bodies: Record<string, unknown>[] = [];
	const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
		expect(url).toBe('https://hub.example/v1/rows/pull');
		expect(init?.redirect).toBe('manual');
		expect(init?.headers).toMatchObject({ authorization: 'Bearer synthetic-token' });
		const body = JSON.parse(String(init?.body));
		bodies.push(body);
		expect(body.limit).toBe(body.after ? 200 : undefined);
		expect(body.since).toBe('');
		return Response.json({
			rows:
				body.table === 'benefit_plans' ? [{ ...plan, private_locator: 'never-send' }] : [snapshot]
		});
	});
	const response = await GET(event(fetch));
	const text = await response.text();
	expect(response.headers.get('cache-control')).toBe('private, no-store');
	expect(JSON.parse(text)).toMatchObject({
		plans: [{ years: [{ observations: [{ annual_election: 700, available_benefit: 0 }] }] }]
	});
	expect(text).not.toMatch(/private-archive|synthetic-token|source_record_ref|never-send/);
	expect(bodies.map((b) => b.table).sort()).toEqual(['benefit_plans', 'benefit_snapshots']);
	expect(bodies[0].columns).toEqual([
		'id',
		'provider',
		'native_plan_id',
		'name',
		'kind',
		'currency',
		'status',
		'deleted_at'
	]);
	expect(bodies[1].columns).toEqual([
		'id',
		'plan_id',
		'plan_year',
		'observed_at',
		'source_as_of',
		'currency',
		'annual_election',
		'employee_contributions',
		'claims_submitted',
		'claims_paid',
		'claims_denied',
		'available_benefit',
		'stated_notional_balance',
		'vested_balance',
		'eligibility_status',
		'vested_visibility',
		'source_record_ref',
		'deleted_at'
	]);
});
it('reads every page at the same destination with stable columns and shared request deadline', async () => {
	const previous = new Map<string, { columns: unknown; signal: unknown }>();
	const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
		expect(url).toBe('https://hub.example/v1/rows/pull');
		const body = JSON.parse(String(init?.body));
		if (!body.after) {
			previous.set(body.table, { columns: body.columns, signal: init?.signal });
			return Response.json({
				rows: body.table === 'benefit_plans' ? [plan] : [snapshot],
				next_cursor: 'cursor-1'
			});
		}
		expect(body.after).toBe('cursor-1');
		expect(body.columns).toEqual(previous.get(body.table)?.columns);
		expect(init?.signal).toBe(previous.get(body.table)?.signal);
		return Response.json({
			rows:
				body.table === 'benefit_plans'
					? [{ ...plan, id: 'plan-2' }]
					: [{ ...snapshot, id: 'obs-2', plan_id: 'plan-2' }],
			next_cursor: null
		});
	});
	const result = (await (await GET(event(fetch))).json()) as Benefits;
	expect(result.plans).toHaveLength(2);
	expect(fetch).toHaveBeenCalledTimes(4);
});
it.each([4, '', 'cursor-1', 'cursor-0'])(
	'rejects invalid or nonadvancing cursors without serving partial observations',
	async (cursor) => {
		const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
			const body = JSON.parse(String(init?.body));
			return Response.json(
				body.after
					? { rows: [snapshot], next_cursor: cursor }
					: { rows: body.table === 'benefit_plans' ? [plan] : [snapshot], next_cursor: 'cursor-1' }
			);
		});
		await expect(GET(event(fetch))).rejects.toMatchObject({
			status: 502,
			body: { message: 'Benefits could not be loaded. Try refreshing.' }
		});
	}
);
it.each([
	() => new Response(null, { status: 302, headers: { location: 'https://other.example' } }),
	() => Response.json({ rows: [null] }),
	() => Response.json({ rows: [], next_cursor: 'next' }),
	() => new Response('private provider failure', { status: 500 }),
	() => Response.json({ rows: [snapshot], next_cursor: null })
])('fails closed on malformed pages, redirects, or invalid model rows', async (response) => {
	const fetch = vi.fn<typeof globalThis.fetch>(async () => response());
	await expect(GET(event(fetch))).rejects.toMatchObject({
		status: 502,
		body: { message: 'Benefits could not be loaded. Try refreshing.' }
	});
});
it('does not fetch when the installed service credential is missing', async () => {
	const fetch = vi.fn<typeof globalThis.fetch>();
	await expect(GET(event(fetch, { ...environment, SOMA_HUB_TOKEN: '' }))).rejects.toMatchObject({
		status: 503
	});
	expect(fetch).not.toHaveBeenCalled();
});

it('accepts a large legacy complete page without a function argument limit', async () => {
	const rows = Array.from({ length: 150_000 }, () => ({
		id: 'deleted-plan',
		deleted_at: '2024-01-01'
	}));
	const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) =>
		Response.json({ rows: JSON.parse(String(init?.body)).table === 'benefit_plans' ? rows : [] })
	);
	expect(await (await GET(event(fetch))).json()).toEqual({ plans: [] });
});
