import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';

/**
 * Shared test helpers.
 *
 * FORBIDDEN_CJK_RE must stay in sync with scripts/check-no-cjk.sh, which
 * gates CI: Han + Hiragana + Katakana + Hangul + Bopomofo plus the CJK
 * punctuation/compat ranges U+3000–303F and U+FF01–FF9F.
 */
export const FORBIDDEN_CJK_RE =
  /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}|\p{Script=Bopomofo}|[\u3000-\u303F\uFF01-\uFF9F]/u;

export const MIGRATION_FILES = [
  '../migrations/0001_init.sql',
  '../migrations/0002_feed.sql',
  '../migrations/0003_p4.sql',
  '../migrations/0004_tags.sql',
  '../migrations/0005_d1_reads_and_ai_queue.sql',
  '../migrations/0006_drop_verdict.sql',
] as const;

export function applyMigrations(sqlite: Database, files: readonly string[] = MIGRATION_FILES): void {
  for (const file of files) {
    sqlite.exec(readFileSync(new URL(file, import.meta.url), 'utf8'));
  }
}

export interface TestD1 {
  db: D1Database;
  sqlite: Database;
  queries: string[];
  explain(sql: string, params?: unknown[]): { detail: string }[];
}

/**
 * Creates an in-memory SQLite-backed D1Database test harness with migrations applied.
 */
export function createTestD1(migrations: readonly string[] = MIGRATION_FILES): TestD1 {
  const sqlite = new Database(':memory:');
  applyMigrations(sqlite, migrations);
  const queries: string[] = [];

  const makeStmt = (sql: string, params: unknown[] = []) => ({
    bind(...args: unknown[]) {
      return makeStmt(sql, args);
    },
    async first<T = unknown>(colName?: string): Promise<T | null> {
      queries.push(sql);
      const row = sqlite.query(sql).get(...(params as [])) as Record<string, unknown> | null | undefined;
      if (row == null) return null;
      if (colName !== undefined) {
        return (row[colName] as T | undefined) ?? null;
      }
      return row as T;
    },
    async all<T = unknown>() {
      queries.push(sql);
      const results = sqlite.query(sql).all(...(params as [])) as T[];
      return { results, success: true, meta: { changes: 0 } };
    },
    async run() {
      queries.push(sql);
      const info = sqlite.query(sql).run(...(params as []));
      return { success: true, meta: { changes: info.changes } };
    },
  });

  let batchQueue: Promise<void> = Promise.resolve();

  const db = {
    prepare(sql: string) {
      return makeStmt(sql);
    },
    async batch(stmts: ReturnType<typeof makeStmt>[]) {
      if (stmts.length === 0) return [];
      const runBatch = async () => {
        sqlite.exec('BEGIN');
        try {
          const out = [];
          for (const s of stmts) out.push(await s.run());
          sqlite.exec('COMMIT');
          return out;
        } catch (err) {
          sqlite.exec('ROLLBACK');
          throw err;
        }
      };
      const next = batchQueue.then(runBatch, runBatch);
      batchQueue = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
    async exec(sql: string) {
      queries.push(sql);
      sqlite.exec(sql);
      return { count: 1, duration: 0 };
    },
  } as unknown as D1Database;

  return {
    db,
    sqlite,
    queries,
    explain(sql: string, params: unknown[] = []) {
      return sqlite.query(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as [])) as { detail: string }[];
    },
  };
}
