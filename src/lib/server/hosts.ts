/** Computers enrolled to claim finance review runs. */
export interface Host {
	id: string;
	label: string;
	created_at: number;
	expires_at: number;
	approved_at: number | null;
	revoked_at: number | null;
	state: 'pending' | 'active' | 'expired' | 'revoked';
}
type StoredHost = Omit<Host, 'state'> & { hash: string };
const columns = 'id, hash, label, created_at, expires_at, approved_at, revoked_at';
export const validHostId = (id: unknown): id is string =>
	typeof id === 'string' &&
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);
export async function hashHostToken(token: string): Promise<string> {
	const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
	return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}
function view(row: StoredHost, now: number): Host {
	const { hash: _hash, ...host } = row;
	return {
		...host,
		state:
			row.revoked_at !== null
				? 'revoked'
				: row.approved_at !== null
					? 'active'
					: row.expires_at <= now
						? 'expired'
						: 'pending'
	};
}
export class Hosts {
	constructor(private db: D1Database) {}
	async stage(input: { id: string; hash: string; label: string }, now: number): Promise<Host> {
		const { id, hash, label } = input;
		if (
			!validHostId(id) ||
			typeof hash !== 'string' ||
			!/^[0-9a-f]{64}$/.test(hash) ||
			typeof label !== 'string' ||
			!label.trim() ||
			label.trim().length > 100 ||
			/[\u0000-\u001f\u007f]/.test(label)
		)
			throw new Error('Invalid enrollment');
		// One atomic insert contains the capacity check. Public callers cannot stage.
		const row = await this.db
			.prepare(
				`INSERT INTO hosts (id, hash, label, created_at, expires_at)
   SELECT ?, ?, ?, ?, ? WHERE (SELECT count(*) FROM hosts WHERE revoked_at IS NULL AND (approved_at IS NOT NULL OR expires_at > ?)) < 100
   ON CONFLICT DO NOTHING RETURNING ${columns}`
			)
			.bind(id, hash, label.trim(), now, now + 600000, now)
			.first<StoredHost>();
		if (row) return view(row, now);
		const old = await this.db
			.prepare(`SELECT ${columns} FROM hosts WHERE id = ?`)
			.bind(id)
			.first<StoredHost>();
		if (
			!old ||
			old.hash !== hash ||
			old.label !== label.trim() ||
			old.revoked_at !== null ||
			(old.approved_at === null && old.expires_at <= now)
		)
			throw new Error('Enrollment conflicts, expired, or capacity reached');
		return view(old, now);
	}
	async approve(id: string, now: number): Promise<boolean> {
		const row = await this.db
			.prepare(
				`UPDATE hosts SET approved_at = COALESCE(approved_at, ?) WHERE id = ? AND revoked_at IS NULL AND (approved_at IS NOT NULL OR expires_at > ?) RETURNING id`
			)
			.bind(now, id, now)
			.first();
		return Boolean(row);
	}
	async revoke(id: string, now: number): Promise<boolean> {
		const row = await this.db
			.prepare('UPDATE hosts SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ? RETURNING id')
			.bind(now, id)
			.first();
		return Boolean(row);
	}
	async authenticate(token: string, now: number): Promise<Host | null> {
		if (!/^nw_[0-9a-f]{64}$/.test(token)) return null;
		const hash = await hashHostToken(token);
		const row = await this.db
			.prepare(`SELECT ${columns} FROM hosts WHERE hash = ?`)
			.bind(hash)
			.first<StoredHost>();
		return row ? view(row, now) : null;
	}
	async list(now: number): Promise<Host[]> {
		const { results } = await this.db
			.prepare(`SELECT ${columns} FROM hosts ORDER BY created_at DESC, id`)
			.all<StoredHost>();
		return results.map((row) => view(row, now));
	}
}
