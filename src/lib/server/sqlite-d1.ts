// Test-only: real SQLite behind the slice of D1's API the stores use.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

export function sqliteD1(...migrations: string[]) {
	const sqlite = new DatabaseSync(':memory:');
	for (const file of migrations) sqlite.exec(readFileSync(file, 'utf8'));
	const db = {
		prepare(sql: string) {
			const stmt = sqlite.prepare(sql);
			const bind = (...v: (string | number | null)[]) => ({
				async first() {
					return stmt.get(...v) ?? null;
				},
				async all() {
					return { results: stmt.all(...v) };
				},
				async run() {
					return { meta: { changes: Number(stmt.run(...v).changes) } };
				}
			});
			return { ...bind(), bind };
		},
		async batch(statements: { all(): Promise<unknown> }[]) {
			return Promise.all(statements.map((s) => s.all()));
		}
	} as unknown as D1Database;
	return { db, sqlite };
}
