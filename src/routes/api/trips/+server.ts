import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { estateSource } from '$lib/server/estate';
import { readTrips } from '$lib/server/trips';
export const GET: RequestHandler = async ({ platform, fetch }) => {
	const source = estateSource({ platform, fetch });
	if (!source) throw error(503, 'Trip data is not configured.');
	const data = await readTrips(source);
	if (data.unavailable) throw error(503, 'Trip information is unavailable. Try refreshing.');
	return json(data, { headers: { 'cache-control': 'private, no-store' } });
};
