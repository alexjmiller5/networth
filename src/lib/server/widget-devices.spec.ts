import { beforeEach, afterEach, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { WidgetDevices, hashWidgetToken } from './widget-devices';
let sqlite: DatabaseSync;
let store: WidgetDevices;
const now = 2_000_000_000_000;
const id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const secret = `nw_${'01'.repeat(32)}`;
let hash: string;
beforeEach(async () => {
	sqlite = new DatabaseSync(':memory:');
	for (const m of ['0001_devices', '0002_device_kind'])
		sqlite.exec(readFileSync(`migrations-widgets/${m}.sql`, 'utf8'));
	const db = {
		prepare(sql: string) {
			const stmt = sqlite.prepare(sql);
			const bind = (...values: (string | number | null)[]) => ({
				async first() {
					return stmt.get(...values) ?? null;
				},
				async all() {
					return { results: stmt.all(...values) };
				}
			});
			return { ...bind(), bind };
		}
	} as unknown as D1Database;
	store = new WidgetDevices(db);
	hash = await hashWidgetToken(secret);
});
afterEach(() => sqlite.close());
it('requires approval before authentication, and never stores the credential', async () => {
	expect(await store.authenticate(secret, now)).toBeNull();
	expect(await store.stage({ id, hash, label: 'Example phone' }, now)).toMatchObject({
		state: 'pending',
		expires_at: now + 600000
	});
	expect(await store.authenticate(secret, now)).toMatchObject({ state: 'pending' });
	expect(await store.approve(id, now + 1)).toBe(true);
	expect(await store.authenticate(secret, now + 700000)).toMatchObject({
		id,
		state: 'active',
		label: 'Example phone'
	});
	expect(JSON.stringify(sqlite.prepare('SELECT * FROM widget_devices').all())).not.toContain(
		secret
	);
	expect(await store.authenticate(hash, now)).toBeNull();
});
it('makes exact staging and approval replays safe without changing identity or resetting expiry', async () => {
	const original = await store.stage({ id, hash, label: 'Example' }, now);
	expect(await store.stage({ id, hash, label: 'Example' }, now + 5000)).toEqual(original);
	await expect(store.stage({ id, hash, label: 'Other' }, now)).rejects.toThrow();
	await expect(
		store.stage({ id: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb', hash, label: 'Other' }, now)
	).rejects.toThrow();
	expect(await store.approve(id, now + 1)).toBe(true);
	expect(await store.approve(id, now + 2)).toBe(true);
	expect(sqlite.prepare('SELECT count(*) AS n FROM widget_devices').get()?.n).toBe(1);
});
it('cannot approve expired enrollment, revive it by replay, or activate at the expiry boundary', async () => {
	await store.stage({ id, hash, label: 'Example' }, now);
	expect(await store.approve(id, now + 600000)).toBe(false);
	expect(await store.authenticate(secret, now + 600000)).toMatchObject({ state: 'expired' });
	await expect(store.stage({ id, hash, label: 'Example' }, now + 600000)).rejects.toThrow();
});
it('keeps revocation sticky against approvals, staging and repeated revocation', async () => {
	await store.stage({ id, hash, label: 'Example' }, now);
	await store.approve(id, now + 1);
	expect(await store.revoke(id, now + 2)).toBe(true);
	expect(await store.revoke(id, now + 3)).toBe(true);
	expect(await store.approve(id, now + 4)).toBe(false);
	await expect(store.stage({ id, hash, label: 'Example' }, now + 5)).rejects.toThrow();
	expect(await store.authenticate(secret, now + 6)).toMatchObject({ state: 'revoked' });
	expect((await store.list(now + 6))[0]).toMatchObject({
		id,
		state: 'revoked',
		revoked_at: now + 2
	});
});
it('validates enrollment inputs and bounds pending and active registry capacity', async () => {
	for (const input of [
		{ id: 'bad', hash, label: 'Example' },
		{ id, hash: 'bad', label: 'Example' },
		{ id, hash, label: ' ' },
		{ id, hash, label: 'x\nname' }
	])
		await expect(store.stage(input, now)).rejects.toThrow();
	for (let n = 0; n < 100; n++) {
		const key = n.toString(16).padStart(12, '0');
		await store.stage(
			{
				id: `aaaaaaaa-aaaa-4aaa-aaaa-${key}`,
				hash: n.toString(16).padStart(64, '0'),
				label: 'Example'
			},
			now
		);
	}
	await expect(store.stage({ id, hash, label: 'Overflow' }, now)).rejects.toThrow();
	expect(await store.stage({ id, hash, label: 'New after expiry' }, now + 600001)).toMatchObject({
		state: 'pending'
	});
});
it('records host devices separately from widgets and keeps the kind through replay', async () => {
	expect(await store.stage({ id, hash, label: 'Mac mini', kind: 'host' }, now)).toMatchObject({
		kind: 'host',
		state: 'pending'
	});
	expect(await store.stage({ id, hash, label: 'Mac mini', kind: 'host' }, now + 1)).toMatchObject({
		kind: 'host'
	});
	await expect(store.stage({ id, hash, label: 'Mac mini' }, now + 2)).rejects.toThrow();
	await store.approve(id, now + 3);
	expect(await store.authenticate(secret, now + 4)).toMatchObject({
		kind: 'host',
		state: 'active'
	});
	expect(
		await store.stage(
			{ id: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb', hash: '0'.repeat(64), label: 'Phone' },
			now
		)
	).toMatchObject({ kind: 'widget' });
	await expect(
		store.stage({ id, hash, label: 'x', kind: 'admin' as 'host' }, now)
	).rejects.toThrow();
});
