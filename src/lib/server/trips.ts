import type { EstateSource, HubRow } from './estate';
import { readEstate } from './estate';
import { tripRegistry, type TripData } from '$lib/finance/trips';
export async function readTripClaims(
	source: Pick<EstateSource, 'hub' | 'token' | 'fetch'>
): Promise<HubRow[]> {
	const records: HubRow[] = [];
	const cursors = new Set<string>();
	const entries = new Set<string>();
	let cursor: string | undefined;
	let bytes = 0;
	let limit = 20;
	const signal = AbortSignal.timeout(20000);
	for (let page = 0; page < 20; page++) {
		const url = new URL(source.hub + '/v1/streams/location_trips/records');
		url.searchParams.set('limit', String(limit));
		if (cursor) url.searchParams.set('cursor', cursor);
		const response = await source.fetch(url.toString(), {
			headers: { Authorization: 'Bearer ' + source.token },
			redirect: 'manual',
			signal
		});
		if (response.status === 413 && limit > 1) {
			limit = 1;
			continue;
		}
		if (!response.ok) throw Error('Trip stream read unavailable');
		const text = await response.text();
		bytes += new TextEncoder().encode(text).length;
		if (bytes > 4000000) throw Error('Trip stream read limit');
		const body = JSON.parse(text);
		if (
			!Array.isArray(body.entries) ||
			body.entries.length > limit ||
			!(body.next_cursor === null || (typeof body.next_cursor === 'string' && body.next_cursor))
		)
			throw Error('Invalid trip page');
		for (const entry of body.entries) {
			if (
				typeof entry?.id !== 'string' ||
				!entry.id ||
				typeof entry.body !== 'string' ||
				entries.has(entry.id)
			)
				throw Error('Invalid trip entry');
			entries.add(entry.id);
			const value = JSON.parse(entry.body);
			for (const row of Array.isArray(value) ? value : [value]) {
				if (!row || typeof row !== 'object' || Array.isArray(row))
					throw Error('Invalid trip record');
				records.push(row);
			}
			if (records.length > 10000) throw Error('Trip stream record limit');
		}
		if (body.next_cursor === null) return records;
		if (cursors.has(body.next_cursor)) throw Error('Repeated trip cursor');
		cursors.add(body.next_cursor);
		cursor = body.next_cursor;
	}
	throw Error('Trip stream page limit');
}
export async function readTrips(source: EstateSource): Promise<TripData> {
	try {
		const [{ rows }, claims] = await Promise.all([
			readEstate(source, ['trips'], { slices: ['trip_settlements'] }),
			readTripClaims(source)
		]);
		const settlements: Record<string, string[]> = {};
		for (const row of rows.trip_settlements ?? []) {
			if (row.deleted_at != null) continue;
			if (
				typeof row.from_ref !== 'string' ||
				!/^[a-z][a-z0-9_]*:.+/.test(row.from_ref) ||
				typeof row.to_ref !== 'string' ||
				!row.to_ref
			)
				throw Error('Invalid settlement identity');
			(settlements[row.from_ref] ??= []).push(row.to_ref);
		}
		return { trips: tripRegistry(rows.trips ?? [], claims), settlements };
	} catch {
		return { trips: [], settlements: {}, unavailable: true };
	}
}
