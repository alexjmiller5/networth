import type { FinanceRun, HostPatch } from '$lib/finance/run-contract';

type Row = Omit<FinanceRun, 'account_ids' | 'cancel_requested'> & {
	account_ids: string;
	cancel_requested: number;
};
const view = (row: Row): FinanceRun => ({
	...row,
	account_ids: JSON.parse(row.account_ids),
	cancel_requested: row.cancel_requested === 1
});
const ACTIVE = `status IN ('queued','claimed','running')`;
const DETAILS = ['tab_id', 'pane_id', 'tab_label', 'agent_name', 'agent_kind', 'summary'] as const;

export class RunBusyError extends Error {
	constructor(public active: FinanceRun) {
		super('A finance review is already active.');
	}
}
export class RunConflictError extends Error {}

export function runsDatabase(platform: App.Platform | undefined): D1Database | undefined {
	return (platform?.env as (Env & { FINANCE_RUNS_DB?: D1Database }) | undefined)?.FINANCE_RUNS_DB;
}

export class FinanceRuns {
	constructor(private db: D1Database) {}

	async get(id: string): Promise<FinanceRun | null> {
		const row = await this.db
			.prepare('SELECT * FROM finance_runs WHERE id = ?')
			.bind(id)
			.first<Row>();
		return row ? view(row) : null;
	}

	async list(limit: number): Promise<FinanceRun[]> {
		const { results } = await this.db
			.prepare('SELECT * FROM finance_runs ORDER BY created_at DESC, rowid DESC LIMIT ?')
			.bind(limit)
			.all<Row>();
		return results.map(view);
	}

	/** Idempotent per request id. The partial unique index is the one-active-run guard. */
	async create(
		input: { requestId: string; accountIds: string[] },
		now: number
	): Promise<FinanceRun> {
		const accounts = JSON.stringify(input.accountIds);
		const existing = await this.db
			.prepare('SELECT * FROM finance_runs WHERE request_id = ?')
			.bind(input.requestId)
			.first<Row>();
		if (existing) {
			if (existing.account_ids !== accounts) throw new RunConflictError('Request id reused.');
			return view(existing);
		}
		const row = await this.db
			.prepare(
				`INSERT INTO finance_runs (id, request_id, account_ids, status, created_at, updated_at)
				 VALUES (?, ?, ?, 'queued', ?, ?) ON CONFLICT DO NOTHING RETURNING *`
			)
			.bind(crypto.randomUUID(), input.requestId, accounts, now, now)
			.first<Row>();
		if (row) return view(row);
		const active = await this.db.prepare(`SELECT * FROM finance_runs WHERE ${ACTIVE}`).first<Row>();
		if (active) throw new RunBusyError(view(active));
		// Lost a race on the same request id.
		return this.create(input, now);
	}

	/** Queued runs end at once; a claimed run is flagged and the host winds its agent down. */
	async cancel(id: string, now: number): Promise<FinanceRun | null> {
		const row = await this.db
			.prepare(
				`UPDATE finance_runs SET cancel_requested = 1, updated_at = ?,
				 status = CASE status WHEN 'queued' THEN 'canceled' ELSE status END,
				 finished_at = CASE status WHEN 'queued' THEN ? ELSE finished_at END
				 WHERE id = ? AND ${ACTIVE} RETURNING *`
			)
			.bind(now, now, id)
			.first<Row>();
		return row ? view(row) : null;
	}

	/** The host's own unfinished run first (restart recovery), else the oldest queued run. */
	async claim(hostId: string, now: number): Promise<FinanceRun | null> {
		const own = await this.db
			.prepare(`SELECT * FROM finance_runs WHERE host_id = ? AND status IN ('claimed','running')`)
			.bind(hostId)
			.first<Row>();
		if (own) return view(own);
		const row = await this.db
			.prepare(
				`UPDATE finance_runs SET status = 'claimed', host_id = ?, claimed_at = ?, updated_at = ?
				 WHERE id = (SELECT id FROM finance_runs WHERE status = 'queued' ORDER BY created_at LIMIT 1)
				 AND status = 'queued' RETURNING *`
			)
			.bind(hostId, now, now)
			.first<Row>();
		return row ? view(row) : null;
	}

	/** Host reports: owner only, unfinished runs only, never back to running once finished. */
	async update(
		id: string,
		hostId: string,
		patch: HostPatch,
		now: number
	): Promise<FinanceRun | null> {
		const sets = ['updated_at = ?'];
		const values: (string | number)[] = [now];
		for (const key of DETAILS)
			if (patch[key] !== undefined) {
				sets.push(`${key} = ?`);
				values.push(patch[key]);
			}
		if (patch.status) {
			sets.push('status = ?');
			values.push(patch.status);
			sets.push(
				patch.status === 'running' ? 'started_at = COALESCE(started_at, ?)' : 'finished_at = ?'
			);
			values.push(now);
		}
		const row = await this.db
			.prepare(
				`UPDATE finance_runs SET ${sets.join(', ')}
				 WHERE id = ? AND host_id = ? AND status IN ('claimed','running') RETURNING *`
			)
			.bind(...values, id, hostId)
			.first<Row>();
		return row ? view(row) : null;
	}
}
