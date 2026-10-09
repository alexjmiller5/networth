import { json, error } from '@sveltejs/kit';
import { env as privateEnv } from '$env/dynamic/private';
import type { RequestHandler } from './$types';
import { assembleBenefits, BENEFIT_METRICS } from '$lib/finance/benefits';

const TABLES = {
	benefit_plans: [
		'id',
		'provider',
		'native_plan_id',
		'name',
		'kind',
		'currency',
		'status',
		'deleted_at'
	],
	benefit_snapshots: [
		'id',
		'plan_id',
		'plan_year',
		'observed_at',
		'source_as_of',
		'currency',
		...Object.keys(BENEFIT_METRICS),
		'eligibility_status',
		'vested_visibility',
		'source_record_ref',
		'deleted_at'
	]
};
async function pull(
	hub: string,
	token: string,
	table: string,
	columns: string[],
	fetchFn: typeof fetch
): Promise<Record<string, unknown>[]> {
	const rows: Record<string, unknown>[] = [];
	let after = '';
	const signal = AbortSignal.timeout(20_000);
	while (true) {
		const response = await fetchFn(`${hub}/v1/rows/pull`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			// The hub's supported complete-table read avoids serial round trips on cold loads.
			// Continue with bounded pages only when the hub actually returns a cursor.
			body: JSON.stringify({ table, columns, since: '', ...(after ? { after, limit: 200 } : {}) }),
			signal,
			redirect: 'manual'
		});
		if (!response.ok || response.redirected) throw new Error('Hub request failed');
		const body: unknown = await response.json();
		if (
			!body ||
			typeof body !== 'object' ||
			!('rows' in body) ||
			!Array.isArray(body.rows) ||
			body.rows.some((row) => !row || typeof row !== 'object' || Array.isArray(row))
		)
			throw new Error('Invalid hub response');
		const cursor = 'next_cursor' in body ? body.next_cursor : null;
		if (cursor != null && (typeof cursor !== 'string' || cursor <= after || !body.rows.length))
			throw new Error('Invalid hub cursor');
		for (const row of body.rows) rows.push(row);
		if (cursor == null) return rows;
		after = cursor;
	}
}
export const GET: RequestHandler = async ({ platform, fetch }) => {
	const env = { ...privateEnv, ...platform?.env } as {
		SOMA_HUB_URL?: string;
		SOMA_HUB_TOKEN?: string;
	};
	const hub = env.SOMA_HUB_URL?.replace(/\/$/, '');
	const token = env.SOMA_HUB_TOKEN;
	if (!hub || !token) throw error(503, 'Benefits are not configured yet.');
	try {
		const [plans, snapshots] = await Promise.all(
			Object.entries(TABLES).map(([table, columns]) => pull(hub, token, table, columns, fetch))
		);
		return json(assembleBenefits(plans, snapshots), {
			headers: { 'cache-control': 'private, no-store' }
		});
	} catch {
		// Source evidence, raw validation details, and credentials remain server-side.
		throw error(502, 'Benefits could not be loaded. Try refreshing.');
	}
};
