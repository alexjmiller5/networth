type NativeRow = Record<string, unknown>;

export async function pullNativeTable(
	hub: string,
	token: string,
	table: string,
	columns: string[],
	fetchFn: typeof fetch
) {
	const rows: NativeRow[] = [];
	let after = '';
	let complete = true;
	const signal = AbortSignal.timeout(20_000);
	while (true) {
		const response = await fetchFn(`${hub}/v1/rows/pull`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({ table, columns, since: '', ...(after ? { after, limit: 200 } : {}) }),
			signal,
			redirect: 'manual'
		});
		if (!response.ok || response.redirected) throw new Error('Hub read failed');
		const body: unknown = await response.json();
		if (
			!body ||
			typeof body !== 'object' ||
			!('rows' in body) ||
			!Array.isArray(body.rows) ||
			body.rows.some((r) => !r || typeof r !== 'object' || Array.isArray(r))
		)
			throw new Error('Invalid hub response');
		const cursor = 'next_cursor' in body ? body.next_cursor : null;
		if (cursor != null && (typeof cursor !== 'string' || cursor <= after || !body.rows.length))
			throw new Error('Invalid hub cursor');
		for (const row of body.rows) rows.push(row);
		if (cursor == null) return { rows, complete };
		// ID pagination has no snapshot token. A correction inserted behind the cursor could be missed.
		complete = false;
		after = cursor;
	}
}
