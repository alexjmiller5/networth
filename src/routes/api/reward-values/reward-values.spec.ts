import { expect, it } from 'vitest';
import { GET, PUT } from './+server';
import { sqliteD1 } from '$lib/server/sqlite-d1';
type Event = Parameters<typeof PUT>[0];
const origin = 'https://networth.example';
function setup() {
	const { db } = sqliteD1('migrations/0002_reward_values.sql');
	const call = (handler: typeof PUT, body?: unknown, headers: Record<string, string> = {}) =>
		handler({
			platform: { env: { MARKERS_DB: db } },
			url: new URL(`${origin}/api/reward-values`),
			request: new Request(`${origin}/api/reward-values`, {
				method: body === undefined ? 'GET' : 'PUT',
				headers: { origin, 'content-type': 'application/json', ...headers },
				body:
					body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
			})
		} as unknown as Event);
	return { call };
}
it('creates, revises and clears one owner value per program with revision checks', async () => {
	const { call } = setup();
	const created = await call(PUT, { program_id: 'p', value_per_unit: '0.015', revision: null });
	expect(created.status).toBe(200);
	expect(await created.json()).toEqual({ program_id: 'p', value_per_unit: '0.015', revision: 1 });
	expect(
		(await call(PUT, { program_id: 'p', value_per_unit: '0.02', revision: null })).status
	).toBe(409);
	expect((await call(PUT, { program_id: 'p', value_per_unit: '0.02', revision: 7 })).status).toBe(
		409
	);
	const revised = await call(PUT, { program_id: 'p', value_per_unit: '0.02', revision: 1 });
	expect(await revised.json()).toMatchObject({ value_per_unit: '0.02', revision: 2 });
	expect(await (await call(GET)).json()).toEqual({
		values: [{ program_id: 'p', value_per_unit: '0.02', revision: 2 }]
	});
	expect((await call(PUT, { program_id: 'p', value_per_unit: null, revision: 2 })).status).toBe(
		204
	);
	expect(await (await call(GET)).json()).toEqual({ values: [] });
});
it.each([
	{ program_id: 'p', value_per_unit: '-1', revision: null },
	{ program_id: 'p', value_per_unit: '1.50', revision: null },
	{ program_id: 'p', value_per_unit: '1e3', revision: null },
	{ program_id: '', value_per_unit: '1', revision: null },
	{ program_id: 'p', value_per_unit: '1', revision: 0 },
	{ program_id: 'p', value_per_unit: '1', revision: null, extra: true }
])('rejects invalid value %j', async (body) => {
	expect((await setup().call(PUT, body)).status).toBe(400);
});
it('rejects foreign-origin and non-JSON writes', async () => {
	const { call } = setup();
	const body = { program_id: 'p', value_per_unit: '1', revision: null };
	expect((await call(PUT, body, { origin: 'https://evil.example' })).status).toBe(403);
	expect((await call(PUT, body, { 'content-type': 'text/plain' })).status).toBe(415);
	expect((await call(PUT, '{')).status).toBe(400);
});
