/** Finance review runs: the site queues one, the enrolled mini host claims it and
 * launches an agent in Herdr, then reports back. Shared by routes, store and UI. */
export const RUN_STATUSES = ['queued', 'claimed', 'running', 'done', 'failed', 'canceled'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const ACTIVE_STATUSES: readonly RunStatus[] = ['queued', 'claimed', 'running'];
export const isActive = (status: RunStatus): boolean => ACTIVE_STATUSES.includes(status);

export interface FinanceRun {
	id: string;
	request_id: string;
	account_ids: string[];
	status: RunStatus;
	cancel_requested: boolean;
	host_id: string | null;
	tab_id: string | null;
	pane_id: string | null;
	tab_label: string | null;
	agent_name: string | null;
	agent_kind: 'claude' | 'codex' | null;
	summary: string | null;
	created_at: number;
	claimed_at: number | null;
	started_at: number | null;
	finished_at: number | null;
	updated_at: number;
}

/** What the host may report about its claimed run. */
export interface HostPatch {
	status?: 'running' | 'done' | 'failed' | 'canceled';
	tab_id?: string;
	pane_id?: string;
	tab_label?: string;
	agent_name?: string;
	agent_kind?: 'claude' | 'codex';
	summary?: string;
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const validRunId = (v: unknown): v is string => typeof v === 'string' && ID.test(v);
// Account ids are passed verbatim into the agent's instruction, so the charset stays narrow.
export const validAccountId = (v: unknown): v is string =>
	typeof v === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(v);

export function parseAccountIds(v: unknown): string[] | null {
	if (!Array.isArray(v) || !v.length || v.length > 100 || !v.every(validAccountId)) return null;
	return new Set(v).size === v.length ? [...v] : null;
}

const text = (v: unknown, max: number): v is string =>
	typeof v === 'string' &&
	v.trim().length > 0 &&
	v.length <= max &&
	!/[\u0000-\u001f\u007f]/.test(v);

export function parseHostPatch(body: Record<string, unknown>): HostPatch | null {
	const checks: Record<keyof HostPatch, (v: unknown) => boolean> = {
		status: (v) => v === 'running' || v === 'done' || v === 'failed' || v === 'canceled',
		tab_id: (v) => text(v, 64),
		pane_id: (v) => text(v, 64),
		tab_label: (v) => text(v, 100),
		agent_name: (v) => typeof v === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(v),
		agent_kind: (v) => v === 'claude' || v === 'codex',
		summary: (v) => text(v, 1000)
	};
	const keys = Object.keys(body);
	if (!keys.length) return null;
	for (const key of keys) {
		const check = checks[key as keyof HostPatch];
		if (!check || !check(body[key])) return null;
	}
	return body as HostPatch;
}
