import { expect, it, vi } from 'vitest';
import type { Benefits } from '$lib/finance/benefits';
import { GET } from './+server';
import { at, fakeHub } from '$lib/server/fake-hub';
import { sqliteD1 } from '$lib/server/sqlite-d1';
const environment = { SOMA_HUB_URL: 'https://hub.example', SOMA_HUB_TOKEN: 'synthetic-token' };
const event = (fetch: typeof globalThis.fetch, env: object = environment) =>
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
	const hub = fakeHub({
		benefit_plans: [{ ...plan, private_locator: 'never-send' }],
		benefit_snapshots: [snapshot]
	});
	const response = await GET(event(hub.fetch));
	const text = await response.text();
	expect(response.headers.get('cache-control')).toBe('private, no-store');
	expect(JSON.parse(text)).toMatchObject({
		plans: [{ years: [{ observations: [{ annual_election: 700, available_benefit: 0 }] }] }]
	});
	expect(text).not.toMatch(/private-archive|synthetic-token|source_record_ref|never-send/);
	for (const { init } of hub.requests)
		expect(init.headers).toMatchObject({ Authorization: 'Bearer synthetic-token' });
	const pulls = hub.pulls();
	expect(pulls.map((p) => p.table).sort()).toEqual(['benefit_plans', 'benefit_snapshots']);
	expect(pulls.find((p) => p.table === 'benefit_plans')?.columns).toEqual([
		'id',
		'provider',
		'native_plan_id',
		'name',
		'kind',
		'currency',
		'status',
		'income_category_id',
		'deleted_at',
		'hub_at'
	]);
	expect(pulls.find((p) => p.table === 'benefit_snapshots')?.columns).toEqual([
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
		'deleted_at',
		'hub_at'
	]);
});
it('reads every page before assembling', async () => {
	const hub = fakeHub(
		{
			benefit_plans: [plan, { ...plan, id: 'plan-2' }],
			benefit_snapshots: [snapshot, { ...snapshot, id: 'obs-2', plan_id: 'plan-2' }]
		},
		{ batchRows: 2 }
	);
	const result = (await (await GET(event(hub.fetch))).json()) as Benefits;
	expect(result.plans).toHaveLength(2);
	expect(hub.pulls().length).toBeGreaterThan(2);
});
it.each([
	() => new Response(null, { status: 302, headers: { location: 'https://other.example' } }),
	() => Response.json({ batch: [{ rows: [null] }] }),
	() => new Response('private provider failure', { status: 500 })
])('fails closed on malformed pages, redirects, or upstream failures', async (response) => {
	const hub = fakeHub({ benefit_plans: [plan], benefit_snapshots: [snapshot] });
	const fetch = (async (url: string, init: RequestInit) =>
		new URL(url).pathname === '/v1/rows/pull'
			? response()
			: hub.fetch(url, init)) as typeof globalThis.fetch;
	await expect(GET(event(fetch))).rejects.toMatchObject({
		status: 502,
		body: { message: 'Benefits could not be loaded. Try refreshing.' }
	});
});
it('rejects an observation whose plan is missing instead of serving it', async () => {
	const hub = fakeHub({ benefit_plans: [], benefit_snapshots: [snapshot] });
	await expect(GET(event(hub.fetch))).rejects.toMatchObject({ status: 502 });
});
it('does not fetch when the installed service credential is missing', async () => {
	const fetch = vi.fn<typeof globalThis.fetch>();
	await expect(GET(event(fetch, { ...environment, SOMA_HUB_TOKEN: '' }))).rejects.toMatchObject({
		status: 503
	});
	expect(fetch).not.toHaveBeenCalled();
});

it('skips observations of a deleted plan, even after the deletion arrives incrementally', async () => {
	const hub = fakeHub({ benefit_plans: [plan], benefit_snapshots: [snapshot] });
	const env = {
		...environment,
		ESTATE_CACHE_DB: sqliteD1('migrations-estate-cache/0001_estate_cache.sql').db
	};
	await GET(event(hub.fetch, env));
	hub.put('benefit_plans', { ...plan, deleted_at: at(2) }, at(2));
	expect(await (await GET(event(hub.fetch, env))).json()).toEqual({ plans: [] });
});
