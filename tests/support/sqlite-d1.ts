import { DatabaseSync } from 'node:sqlite';

/** Execute production D1 SQL against real SQLite, including atomic batch rollback. */
export function sqliteD1(sqlite: DatabaseSync): D1Database {
	function prepare(sql: string, args: unknown[] = []): D1PreparedStatement {
		return {
			bind: (...values: unknown[]) => prepare(sql, values),
			first: async () => sqlite.prepare(sql).get(...(args as never[])) ?? null,
			all: async () => ({ results: sqlite.prepare(sql).all(...(args as never[])), success: true }),
			run: async () => ({
				success: true,
				meta: { changes: Number(sqlite.prepare(sql).run(...(args as never[])).changes) }
			})
		} as unknown as D1PreparedStatement;
	}
	return {
		prepare,
		batch: async (statements: D1PreparedStatement[]) => {
			sqlite.exec('BEGIN');
			try {
				const result = [];
				for (const statement of statements) result.push(await statement.all());
				sqlite.exec('COMMIT');
				return result;
			} catch (error) {
				sqlite.exec('ROLLBACK');
				throw error;
			}
		}
	} as unknown as D1Database;
}
