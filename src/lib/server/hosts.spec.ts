import { beforeEach, afterEach, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { sqliteD1, hostMigrations } from './sqlite-d1';
import { Hosts, hashHostToken } from './hosts';
let sqlite: DatabaseSync;
let store: Hosts;
const now = 2_000_000_000_000;
const id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const secret = `nw_${'01'.repeat(32)}`;
let hash: string;
beforeEach(async () => {
	let db: D1Database;
	({ sqlite, db } = sqliteD1(...hostMigrations));
	store = new Hosts(db);
	hash = await hashHostToken(secret);
});
afterEach(() => sqlite.close());
it('requires approval before authentication, and never stores the credential', async () => {
	expect(await store.authenticate(secret, now)).toBeNull();
	expect(await store.stage({ id, hash, label: 'Example host' }, now)).toMatchObject({
		state: 'pending',
		expires_at: now + 600000
	});
	expect(await store.authenticate(secret, now)).toMatchObject({ state: 'pending' });
	expect(await store.approve(id, now + 1)).toBe(true);
	expect(await store.authenticate(secret, now + 700000)).toMatchObject({
		id,
		state: 'active',
		label: 'Example host'
	});
	expect(JSON.stringify(sqlite.prepare('SELECT * FROM hosts').all())).not.toContain(secret);
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
	expect(sqlite.prepare('SELECT count(*) AS n FROM hosts').get()?.n).toBe(1);
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
it('keeps host rows and drops every phone row when the hosts-only migration runs', async () => {
	const old = sqliteD1(...hostMigrations.slice(0, 2)).sqlite;
	const insert = old.prepare(
		'INSERT INTO widget_devices (id, hash, label, kind, created_at, expires_at, approved_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
	);
	insert.run(id, hash, 'Mac mini', 'host', now, now + 1, now);
	insert.run(
		'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',
		'0'.repeat(64),
		'Phone',
		'widget',
		now,
		now + 1,
		now
	);
	old.exec(readFileSync(hostMigrations[2], 'utf8'));
	expect(old.prepare('SELECT id, label, approved_at FROM hosts').all()).toEqual([
		{ id, label: 'Mac mini', approved_at: now }
	]);
	old.close();
});
