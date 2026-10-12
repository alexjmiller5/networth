// Test-only: an in-memory Soma hub answering the reads `estate.ts` makes -
// `/v1/cursor` marks and `/v1/rows/pull` (single or batched; since, where,
// limit, after), projecting the asked columns as the real hub does.
import { vi } from 'vitest';

type Row = Record<string, unknown>;
type Pull = {
	table: string;
	columns: string[];
	since?: string;
	where?: Record<string, unknown>;
	limit?: number;
	after?: string;
};

export const at = (n: number) => `2026-01-01T00:00:${String(n).padStart(2, '0')}.000Z`;

export function fakeHub(tables: Record<string, Row[]> = {}, options: { batchRows?: number } = {}) {
	const data = new Map<string, Map<string, Row>>();
	// Every hub row has an id and an arrival stamp; fixtures may leave them out.
	const put = (table: string, row: Row, hubAt = at(1)) => {
		if (!data.has(table)) data.set(table, new Map());
		data.get(table)!.set(String(row.id), { deleted_at: null, ...row, hub_at: hubAt });
	};
	for (const [table, rows] of Object.entries(tables)) {
		data.set(table, new Map());
		rows.forEach((row, i) => put(table, { id: `${table}-${i}`, ...row }));
	}
	const read = ({ table, columns, since = '', where = {}, limit, after }: Pull) => {
		const rows = [...(data.get(table)?.values() ?? [])]
			.filter((r) => since === '' || String(r.hub_at) >= since)
			.filter((r) => Object.entries(where).every(([col, value]) => r[col] === value))
			.filter((r) => after === undefined || String(r.id) > after)
			.sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1))
			.slice(0, limit);
		const page = rows.map((r) => Object.fromEntries(columns.map((c) => [c, r[c] ?? null])));
		if (limit === undefined) return { rows: page };
		return { rows: page, next_cursor: page.length === limit ? String(rows.at(-1)!.id) : null };
	};
	const requests: {
		url: string;
		path: string;
		body: Record<string, unknown>;
		init: RequestInit;
	}[] = [];
	const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input),
			path = new URL(url).pathname,
			body = JSON.parse(String(init?.body));
		requests.push({ url, path, body, init: init ?? {} });
		if (path === '/v1/cursor') {
			const marks: Record<string, string> = {},
				counts: Record<string, number> = {};
			for (const table of body.tables as string[]) {
				const rows = [...(data.get(table)?.values() ?? [])];
				marks[table] = rows.reduce(
					(top, r) => (String(r.hub_at) > top ? String(r.hub_at) : top),
					''
				);
				if (marks[table]) counts[table] = rows.filter((r) => r.hub_at === marks[table]).length;
			}
			return Response.json({
				tables: marks,
				at_mark: counts,
				pull_batch: { items: 50, rows: options.batchRows ?? 5000, bytes: 4 << 20 }
			});
		}
		if (path === '/v1/rows/pull')
			return Response.json(
				body.batch ? { batch: (body.batch as Pull[]).map(read) } : read(body as Pull)
			);
		return new Response('not found', { status: 404 });
	});
	/** Every table read, batched or single, in request order. */
	const pulls = () =>
		requests.flatMap((r) =>
			r.path === '/v1/rows/pull' ? ((r.body.batch as Pull[] | undefined) ?? [r.body as Pull]) : []
		);
	return { fetch: fetch as unknown as typeof globalThis.fetch, requests, pulls, put };
}
