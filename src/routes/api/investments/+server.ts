import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { estateSource, readEstate } from '$lib/server/estate';
import { assembleInvestments } from '$lib/finance/investments';

export const GET: RequestHandler = async ({ platform, fetch }) => {
	const source = estateSource({ platform, fetch });
	if (!source) throw error(503, 'Investment observations are not configured yet.');
	try {
		const { rows, complete } = await readEstate(source, [
			'investment_instruments',
			'investment_observations'
		]);
		return json(
			assembleInvestments(rows.investment_instruments, rows.investment_observations, {
				complete,
				asOf: new Date().toISOString().slice(0, 10)
			}),
			{ headers: { 'cache-control': 'private, no-store' } }
		);
	} catch {
		throw error(502, 'Investment observations could not be loaded. Try refreshing.');
	}
};
