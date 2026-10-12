import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { assembleBenefits } from '$lib/finance/benefits';
import { estateSource, readEstate } from '$lib/server/estate';

export const GET: RequestHandler = async ({ platform, fetch }) => {
	const source = estateSource({ platform, fetch });
	if (!source) throw error(503, 'Benefits are not configured yet.');
	try {
		const { rows } = await readEstate(source, ['benefit_plans', 'benefit_snapshots']);
		return json(assembleBenefits(rows.benefit_plans, rows.benefit_snapshots), {
			headers: { 'cache-control': 'private, no-store' }
		});
	} catch {
		// Source evidence, raw validation details, and credentials remain server-side.
		throw error(502, 'Benefits could not be loaded. Try refreshing.');
	}
};
