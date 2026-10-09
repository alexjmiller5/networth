import { json, error } from '@sveltejs/kit';
import { env as privateEnv } from '$env/dynamic/private';
import type { RequestHandler } from './$types';
import { pullNativeTable } from '$lib/server/native-finance';
import { assembleInvestments } from '$lib/finance/investments';

const TABLES = {
	investment_instruments: [
		'id',
		'account_id',
		'provider_source',
		'provider_account_id',
		'provider_plan_id',
		'native_id_kind',
		'native_security_id',
		'representation',
		'native_label',
		'ticker',
		'share_class',
		'identity_observed_at',
		'deleted_at'
	],
	investment_observations: [
		'id',
		'instrument_id',
		'metric',
		'exact_amount',
		'currency',
		'value_status',
		'missing_reason',
		'price_kind',
		'source_date',
		'source_at',
		'time_basis',
		'quote_delay_seconds',
		'captured_at',
		'capture_key',
		'supersedes_id',
		'deleted_at'
	]
};
export const GET: RequestHandler = async ({ platform, fetch }) => {
	const env = { ...privateEnv, ...platform?.env } as {
		SOMA_HUB_URL?: string;
		SOMA_HUB_TOKEN?: string;
	};
	const hub = env.SOMA_HUB_URL?.replace(/\/$/, '');
	const token = env.SOMA_HUB_TOKEN;
	if (!hub || !token) throw error(503, 'Investment observations are not configured yet.');
	try {
		const [instruments, observations] = await Promise.all(
			Object.entries(TABLES).map(([table, columns]) =>
				pullNativeTable(hub, token, table, columns, fetch)
			)
		);
		return json(
			assembleInvestments(instruments.rows, observations.rows, {
				complete: instruments.complete && observations.complete,
				asOf: new Date().toISOString().slice(0, 10)
			}),
			{ headers: { 'cache-control': 'private, no-store' } }
		);
	} catch {
		throw error(502, 'Investment observations could not be loaded. Try refreshing.');
	}
};
