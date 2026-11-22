import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { evaluateSafety } from '../src/safety';
import { DRAINER_RE, URL_SHORTENERS } from '../src/safety/index';
import { markSnapshotError, upsertSnapshot, readSnapshot } from '../src/lib/db';
import { postProcessIngest, type Env } from '../src/index';
import type { IngestPostResult } from '../src/normalize/cluster';

function createSqliteD1(): D1Database {
  const sqlite = new Database(':memory:');
  for (const file of ['../migrations/0001_init.sql', '../migrations/0002_feed.sql', '../migrations/0003_p4.sql', '../migrations/0004_tags.sql']) {
    sqlite.exec(readFileSync(new URL(file, import.meta.url), 'utf8'));
  }
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

const NOW = 1_795_240_000_000;

describe('snapshot error marks only advance forward', () => {
  test('a delayed failed cron cannot flip a newer successful snapshot to ok=0', async () => {
    const db = createSqliteD1();
    await upsertSnapshot(db, 'airdrops', { cards: [] }, NOW + 5_000);
    // Overlapping cron finishes late with a failure timestamped BEFORE the success.
    await markSnapshotError(db, 'airdrops', new Error('surf 502'), NOW);

    const row = await readSnapshot(db, 'airdrops');
    expect(row?.ok).toBe(1);
    expect(row?.error).toBeNull();
    expect(row?.body).not.toBe('{}');
  });

  test('a fresh failure (newer timestamp) still marks ok=0 and keeps the old body', async () => {
    const db = createSqliteD1();
    await upsertSnapshot(db, 'airdrops', { cards: [] }, NOW);
    await markSnapshotError(db, 'airdrops', new Error('surf 502'), NOW + 1_000);

    const row = await readSnapshot(db, 'airdrops');
    expect(row?.ok).toBe(0);
    expect(row?.error).toBe('surf 502');
    expect(row?.body).not.toBe('{}'); // last good payload keeps serving
    expect(row?.fetched_at).toBe(NOW); // fetchedAt = last successful fetch
  });
});

describe('safety additions', () => {
  test('plain http:// links get an insecure-transport reason without auto-upgrade', () => {
    const res = evaluateSafety({
      urls: ['http://myproto.xyz/claim'],
      text: 'ok',
      knownProjectDomains: new Map(),
      trustMax: 1,
      sourceCount: 2,
    });
    expect(res.reasons.some(r => r.startsWith('Insecure transport (plain http): http://myproto.xyz/claim'))).toBe(true);
  });

  test('wallet-less airdrop announcements no longer trip the drainer rule', () => {
    // Ordinary announcement: no wallet step anywhere in the window.
    expect(DRAINER_RE.test('The airdrop is live! Claim your allocation before Friday.')).toBe(false);
    // Same phrasing WITH a wallet-connect step still flags.
    expect(DRAINER_RE.test('Airdrop is live — claim now via connect your wallet at the portal')).toBe(true);
    expect(
      DRAINER_RE.test('Airdrop is live for eligible users. Claim your share, then connect your wallet to receive.'),
    ).toBe(true);
  });

  test('t.ly and other common shorteners are curated in', () => {
    expect(URL_SHORTENERS['t.ly']).toBe(true);
    expect(URL_SHORTENERS['bit.ly']).toBe(true);
    expect(URL_SHORTENERS['tinyurl.com']).toBe(true);
    expect(URL_SHORTENERS['t.co']).toBe(true);
    expect(URL_SHORTENERS['is.gd']).toBe(true);
    expect(URL_SHORTENERS['cutt.ly']).toBe(true);
    expect(URL_SHORTENERS['rb.gy']).toBe(true);
    expect(URL_SHORTENERS['shorturl.at']).toBe(true);
    expect(URL_SHORTENERS['tiny.cc']).toBe(true);
  });
});

function makeEnv(db: D1Database, ai: { run(model: string, input: unknown): Promise<unknown> }, chunk = '2'): Env {
  return { DB: db, AI: ai, AI_SUMMARY_CHUNK: chunk };
}

function ingestedFor(clusterId: string, text: string): IngestPostResult[] {
  return [
    {
      clusterId,
      sourceId: 'telegram:ch1',
      rawText: text,
      forwardedFrom: null,
      isNewCluster: true,
      isNonLatinSource: false,
      riskLevel: 'ok',
      parsed: {
        urls: [],
        projectDomain: 'example.xyz',
        ticker: undefined,
        chains: [],
        taskTypes: ['other'],
        project: 'Example',
        summary: 'Example: test post',
        isNonLatinSource: false,
      },
    } as unknown as IngestPostResult,
  ];
}

describe('AI summary chunking with persisted backlog', () => {
  test('processes at most AI_SUMMARY_CHUNK clusters per tick and drains the rest later', async () => {
    const db = createSqliteD1();
    // Seed 4 backlog clusters (rule summary, non-risk, with posts).
    for (let i = 0; i < 4; i++) {
      await db
        .prepare(
          `INSERT INTO clusters (id, project, chains, task_types, summary, summary_source, risk_level, risk_reasons, score, source_count, first_seen, last_seen)
           VALUES (?1, ?2, '[]', '["other"]', 'rule', 'rule', 'ok', '[]', 1, 1, ?3, ?3)`,
        )
        .bind(`backlog:${i}`, `Proj${i}`, NOW - (100 - i) * 1_000)
        .run();
      await db
        .prepare(`INSERT INTO posts (id, source_id, post_url, posted_at, text, urls, cluster_id, created_at)
                  VALUES (?1, 'telegram:ch1', 'https://t.me/ch1/1', ?2, 'backlog text', '[]', ?1, ?2)`)
        .bind(`backlog:${i}`, NOW - 5_000)
        .run();
    }

    const aiCalls: string[] = [];
    const env = makeEnv(
      db,
      {
        async run() {
          aiCalls.push('call');
          return JSON.stringify({ summary: 'AI summary.', taskTypes: ['quest'], chains: [] });
        },
      },
      '2',
    );
    // Tick 1: backlog only (no fresh ingest).
    await postProcessIngest(env, [], NOW);
    expect(aiCalls.length).toBe(2); // chunk bound respected
    const drained = await db
      .prepare(`SELECT COUNT(*) AS n FROM clusters WHERE summary_source = 'ai'`)
      .first<{ n: number }>();
    expect(drained?.n).toBe(2);
    // Oldest first (FIFO by first_seen).
    const done = await db
      .prepare(`SELECT id FROM clusters WHERE summary_source = 'ai' ORDER BY id`)
      .all<{ id: string }>();
    expect(done.results.map(r => r.id)).toEqual(['backlog:0', 'backlog:1']);

    // Tick 2: the remaining backlog drains; deferred clusters ARE reconsidered.
    await postProcessIngest(env, [], NOW + 1);
    const drained2 = await db
      .prepare(`SELECT COUNT(*) AS n FROM clusters WHERE summary_source = 'ai'`)
      .first<{ n: number }>();
    expect(drained2?.n).toBe(4);

    // A fresh cluster (backlog empty now) is summarized in the same tick it arrives.
    await db
      .prepare(
        `INSERT INTO clusters (id, project, chains, task_types, summary, summary_source, risk_level, risk_reasons, score, source_count, first_seen, last_seen)
         VALUES ('fresh:cluster', 'Fresh', '[]', '["other"]', 'rule', 'rule', 'ok', '[]', 1, 1, ?1, ?1)`,
      )
      .bind(NOW + 2)
      .run();
    await db
      .prepare(`INSERT INTO posts (id, source_id, post_url, posted_at, text, urls, cluster_id, created_at)
                VALUES ('p:fresh', 'telegram:ch1', 'https://t.me/ch1/9', ?1, 'fresh text', '[]', 'fresh:cluster', ?1)`)
      .bind(NOW + 2)
      .run();
    await postProcessIngest(env, ingestedFor('fresh:cluster', 'fresh text'), NOW + 2);
    const fresh = await db
      .prepare(`SELECT summary_source FROM clusters WHERE id = 'fresh:cluster'`)
      .first<{ summary_source: string }>();
    expect(fresh?.summary_source).toBe('ai');

    // Chunk bound holds across all ticks: never more than 2 calls per tick.
    expect(aiCalls.length).toBe(5);
  });
});
