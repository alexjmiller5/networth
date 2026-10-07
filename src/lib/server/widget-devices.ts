export interface WidgetDevice {
	id: string;
	label: string;
	created_at: number;
	expires_at: number;
	approved_at: number | null;
	revoked_at: number | null;
	state: 'pending' | 'active' | 'expired' | 'revoked';
}
type StoredDevice = Omit<WidgetDevice, 'state'> & { hash: string };
const columns = 'id, hash, label, created_at, expires_at, approved_at, revoked_at';
export const validWidgetId = (id: unknown): id is string =>
	typeof id === 'string' &&
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);
export async function hashWidgetToken(token: string): Promise<string> {
	const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
	return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}
function view(row: StoredDevice, now: number): WidgetDevice {
	const { hash: _hash, ...device } = row;
	return {
		...device,
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
export class WidgetDevices {
	constructor(private db: D1Database) {}
	async stage(
		input: { id: string; hash: string; label: string },
		now: number
	): Promise<WidgetDevice> {
		const { id, hash, label } = input;
		if (
			!validWidgetId(id) ||
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
				`INSERT INTO widget_devices (id, hash, label, created_at, expires_at)
   SELECT ?, ?, ?, ?, ? WHERE (SELECT count(*) FROM widget_devices WHERE revoked_at IS NULL AND (approved_at IS NOT NULL OR expires_at > ?)) < 100
   ON CONFLICT DO NOTHING RETURNING ${columns}`
			)
			.bind(id, hash, label.trim(), now, now + 600000, now)
			.first<StoredDevice>();
		if (row) return view(row, now);
		const old = await this.db
			.prepare(`SELECT ${columns} FROM widget_devices WHERE id = ?`)
			.bind(id)
			.first<StoredDevice>();
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
				`UPDATE widget_devices SET approved_at = COALESCE(approved_at, ?) WHERE id = ? AND revoked_at IS NULL AND (approved_at IS NOT NULL OR expires_at > ?) RETURNING id`
			)
			.bind(now, id, now)
			.first();
		return Boolean(row);
	}
	async revoke(id: string, now: number): Promise<boolean> {
		const row = await this.db
			.prepare(
				'UPDATE widget_devices SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ? RETURNING id'
			)
			.bind(now, id)
			.first();
		return Boolean(row);
	}
	async authenticate(token: string, now: number): Promise<WidgetDevice | null> {
		if (!/^nw_[0-9a-f]{64}$/.test(token)) return null;
		const hash = await hashWidgetToken(token);
		const row = await this.db
			.prepare(`SELECT ${columns} FROM widget_devices WHERE hash = ?`)
			.bind(hash)
			.first<StoredDevice>();
		return row ? view(row, now) : null;
	}
	async list(now: number): Promise<WidgetDevice[]> {
		const { results } = await this.db
			.prepare(`SELECT ${columns} FROM widget_devices ORDER BY created_at DESC, id`)
			.all<StoredDevice>();
		return results.map((row) => view(row, now));
	}
}
