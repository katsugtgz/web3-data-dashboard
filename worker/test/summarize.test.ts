import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { HAN_RE } from '../src/normalize/i18n';
import { summarizeClusterWithAi, type AiBindingLike } from '../src/normalize/summarize';

function createSqliteD1(): D1Database {
  const sqlite = new Database(':memory:');
  for (const file of ['../migrations/0001_init.sql', '../migrations/0002_feed.sql', '../migrations/0003_p4.sql', '../migrations/0004_tags.sql']) {
    sqlite.exec(readFileSync(new URL(file, import.meta.url), 'utf8'));
  }
  sqlite.exec(
    `INSERT INTO clusters (id, project, ticker, domain, chains, task_types, summary, summary_source, risk_level, risk_reasons, score, source_count, first_seen, last_seen)
     VALUES ('c1', 'KiteAI', 'KITE', 'kite.ai', '[]', '["other"]', 'KiteAI: other', 'rule', 'ok', '[]', 0.5, 1, 1000, 1000)`,
  );
  const makeStmt = (sql: string, params: unknown[] = []) => ({
    bind(...args: unknown[]) {
      return makeStmt(sql, args);
    },
    async first<T = unknown>(): Promise<T | null> {
      const row = sqlite.query(sql).get(...(params as [])) as T | undefined;
      return row ?? null;
    },
    async all<T = unknown>() {
      const results = sqlite.query(sql).all(...(params as [])) as T[];
      return { results, success: true, meta: { changes: 0 } };
    },
    async run() {
      const info = sqlite.query(sql).run(...(params as []));
      return { success: true, meta: { changes: info.changes } };
    },
  });
  return {
    prepare(sql: string) {
      return makeStmt(sql);
    },
    async batch(stmts: ReturnType<typeof makeStmt>[]) {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
    async exec(sql: string) {
      sqlite.exec(sql);
      return { count: 1, duration: 0 };
    },
  } as unknown as D1Database;
}

describe('Workers AI summary normalization & budget guard', () => {
  test('produces English AI summary from non-Latin post and updates cluster', async () => {
    const db = createSqliteD1();
    const ai: AiBindingLike = {
      async run() {
        return {
          response: JSON.stringify({
            summary: 'Complete KiteAI testnet faucet and daily AI agent quests on Base.',
            taskTypes: ['testnet', 'faucet', 'quest'],
            chains: ['Base'],
          }),
        };
      },
    };

    const res = await summarizeClusterWithAi(ai, db, {
      clusterId: 'c1',
      project: 'KiteAI',
      rawTexts: ['\u6d4b\u8bd5\u7f51\u9886\u6c34 Base \u4efb\u52a1'],
      isNewCluster: true,
      isNonLatinSource: true,
      riskLevel: 'ok',
      nowMs: 1_795_240_000_000,
    });

    expect(res).not.toBeNull();
    expect(HAN_RE.test(res!.summary)).toBe(false);

    const row = await db
      .prepare(`SELECT summary, summary_source, chains, task_types FROM clusters WHERE id = 'c1'`)
      .first<{ summary: string; summary_source: string; chains: string; task_types: string }>();
    expect(row?.summary_source).toBe('ai');
    expect(row?.summary).toContain('KiteAI testnet faucet');
    expect(JSON.parse(row!.chains)).toContain('Base');
  });

  test('falls back to rule summary when AI emits CJK or invalid JSON', async () => {
    const db = createSqliteD1();
    const badCjkAi: AiBindingLike = {
      async run() {
        return { response: JSON.stringify({ summary: '\u4e2d\u6587\u6458\u8981', taskTypes: [], chains: [] }) };
      },
    };
    const r1 = await summarizeClusterWithAi(badCjkAi, db, {
      clusterId: 'c1',
      project: 'KiteAI',
      rawTexts: ['post'],
      isNewCluster: true,
      isNonLatinSource: false,
      riskLevel: 'ok',
    });
    expect(r1).toBeNull();

    const badJsonAi: AiBindingLike = {
      async run() {
        return { response: 'not valid json at all' };
      },
    };
    const r2 = await summarizeClusterWithAi(badJsonAi, db, {
      clusterId: 'c1',
      project: 'KiteAI',
      rawTexts: ['post'],
      isNewCluster: true,
      isNonLatinSource: false,
      riskLevel: 'ok',
    });
    expect(r2).toBeNull();
  });

  test('enforces daily AI cap without invoking env.AI', async () => {
    const db = createSqliteD1();
    const now = 1_795_240_000_000;
    const day = new Date(now).toISOString().slice(0, 10);
    await db.prepare(`INSERT INTO ai_usage (day, calls) VALUES (?1, 300)`).bind(day).run();

    let called = false;
    const ai: AiBindingLike = {
      async run() {
        called = true;
        return { response: '{}' };
      },
    };

    const res = await summarizeClusterWithAi(ai, db, {
      clusterId: 'c1',
      project: 'KiteAI',
      rawTexts: ['post'],
      isNewCluster: true,
      isNonLatinSource: false,
      riskLevel: 'ok',
      dailyMax: 300,
      nowMs: now,
    });
    expect(res).toBeNull();
    expect(called).toBe(false);
  });

  test('dailyMax 0 reserves nothing and never calls AI, even on a fresh counter', async () => {
    const db = createSqliteD1();
    let called = false;
    const ai: AiBindingLike = {
      async run() {
        called = true;
        return { response: JSON.stringify({ summary: 'ok', taskTypes: [], chains: [] }) };
      },
    };

    const res = await summarizeClusterWithAi(ai, db, {
      clusterId: 'c1',
      project: 'KiteAI',
      rawTexts: ['post'],
      isNewCluster: true,
      isNonLatinSource: false,
      riskLevel: 'ok',
      dailyMax: 0,
    });
    expect(res).toBeNull();
    expect(called).toBe(false);

    const usage = await db.prepare(`SELECT calls FROM ai_usage`).all<{ calls: number }>();
    expect(usage.results?.length ?? 0).toBe(0);
  });

  test('concurrent summaries cannot exceed the daily cap', async () => {
    const db = createSqliteD1();
    const cap = 3;
    let calls = 0;
    const ai: AiBindingLike = {
      async run() {
        calls++;
        return { response: JSON.stringify({ summary: 'Concurrent reservation probe.', taskTypes: [], chains: [] }) };
      },
    };

    // Seed the counter at 0 (INTEGER column: SQLite stores '0' as integer 0,
    // so this does not exercise a text-typed D1 — the upsert's own arithmetic
    // and RETURNING are what's under test), then fire 8 concurrent callers at cap 3.
    const day = new Date().toISOString().slice(0, 10);
    await db.prepare(`INSERT INTO ai_usage (day, calls) VALUES (?1, ?2)`).bind(day, 0).run();

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        summarizeClusterWithAi(ai, db, {
          clusterId: 'c1',
          project: 'KiteAI',
          rawTexts: ['post'],
          isNewCluster: true,
          isNonLatinSource: false,
          riskLevel: 'ok',
          dailyMax: cap,
        }),
      ),
    );

    const succeeded = results.filter(r => r !== null).length;
    expect(succeeded).toBe(cap);
    expect(calls).toBe(cap);

    const row = await db.prepare(`SELECT calls FROM ai_usage WHERE day = ?1`).bind(day).first<{ calls: number }>();
    expect(Number(row?.calls)).toBe(cap);
  });
});
