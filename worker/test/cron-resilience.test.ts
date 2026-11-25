import { describe, expect, test } from 'bun:test';
import { createTestD1 } from './helpers';
import { evaluateSafety } from '../src/safety';
import { DRAINER_RE, URL_SHORTENERS } from '../src/safety/index';
import { markSnapshotError, upsertSnapshot, readSnapshot } from '../src/lib/db';
import worker, { ensureSourcesSynced, postProcessIngest, type Env } from '../src/index';
import type { IngestPostResult } from '../src/normalize/cluster';

function createSqliteD1(): D1Database {
  return createTestD1().db;
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
  test('processes highest score then newest last_seen up to AI_SUMMARY_CHUNK per tick and drains the rest later', async () => {
    const db = createSqliteD1();
    // Seed 4 backlog clusters (rule summary, non-risk, with posts) whose
    // priority order (score DESC, last_seen DESC) differs from FIFO first_seen.
    const rows = [
      { id: 'backlog:low', project: 'ProjLow', score: 0.5, firstSeen: NOW - 400_000, lastSeen: NOW - 400_000 },
      { id: 'backlog:mid-old', project: 'ProjMidOld', score: 2.0, firstSeen: NOW - 300_000, lastSeen: NOW - 300_000 },
      { id: 'backlog:mid-new', project: 'ProjMidNew', score: 2.0, firstSeen: NOW - 200_000, lastSeen: NOW - 100_000 },
      { id: 'backlog:top', project: 'ProjTop', score: 5.0, firstSeen: NOW - 100_000, lastSeen: NOW - 200_000 },
    ];
    for (const row of rows) {
      await db
        .prepare(
          `INSERT INTO clusters (id, project, chains, task_types, summary, summary_source, risk_level, risk_reasons, score, source_count, first_seen, last_seen)
           VALUES (?1, ?2, '[]', '["other"]', 'rule', 'rule', 'ok', '[]', ?3, 1, ?4, ?5)`,
        )
        .bind(row.id, row.project, row.score, row.firstSeen, row.lastSeen)
        .run();
      await db
        .prepare(`INSERT INTO posts (id, source_id, post_url, posted_at, text, urls, cluster_id, created_at)
                  VALUES (?1, 'telegram:ch1', 'https://t.me/ch1/1', ?2, 'backlog text', '[]', ?1, ?2)`)
        .bind(row.id, row.lastSeen)
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
    // Highest score first, then newest last_seen on tie.
    const done = await db
      .prepare(`SELECT id FROM clusters WHERE summary_source = 'ai' ORDER BY id`)
      .all<{ id: string }>();
    expect(done.results.map(r => r.id)).toEqual(['backlog:mid-new', 'backlog:top']);

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

  test('poison-pill failure backs off for 6h then permanently excludes after 3 attempts', async () => {
    const { db, queries, explain } = createTestD1();
    const t0 = NOW;

    await db
      .prepare(
        `INSERT INTO clusters (id, project, chains, task_types, summary, summary_source, risk_level, risk_reasons, score, source_count, first_seen, last_seen)
         VALUES ('poison', 'PoisonProto', '[]', '["other"]', 'rule', 'rule', 'ok', '[]', 10, 1, ?1, ?1),
                ('healthy', 'HealthyProto', '[]', '["other"]', 'rule', 'rule', 'ok', '[]', 1, 1, ?2, ?2)`,
      )
      .bind(t0 - 1_000, t0 - 2_000)
      .run();
    await db
      .prepare(
        `INSERT INTO posts (id, source_id, post_url, posted_at, text, urls, cluster_id, created_at)
         VALUES ('p:poison', 'telegram:ch1', 'https://t.me/ch1/1', ?1, 'poison post', '[]', 'poison', ?1),
                ('p:healthy', 'telegram:ch1', 'https://t.me/ch1/2', ?2, 'healthy post', '[]', 'healthy', ?2)`,
      )
      .bind(t0 - 1_000, t0 - 2_000)
      .run();

    const aiPrompts: string[] = [];
    const env = makeEnv(
      db,
      {
        async run(_model, input) {
          const prompt = (input as { messages: { content: string }[] }).messages[1].content;
          aiPrompts.push(prompt);
          if (prompt.includes('PoisonProto')) {
            return 'not valid json';
          }
          return JSON.stringify({ summary: 'Healthy AI summary.', taskTypes: ['quest'], chains: [] });
        },
      },
      '1',
    );

    // Tick 1: poison runs first, fails -> ai_attempts=1, ai_retry_after = t0 + 6h.
    const beforeTick1 = queries.length;
    await postProcessIngest(env, [], t0);
    expect(aiPrompts.length).toBe(1);
    expect(aiPrompts[0]).toContain('PoisonProto');

    const backlogSql = queries.slice(beforeTick1).find(q => q.includes('FROM clusters'));
    expect(backlogSql).toBeDefined();
    expect(backlogSql).toContain('c.ai_attempts < 3');
    const plan = explain(backlogSql!, [t0, 1]).map(s => s.detail).join('\n');
    expect(plan).toContain('clusters_ai_backlog');
    expect(plan).not.toMatch(/TEMP B-TREE/i);

    const poisonAfter1 = await db
      .prepare('SELECT summary_source, ai_attempts, ai_retry_after FROM clusters WHERE id = ?1')
      .bind('poison')
      .first<{ summary_source: string; ai_attempts: number; ai_retry_after: number }>();
    expect(poisonAfter1).toEqual({
      summary_source: 'rule',
      ai_attempts: 1,
      ai_retry_after: t0 + 6 * 3_600_000,
    });

    // Tick 2 inside 6h backoff: skips poison and summarizes healthy.
    await postProcessIngest(env, [], t0 + 60_000);
    expect(aiPrompts.length).toBe(2);
    expect(aiPrompts[1]).toContain('HealthyProto');
    const healthy = await db
      .prepare('SELECT summary_source FROM clusters WHERE id = ?1')
      .bind('healthy')
      .first<{ summary_source: string }>();
    expect(healthy?.summary_source).toBe('ai');

    // Tick 3 at t0 + 6h: poison retried and fails again -> ai_attempts=2, ai_retry_after = t1 + 24h.
    const t1 = t0 + 6 * 3_600_000;
    await postProcessIngest(env, [], t1);
    expect(aiPrompts.length).toBe(3);
    const poisonAfter2 = await db
      .prepare('SELECT ai_attempts, ai_retry_after FROM clusters WHERE id = ?1')
      .bind('poison')
      .first<{ ai_attempts: number; ai_retry_after: number }>();
    expect(poisonAfter2).toEqual({
      ai_attempts: 2,
      ai_retry_after: t1 + 24 * 3_600_000,
    });

    // Tick 4 at t1 + 24h: poison retried a 3rd time and fails -> ai_attempts=3.
    const t2 = t1 + 24 * 3_600_000;
    await postProcessIngest(env, [], t2);
    expect(aiPrompts.length).toBe(4);
    const poisonAfter3 = await db
      .prepare('SELECT ai_attempts, ai_retry_after FROM clusters WHERE id = ?1')
      .bind('poison')
      .first<{ ai_attempts: number; ai_retry_after: number }>();
    expect(poisonAfter3).toEqual({
      ai_attempts: 3,
      ai_retry_after: t2 + 24 * 3_600_000,
    });

    // Tick 5 well past ai_retry_after: permanently excluded (0 AI calls).
    await postProcessIngest(env, [], t2 + 48 * 3_600_000);
    expect(aiPrompts.length).toBe(4);
  });

  test('exits immediately with zero cluster/post queries when quota is exhausted or AI is disabled', async () => {
    const { db, queries } = createTestD1();
    const day = new Date(NOW).toISOString().slice(0, 10);

    await db
      .prepare(
        `INSERT INTO clusters (id, project, chains, task_types, summary, summary_source, risk_level, risk_reasons, score, source_count, first_seen, last_seen)
         VALUES ('c:pending', 'PendingProto', '[]', '["other"]', 'rule', 'rule', 'ok', '[]', 5, 1, ?1, ?1)`,
      )
      .bind(NOW - 1_000)
      .run();
    await db
      .prepare(`INSERT INTO posts (id, source_id, post_url, posted_at, text, urls, cluster_id, created_at)
                VALUES ('p:pending', 'telegram:ch1', 'https://t.me/ch1/1', ?1, 'pending text', '[]', 'c:pending', ?1)`)
      .bind(NOW - 1_000)
      .run();
    await db.prepare('INSERT INTO ai_usage (day, calls) VALUES (?1, 5)').bind(day).run();

    let aiCalls = 0;
    const spyAi = {
      async run() {
        aiCalls++;
        return JSON.stringify({ summary: 'Should not run', taskTypes: ['quest'], chains: [] });
      },
    };

    // Case 1: quota exhausted (ai_usage.calls >= dailyMax).
    const beforeExhausted = queries.length;
    await postProcessIngest({ DB: db, AI: spyAi, AI_DAILY_MAX: '5', AI_SUMMARY_CHUNK: '2' }, [], NOW);
    expect(aiCalls).toBe(0);
    const exhaustedQueries = queries.slice(beforeExhausted);
    expect(exhaustedQueries.some(q => /\b(?:clusters|posts)\b/i.test(q))).toBe(false);

    // Case 2: AI_DAILY_MAX = '0' -> zero queries at all.
    const beforeZeroMax = queries.length;
    await postProcessIngest({ DB: db, AI: spyAi, AI_DAILY_MAX: '0', AI_SUMMARY_CHUNK: '2' }, [], NOW);
    expect(aiCalls).toBe(0);
    expect(queries.slice(beforeZeroMax)).toEqual([]);

    // Case 3: missing env.AI -> zero queries at all.
    const beforeNoAi = queries.length;
    await postProcessIngest({ DB: db, AI_DAILY_MAX: '5', AI_SUMMARY_CHUNK: '2' }, [], NOW);
    expect(queries.slice(beforeNoAi)).toEqual([]);
  });

  test('non-Latin ingested follow-ups never bypass ai_retry_after backoff, ai_attempts cap, or summary_source=ai', async () => {
    const db = createSqliteD1();
    const t0 = NOW;
    const day = new Date(t0).toISOString().slice(0, 10);

    await db
      .prepare(
        `INSERT INTO clusters (id, project, chains, task_types, summary, summary_source, risk_level, risk_reasons, score, source_count, first_seen, last_seen, ai_attempts, ai_retry_after)
         VALUES ('c:backoff', 'BackoffProto', '[]', '["other"]', 'rule', 'rule', 'ok', '[]', 9, 1, ?1, ?1, 1, ?2),
                ('c:capped', 'CappedProto', '[]', '["other"]', 'rule', 'rule', 'ok', '[]', 8, 1, ?1, ?1, 3, 0),
                ('c:done', 'DoneProto', '[]', '["other"]', 'Already AI.', 'ai', 'ok', '[]', 7, 1, ?1, ?1, 0, 0)`,
      )
      .bind(t0 - 1_000, t0 + 6 * 3_600_000)
      .run();
    await db
      .prepare(
        `INSERT INTO posts (id, source_id, post_url, posted_at, text, urls, cluster_id, created_at)
         VALUES ('p:backoff', 'telegram:ch1', 'https://t.me/ch1/1', ?1, 'non-latin follow-up', '[]', 'c:backoff', ?1),
                ('p:capped', 'telegram:ch1', 'https://t.me/ch1/2', ?1, 'non-latin follow-up', '[]', 'c:capped', ?1),
                ('p:done', 'telegram:ch1', 'https://t.me/ch1/3', ?1, 'non-latin follow-up', '[]', 'c:done', ?1)`,
      )
      .bind(t0)
      .run();

    let aiCalls = 0;
    const env = makeEnv(
      db,
      {
        async run() {
          aiCalls++;
          return JSON.stringify({ summary: 'Should never run.', taskTypes: ['quest'], chains: [] });
        },
      },
      '6',
    );

    const followUps: IngestPostResult[] = ['c:backoff', 'c:capped', 'c:done'].map(clusterId => ({
      ...ingestedFor(clusterId, 'non-latin follow-up')[0],
      isNewCluster: false,
      isNonLatinSource: true,
    }));

    await postProcessIngest(env, followUps, t0);

    expect(aiCalls).toBe(0);
    const usage = await db.prepare('SELECT calls FROM ai_usage WHERE day = ?1').bind(day).first<{ calls: number }>();
    expect(usage).toBeNull();
    const backoffRow = await db
      .prepare('SELECT ai_attempts FROM clusters WHERE id = ?1')
      .bind('c:backoff')
      .first<{ ai_attempts: number }>();
    const cappedRow = await db
      .prepare('SELECT ai_attempts FROM clusters WHERE id = ?1')
      .bind('c:capped')
      .first<{ ai_attempts: number }>();
    expect(backoffRow?.ai_attempts).toBe(1);
    expect(cappedRow?.ai_attempts).toBe(3);
  });
});

function makeExecCtx(): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {},
  } as unknown as ExecutionContext;
}

async function withStubbedCaches<T>(fn: () => Promise<T>): Promise<T> {
  const g = globalThis as unknown as { caches?: CacheStorage };
  const hadCaches = 'caches' in g;
  const prevCaches = g.caches;
  const store = new Map<string, Response>();
  const defaultCache = {
    async match(req: RequestInfo | URL) {
      const key = typeof req === 'string' ? req : req instanceof URL ? req.toString() : req.url;
      return store.get(key)?.clone();
    },
    async put(req: RequestInfo | URL, res: Response) {
      const key = typeof req === 'string' ? req : req instanceof URL ? req.toString() : req.url;
      store.set(key, res.clone());
    },
  };
  g.caches = { default: defaultCache } as unknown as CacheStorage;
  try {
    return await fn();
  } finally {
    if (hadCaches) {
      g.caches = prevCaches;
    } else {
      delete g.caches;
    }
  }
}

describe('HTTP cache headers and prefix snapshot reads', () => {
  test('/markets.json queries only markets:* prefix and endpoints emit expected Cache-Control headers', async () => {
    const { db, queries } = createTestD1();
    await upsertSnapshot(db, 'airdrops', { cards: [], tge: [], counts: { active: 0, preToken: 0 }, fetchedAt: NOW }, NOW);
    await upsertSnapshot(
      db,
      'markets:crypto',
      {
        section: {
          id: 'crypto',
          title: 'Crypto Market',
          blurb: '',
          cols: ['Coin'],
          rows: [],
          source: 'CoinGecko',
          sourceUrl: 'https://www.coingecko.com',
          fetchedAt: NOW,
          stale: false,
        },
        sectors: [],
      },
      NOW,
    );

    await withStubbedCaches(async () => {
      const beforeMarkets = queries.length;
      const marketsRes = await worker.fetch(new Request('https://radar.test/markets.json'), { DB: db }, makeExecCtx());
      expect(marketsRes.status).toBe(200);
      expect(marketsRes.headers.get('Cache-Control')).toBe('public, max-age=60, s-maxage=120');

      const marketsQueries = queries.slice(beforeMarkets).filter(q => q.includes('snapshots'));
      expect(marketsQueries.length).toBe(1);
      expect(marketsQueries[0]).toContain('WHERE key >= ?1 AND key < ?2');
      expect(marketsQueries[0]).not.toMatch(/FROM\s+snapshots\s+ORDER\s+BY/i);

      const feedRes = await worker.fetch(new Request('https://radar.test/feed.json'), { DB: db }, makeExecCtx());
      expect(feedRes.status).toBe(200);
      expect(feedRes.headers.get('Cache-Control')).toBe('public, max-age=30, s-maxage=60');

      for (const path of ['/airdrops.json', '/sources.json', '/sources/candidates.json']) {
        const res = await worker.fetch(new Request(`https://radar.test${path}`), { DB: db }, makeExecCtx());
        expect(res.status).toBe(200);
        expect(res.headers.get('Cache-Control')).toBe('public, max-age=60, s-maxage=120');
      }
    });
  });
});

async function withStubbedFetch<T>(
  handler: (url: string) => Response | Promise<Response>,
  fn: () => Promise<T>,
): Promise<T> {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) =>
    handler(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)) as unknown as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = prevFetch;
  }
}

describe('ensureSourcesSynced and scheduled cron resilience', () => {
  test('ensureSourcesSynced syncs once per DB instance and retries after transient error', async () => {
    const { db: db1, queries: queries1 } = createTestD1();
    await ensureSourcesSynced(db1);
    const count1 = await db1.prepare('SELECT COUNT(*) AS n FROM sources').first<{ n: number }>();
    expect(count1?.n).toBeGreaterThan(0);

    const afterFirst = queries1.length;
    await ensureSourcesSynced(db1);
    expect(queries1.length).toBe(afterFirst);

    const { db: db2 } = createTestD1();
    await ensureSourcesSynced(db2);
    const count2 = await db2.prepare('SELECT COUNT(*) AS n FROM sources').first<{ n: number }>();
    expect(count2?.n).toBe(count1?.n);

    const { db: realDb, queries: flakyQueries } = createTestD1();
    let failOnce = true;
    const flakyDb = {
      prepare(sql: string) {
        if (failOnce) {
          failOnce = false;
          throw new Error('transient D1 error');
        }
        return realDb.prepare(sql);
      },
      batch(stmts: D1PreparedStatement[]) {
        return realDb.batch(stmts);
      },
      exec(sql: string) {
        return realDb.exec(sql);
      },
    } as unknown as D1Database;

    await expect(ensureSourcesSynced(flakyDb)).rejects.toThrow('transient D1 error');
    await ensureSourcesSynced(flakyDb);
    const flakyCount = await realDb.prepare('SELECT COUNT(*) AS n FROM sources').first<{ n: number }>();
    expect(flakyCount?.n).toBe(count1?.n);

    const afterFlakySuccess = flakyQueries.length;
    await ensureSourcesSynced(flakyDb);
    expect(flakyQueries.length).toBe(afterFlakySuccess);
  });

  test('scheduled dispatches */2 * * * * and * * * * * to Telegram cron without touching markets or cron_state', async () => {
    for (const cronExpr of ['*/2 * * * *', '* * * * *']) {
      const { db } = createTestD1();
      const requestedUrls: string[] = [];

      await withStubbedFetch(
        url => {
          requestedUrls.push(url);
          return new Response('offline', { status: 503 });
        },
        async () => {
          await worker.scheduled(
            { cron: cronExpr, scheduledTime: NOW, noRetry() {} } as ScheduledController,
            { DB: db, TG_BATCH_SIZE: '1' },
            makeExecCtx(),
          );
        },
      );

      expect(requestedUrls.length).toBeGreaterThan(0);
      expect(requestedUrls.every(u => u.startsWith('https://t.me/s/'))).toBe(true);

      const markets = await db
        .prepare(`SELECT key FROM snapshots WHERE key LIKE 'markets:%'`)
        .all<{ key: string }>();
      expect(markets.results).toEqual([]);

      const gates = await db.prepare('SELECT key FROM cron_state').all<{ key: string }>();
      expect(gates.results).toEqual([]);
    }
  });

  test('scheduled with */5 * * * * throttles prune and decay to 60 minutes via cron_state', async () => {
    const { db, queries } = createTestD1();
    const t0 = NOW;
    const oldPostedAt = t0 - 31 * 86_400_000;

    await db
      .prepare(
        `INSERT INTO clusters (id, project, chains, task_types, summary, summary_source, risk_level, risk_reasons, score, source_count, first_seen, last_seen)
         VALUES ('c:active', 'ActiveProto', '[]', '["quest"]', 'rule', 'rule', 'ok', '[]', 999, 1, ?1, ?1),
                ('c:old1', 'OldProto', '[]', '["other"]', 'rule', 'rule', 'ok', '[]', 1, 1, ?2, ?2)`,
      )
      .bind(t0 - 3_600_000, oldPostedAt)
      .run();
    await db
      .prepare(
        `INSERT INTO posts (id, source_id, post_url, posted_at, text, urls, cluster_id, created_at)
         VALUES ('p:active', 'telegram:ch1', 'https://t.me/ch1/1', ?1, 'active post', '[]', 'c:active', ?1),
                ('p:old1', 'telegram:ch1', 'https://t.me/ch1/2', ?2, 'old post', '[]', 'c:old1', ?2)`,
      )
      .bind(t0 - 3_600_000, oldPostedAt)
      .run();

    const env: Env = { DB: db, X_BATCH_SIZE: '1' };

    await withStubbedFetch(
      () => new Response('offline', { status: 503 }),
      async () => {
        // Tick 1 at T0: runs both prune and decay and records cron_state.
        await worker.scheduled(
          { cron: '*/5 * * * *', scheduledTime: t0, noRetry() {} } as ScheduledController,
          env,
          makeExecCtx(),
        );

        const state1 = await db
          .prepare('SELECT key, last_run_at FROM cron_state ORDER BY key ASC')
          .all<{ key: string; last_run_at: number }>();
        expect(state1.results).toEqual([
          { key: 'decay', last_run_at: t0 },
          { key: 'prune', last_run_at: t0 },
        ]);

        const old1 = await db.prepare(`SELECT id FROM posts WHERE id = 'p:old1'`).first<{ id: string }>();
        expect(old1).toBeNull();
        const active1 = await db.prepare(`SELECT score FROM clusters WHERE id = 'c:active'`).first<{ score: number }>();
        expect(active1?.score).toBeLessThan(999);

        // Tick 2 at T0 + 5m (inside 60m gate): skips both prune and decay.
        const t1 = t0 + 5 * 60_000;
        const old2PostedAt = t1 - 31 * 86_400_000;
        await db
          .prepare(
            `INSERT INTO posts (id, source_id, post_url, posted_at, text, urls, cluster_id, created_at)
             VALUES ('p:old2', 'telegram:ch1', 'https://t.me/ch1/3', ?1, 'old post 2', '[]', 'c:active', ?1)`,
          )
          .bind(old2PostedAt)
          .run();
        await db.prepare(`UPDATE clusters SET score = 999 WHERE id = 'c:active'`).run();

        const beforeTick2 = queries.length;
        await worker.scheduled(
          { cron: '*/5 * * * *', scheduledTime: t1, noRetry() {} } as ScheduledController,
          env,
          makeExecCtx(),
        );
        const tick2Queries = queries.slice(beforeTick2);
        expect(tick2Queries.some(q => q.includes('DELETE FROM posts'))).toBe(false);
        expect(
          tick2Queries.some(q => q.includes('SELECT id, source_count, last_seen, surf_tier, risk_level, score, trust_max')),
        ).toBe(false);

        const state2 = await db
          .prepare('SELECT key, last_run_at FROM cron_state ORDER BY key ASC')
          .all<{ key: string; last_run_at: number }>();
        expect(state2.results).toEqual([
          { key: 'decay', last_run_at: t0 },
          { key: 'prune', last_run_at: t0 },
        ]);

        const old2StillThere = await db.prepare(`SELECT id FROM posts WHERE id = 'p:old2'`).first<{ id: string }>();
        expect(old2StillThere?.id).toBe('p:old2');
        const active2 = await db.prepare(`SELECT score FROM clusters WHERE id = 'c:active'`).first<{ score: number }>();
        expect(active2?.score).toBe(999);

        // Tick 3 at T0 + 60m (exact boundary): runs both prune and decay again.
        const t2 = t0 + 60 * 60_000;
        await worker.scheduled(
          { cron: '*/5 * * * *', scheduledTime: t2, noRetry() {} } as ScheduledController,
          env,
          makeExecCtx(),
        );

        const state3 = await db
          .prepare('SELECT key, last_run_at FROM cron_state ORDER BY key ASC')
          .all<{ key: string; last_run_at: number }>();
        expect(state3.results).toEqual([
          { key: 'decay', last_run_at: t2 },
          { key: 'prune', last_run_at: t2 },
        ]);

        const old2Deleted = await db.prepare(`SELECT id FROM posts WHERE id = 'p:old2'`).first<{ id: string }>();
        expect(old2Deleted).toBeNull();
        const active3 = await db.prepare(`SELECT score FROM clusters WHERE id = 'c:active'`).first<{ score: number }>();
        expect(active3?.score).toBeLessThan(999);
      },
    );
  });

  test('scheduled */5 * * * * still runs prune and decay when postProcessIngest throws', async () => {
    const { db } = createTestD1();
    const t0 = NOW;
    const oldPostedAt = t0 - 31 * 86_400_000;

    await db
      .prepare(
        `INSERT INTO clusters (id, project, chains, task_types, summary, summary_source, risk_level, risk_reasons, score, source_count, first_seen, last_seen)
         VALUES ('c:active', 'ActiveProto', '[]', '["quest"]', 'rule', 'rule', 'ok', '[]', 999, 1, ?1, ?1),
                ('c:old1', 'OldProto', '[]', '["other"]', 'rule', 'rule', 'ok', '[]', 1, 1, ?2, ?2)`,
      )
      .bind(t0 - 3_600_000, oldPostedAt)
      .run();
    await db
      .prepare(
        `INSERT INTO posts (id, source_id, post_url, posted_at, text, urls, cluster_id, created_at)
         VALUES ('p:active', 'telegram:ch1', 'https://t.me/ch1/1', ?1, 'active post', '[]', 'c:active', ?1),
                ('p:old1', 'telegram:ch1', 'https://t.me/ch1/2', ?2, 'old post', '[]', 'c:old1', ?2)`,
      )
      .bind(t0 - 3_600_000, oldPostedAt)
      .run();

    const failingAiDb = {
      ...db,
      prepare(sql: string) {
        const stmt = db.prepare(sql);
        if (/\bai_usage\b/i.test(sql)) {
          return {
            bind() {
              return {
                async first() {
                  throw new Error('D1 ai_usage failure');
                },
              };
            },
          };
        }
        return stmt;
      },
    } as unknown as D1Database;

    const env: Env = {
      DB: failingAiDb,
      AI: {
        async run() {
          return JSON.stringify({ summary: 'Unused', taskTypes: ['quest'], chains: [] });
        },
      },
      X_BATCH_SIZE: '1',
    };

    const origErr = console.error;
    const logged: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    try {
      await withStubbedFetch(
        () => new Response('offline', { status: 503 }),
        async () => {
          await worker.scheduled(
            { cron: '*/5 * * * *', scheduledTime: t0, noRetry() {} } as ScheduledController,
            env,
            makeExecCtx(),
          );
        },
      );
    } finally {
      console.error = origErr;
    }

    expect(logged.some(args => args[0] === 'cron-error:postProcessIngest')).toBe(true);

    const old1 = await db.prepare(`SELECT id FROM posts WHERE id = 'p:old1'`).first<{ id: string }>();
    expect(old1).toBeNull();
    const active = await db.prepare(`SELECT score FROM clusters WHERE id = 'c:active'`).first<{ score: number }>();
    expect(active?.score).toBeLessThan(999);
    const states = await db
      .prepare('SELECT key, last_run_at FROM cron_state ORDER BY key ASC')
      .all<{ key: string; last_run_at: number }>();
    expect(states.results).toEqual([
      { key: 'decay', last_run_at: t0 },
      { key: 'prune', last_run_at: t0 },
    ]);
  });

  test('*/2 cron reads only airdrops snapshot (never markets:defi), and */5 cron gates TTL via metadata and seedKnownDomains via known_domains_seed', async () => {
    const { db, queries } = createTestD1();
    const t0 = NOW;
    const sampleAirdrops = {
      cards: [
        {
          r: 1,
          n: 'AlphaProto',
          id: 'surf:alpha',
          t: null,
          g: 'A',
          b: ['live'],
          x: null,
          img: '',
          f: '—',
          tk: '1/1',
          h: 10,
          u: 'today',
          fit: ['zero'],
          best: { n: 'Task', ty: 'testnet', c: 'Free', m: '5m' },
          sc: 80,
          sub: [8, 8, null],
          url: 'https://alphaproto.xyz/',
          source: 'Surf',
        },
      ],
      tge: [],
      counts: { active: 1, preToken: 1 },
      fetchedAt: t0,
    };
    const sampleDefi = {
      id: 'defi',
      title: 'DeFi',
      blurb: 'DeFi',
      cols: ['Project'],
      rows: [{ cells: ['BetaDefi'], href: 'https://betadefi.io/' }],
      source: 'DefiLlama',
      sourceUrl: 'https://defillama.com',
      fetchedAt: t0,
      stale: false,
    };
    await upsertSnapshot(db, 'airdrops', sampleAirdrops, t0);
    await upsertSnapshot(db, 'markets:defi', sampleDefi, t0);
    await upsertSnapshot(db, 'markets:github', { id: 'github', title: 'GH', blurb: '', cols: [], rows: [], source: 'GH', sourceUrl: 'https://github.com', fetchedAt: t0, stale: false }, t0);

    // 1. */2 cron: must NOT read markets:defi.
    const beforeTwoMin = queries.length;
    await withStubbedFetch(
      () => new Response('offline', { status: 503 }),
      async () => {
        await worker.scheduled(
          { cron: '*/2 * * * *', scheduledTime: t0 + 60_000, noRetry() {} } as ScheduledController,
          { DB: db, TG_BATCH_SIZE: '1' },
          makeExecCtx(),
        );
      },
    );
    const twoMinSnapReads = queries
      .slice(beforeTwoMin)
      .filter(q => /FROM\s+snapshots/i.test(q));
    expect(twoMinSnapReads.length).toBe(1);

    // 2. */5 cron tick 1 (t0 + 5m): airdrops & github TTL fresh -> uses readSnapshotMeta;
    //    known_domains_seed missing -> seeds known_domains once and records t0.
    const beforeFive1 = queries.length;
    await withStubbedFetch(
      () => new Response('offline', { status: 503 }),
      async () => {
        await worker.scheduled(
          { cron: '*/5 * * * *', scheduledTime: t0 + 5 * 60_000, noRetry() {} } as ScheduledController,
          { DB: db, X_BATCH_SIZE: '1', FEED_BATCH_SIZE: '1' },
          makeExecCtx(),
        );
      },
    );
    const five1Queries = queries.slice(beforeFive1);
    expect(five1Queries.some(q => q.includes('length(body) AS body_len'))).toBe(true);
    expect(five1Queries.some(q => /INSERT\s+INTO\s+known_domains/i.test(q))).toBe(true);

    const seedState = await db
      .prepare(`SELECT last_run_at FROM cron_state WHERE key = 'known_domains_seed'`)
      .first<{ last_run_at: number }>();
    expect(seedState?.last_run_at).toBe(t0);

    // 3. */5 cron tick 2 (t0 + 10m): neither airdrops nor markets:defi advanced -> skips seedKnownDomains!
    const beforeFive2 = queries.length;
    await withStubbedFetch(
      () => new Response('offline', { status: 503 }),
      async () => {
        await worker.scheduled(
          { cron: '*/5 * * * *', scheduledTime: t0 + 10 * 60_000, noRetry() {} } as ScheduledController,
          { DB: db, X_BATCH_SIZE: '1', FEED_BATCH_SIZE: '1' },
          makeExecCtx(),
        );
      },
    );
    const five2Queries = queries.slice(beforeFive2);
    expect(five2Queries.some(q => /INSERT\s+INTO\s+known_domains/i.test(q))).toBe(false);

    // 4. Advance markets:defi fetched_at -> next */5 tick re-runs seedKnownDomains and advances known_domains_seed.
    const tDefiNew = t0 + 15 * 60_000;
    await upsertSnapshot(
      db,
      'markets:defi',
      { ...sampleDefi, rows: [{ cells: ['GammaDefi'], href: 'https://gammadefi.io/' }], fetchedAt: tDefiNew },
      tDefiNew,
    );
    const beforeFive3 = queries.length;
    await withStubbedFetch(
      () => new Response('offline', { status: 503 }),
      async () => {
        await worker.scheduled(
          { cron: '*/5 * * * *', scheduledTime: tDefiNew + 1_000, noRetry() {} } as ScheduledController,
          { DB: db, X_BATCH_SIZE: '1', FEED_BATCH_SIZE: '1' },
          makeExecCtx(),
        );
      },
    );
    const five3Queries = queries.slice(beforeFive3);
    expect(five3Queries.some(q => /INSERT\s+INTO\s+known_domains/i.test(q))).toBe(true);
    const gammaRow = await db
      .prepare(`SELECT domain FROM known_domains WHERE domain = 'gammadefi.io'`)
      .first<{ domain: string }>();
    expect(gammaRow?.domain).toBe('gammadefi.io');
    const seedState2 = await db
      .prepare(`SELECT last_run_at FROM cron_state WHERE key = 'known_domains_seed'`)
      .first<{ last_run_at: number }>();
    expect(seedState2?.last_run_at).toBe(tDefiNew);
  });

  test('*/5 cron reuses freshly built airdrops in memory without re-reading snapshots body after upsert', async () => {
    const { db, queries } = createTestD1();
    const t0 = NOW;
    const surfPayload = {
      active: [
        {
          project_id: 'fresh-surf',
          project_name: 'FreshSurf',
          grade: 'A',
          score: 85,
          best_task: { title: 'Testnet swap', type: 'testnet', external_link: 'https://freshsurf.xyz/app' },
          tasks: [{ title: 'Testnet swap', type: 'testnet', external_link: 'https://freshsurf.xyz/app' }],
        },
      ],
      tge: [],
    };

    const before = queries.length;
    await withStubbedFetch(
      url => {
        if (url.includes('surf.computer') || url.includes('surf.test')) {
          return new Response(JSON.stringify(surfPayload), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('offline', { status: 503 });
      },
      async () => {
        await worker.scheduled(
          { cron: '*/5 * * * *', scheduledTime: t0, noRetry() {} } as ScheduledController,
          { DB: db, SURF_AIRDROPS_URL: 'https://surf.test/airdrops', X_BATCH_SIZE: '1', FEED_BATCH_SIZE: '1' },
          makeExecCtx(),
        );
      },
    );

    const tickQueries = queries.slice(before);
    const upsertIdx = tickQueries.findIndex(q => /INSERT\s+INTO\s+snapshots/i.test(q));
    expect(upsertIdx).toBeGreaterThan(-1);
    const fullBodyReadsAfterUpsert = tickQueries
      .slice(upsertIdx + 1)
      .filter(q => /SELECT\s+key,\s+body/i.test(q));
    expect(fullBodyReadsAfterUpsert).toEqual([]);

    const seededDom = await db
      .prepare(`SELECT domain, origin FROM known_domains WHERE domain = 'freshsurf.xyz'`)
      .first<{ domain: string; origin: string }>();
    expect(seededDom).toEqual({ domain: 'freshsurf.xyz', origin: 'surf' });
  });

  test('*/5 cron honors D1 sources enabled/next_poll_at for curated sources and preserves deferred/failed prior cards', async () => {
    const { db } = createTestD1();
    const t0 = NOW;
    await ensureSourcesSynced(db);
    await db.prepare(`UPDATE sources SET enabled = 0 WHERE id = 'sheet:asso7878_sheet'`).run();
    await db
      .prepare(`UPDATE sources SET next_poll_at = ?1 WHERE id = 'feed:pendle_points'`)
      .bind(t0 + 10 * 60_000)
      .run();

    const makeCard = (n: string, source: string, url: string) => ({
      r: 1,
      n,
      id: `${source.toLowerCase()}:${n.toLowerCase()}`,
      t: null,
      g: 'A',
      b: ['live'],
      x: null,
      img: '',
      f: '—',
      tk: '1/1',
      h: 10,
      u: 'today',
      fit: ['zero'],
      best: { n: 'Task', ty: 'testnet', c: 'Free', m: '5m' },
      sc: 80,
      sub: [8, 8, null],
      url,
      source,
    });

    await upsertSnapshot(
      db,
      'airdrops',
      {
        cards: [
          makeCard('DisabledSheetCard', 'ASSO7878', 'https://disabled-sheet.xyz/'),
          makeCard('DeferredPendleCard', 'Pendle', 'https://app.pendle.finance/trade/markets/0x1'),
          makeCard('FailedMerklCard', 'Merkl', 'https://merkl-proto.xyz/'),
        ],
        tge: [],
        counts: { active: 3, preToken: 3 },
        fetchedAt: t0 - 31 * 60_000,
      },
      t0 - 31 * 60_000,
    );

    const fetchedUrls: string[] = [];
    const surfPayload = {
      active: [
        {
          project_id: 'live-surf',
          project_name: 'LiveSurf',
          grade: 'S',
          score: 90,
          best_task: { title: 'Swap', type: 'testnet', external_link: 'https://livesurf.xyz/' },
          tasks: [{ title: 'Swap', type: 'testnet', external_link: 'https://livesurf.xyz/' }],
        },
      ],
      tge: [],
    };

    await withStubbedFetch(
      url => {
        fetchedUrls.push(url);
        if (url === 'https://surf.test/airdrops') {
          return new Response(JSON.stringify(surfPayload), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('offline', { status: 503 });
      },
      async () => {
        await worker.scheduled(
          { cron: '*/5 * * * *', scheduledTime: t0, noRetry() {} } as ScheduledController,
          {
            DB: db,
            SURF_AIRDROPS_URL: 'https://surf.test/airdrops',
            ASSO7878_SHEET_URL: 'https://asso.test/csv',
            PENDLE_POINTS_URL: 'https://pendle.test/markets',
            MERKL_OPPORTUNITIES_URL: 'https://merkl.test/opps',
            X_BATCH_SIZE: '1',
            FEED_BATCH_SIZE: '1',
          },
          makeExecCtx(),
        );
      },
    );

    expect(fetchedUrls).toContain('https://surf.test/airdrops');
    expect(fetchedUrls).toContain('https://merkl.test/opps');
    expect(fetchedUrls).not.toContain('https://asso.test/csv');
    expect(fetchedUrls).not.toContain('https://pendle.test/markets');

    const snap = await readSnapshot(db, 'airdrops');
    const saved = JSON.parse(snap!.body) as { cards: { n: string; source?: string }[] };
    const names = saved.cards.map(c => c.n);
    expect(names).toContain('LiveSurf');
    expect(names).toContain('DeferredPendleCard');
    expect(names).toContain('FailedMerklCard');
    expect(names).not.toContain('DisabledSheetCard');
  });

  test('*/5 cron uses fresh cached airdrops:asso7878 and airdrops:arndxt snapshots without live sheet fetch, updates sheet health, and falls back when stale', async () => {
    const { db } = createTestD1();
    const t0 = NOW;
    const cachedAt = t0 - 15 * 60_000;
    await ensureSourcesSynced(db);

    const makeCard = (n: string, source: string, url: string) => ({
      r: 1,
      n,
      id: `${source.toLowerCase()}:${n.toLowerCase()}`,
      t: null,
      g: 'A',
      b: ['live'],
      x: null,
      img: '',
      f: '—',
      tk: '1/1',
      h: 10,
      u: 'today',
      fit: ['zero'],
      best: { n: 'Task', ty: 'testnet', c: 'Free', m: '5m' },
      sc: 80,
      sub: [8, 8, null],
      url,
      source,
    });

    await upsertSnapshot(
      db,
      'airdrops:asso7878',
      {
        cards: [makeCard('CachedAssoCard', 'ASSO7878', 'https://cached-asso.xyz/')],
        tge: [],
        counts: { active: 1, preToken: 1 },
        fetchedAt: cachedAt,
      },
      cachedAt,
    );
    await upsertSnapshot(
      db,
      'airdrops:arndxt',
      {
        cards: [makeCard('CachedArndxtCard', 'arndxt', 'https://cached-arndxt.xyz/')],
        tge: [],
        counts: { active: 1, preToken: 1 },
        fetchedAt: cachedAt,
      },
      cachedAt,
    );
    // Mark sheet sources previously degraded to confirm fresh cached snapshots restore ok health.
    await db
      .prepare(`UPDATE sources SET status = 'degraded', fail_count = 2, first_fail_at = ?1 WHERE id IN ('sheet:asso7878_sheet', 'sheet:arndxt_sheet')`)
      .bind(cachedAt - 60_000)
      .run();

    const surfPayload = {
      active: [
        {
          project_id: 'live-surf-2',
          project_name: 'LiveSurf2',
          grade: 'S',
          score: 90,
          best_task: { title: 'Swap', type: 'testnet', external_link: 'https://livesurf2.xyz/' },
          tasks: [{ title: 'Swap', type: 'testnet', external_link: 'https://livesurf2.xyz/' }],
        },
      ],
      tge: [],
    };

    const fetchedFresh: string[] = [];
    await withStubbedFetch(
      url => {
        fetchedFresh.push(url);
        if (url === 'https://surf.test/airdrops') {
          return new Response(JSON.stringify(surfPayload), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('offline', { status: 503 });
      },
      async () => {
        await worker.scheduled(
          { cron: '*/5 * * * *', scheduledTime: t0, noRetry() {} } as ScheduledController,
          {
            DB: db,
            SURF_AIRDROPS_URL: 'https://surf.test/airdrops',
            ASSO7878_SHEET_URL: 'https://asso.test/csv',
            ARNDXT_SHEET_URL: 'https://arndxt.test/csv',
            X_BATCH_SIZE: '1',
            FEED_BATCH_SIZE: '1',
          },
          makeExecCtx(),
        );
      },
    );

    expect(fetchedFresh).toContain('https://surf.test/airdrops');
    expect(fetchedFresh).not.toContain('https://asso.test/csv');
    expect(fetchedFresh).not.toContain('https://arndxt.test/csv');

    const saved = JSON.parse((await readSnapshot(db, 'airdrops'))!.body) as { cards: { n: string }[] };
    const names = saved.cards.map(c => c.n);
    expect(names).toContain('LiveSurf2');
    expect(names).toContain('CachedAssoCard');
    expect(names).toContain('CachedArndxtCard');

    const sheetRows = await db
      .prepare(`SELECT id, status, fail_count, first_fail_at, last_ok_at FROM sources WHERE platform = 'sheet' ORDER BY id ASC`)
      .all<{ id: string; status: string; fail_count: number; first_fail_at: number | null; last_ok_at: number | null }>();
    expect(sheetRows.results).toEqual([
      { id: 'sheet:arndxt_sheet', status: 'ok', fail_count: 0, first_fail_at: null, last_ok_at: cachedAt },
      { id: 'sheet:asso7878_sheet', status: 'ok', fail_count: 0, first_fail_at: null, last_ok_at: cachedAt },
    ]);

    // Stale (>6h) cached sheet snapshot falls back to live sheet fetch.
    const tLater = t0 + 7 * 3_600_000;
    const fetchedStale: string[] = [];
    await withStubbedFetch(
      url => {
        fetchedStale.push(url);
        if (url === 'https://surf.test/airdrops') {
          return new Response(JSON.stringify(surfPayload), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('offline', { status: 503 });
      },
      async () => {
        await worker.scheduled(
          { cron: '*/5 * * * *', scheduledTime: tLater, noRetry() {} } as ScheduledController,
          {
            DB: db,
            SURF_AIRDROPS_URL: 'https://surf.test/airdrops',
            ASSO7878_SHEET_URL: 'https://asso.test/csv',
            ARNDXT_SHEET_URL: 'https://arndxt.test/csv',
            X_BATCH_SIZE: '1',
            FEED_BATCH_SIZE: '1',
          },
          makeExecCtx(),
        );
      },
    );

    expect(fetchedStale).toContain('https://asso.test/csv');
    expect(fetchedStale).toContain('https://arndxt.test/csv');
  });

  test('*/5 cron ignores stale (>6h) airdrops:defillama snapshot and isolates pollXBatch / pollFeedBatch rejections', async () => {
    const { db } = createTestD1();
    const t0 = NOW;
    await ensureSourcesSynced(db);

    const staleAt = t0 - 7 * 3_600_000;
    await upsertSnapshot(
      db,
      'airdrops:defillama',
      {
        cards: [
          {
            r: 1,
            n: 'StaleTokenlessProto',
            id: 'defillama:staletokenless',
            t: null,
            g: 'A',
            b: ['early'],
            x: null,
            img: '',
            f: '—',
            tk: '1/1',
            h: 10,
            u: 'today',
            fit: ['small'],
            best: { n: 'Use proto', ty: 'liquidity', c: 'On-chain', m: '—' },
            sc: 74,
            sub: [7, 7, null],
            url: 'https://staletokenless.xyz/',
            source: 'DefiLlama',
          },
        ],
        tge: [],
        counts: { active: 1, preToken: 1 },
        fetchedAt: staleAt,
      },
      staleAt,
    );

    const surfPayload = {
      active: [
        {
          project_id: 'live-surf-fresh',
          project_name: 'LiveSurfFresh',
          grade: 'S',
          score: 90,
          best_task: { title: 'Swap', type: 'testnet', external_link: 'https://livesurffresh.xyz/' },
          tasks: [{ title: 'Swap', type: 'testnet', external_link: 'https://livesurffresh.xyz/' }],
        },
      ],
      tge: [],
    };

    // Simulate a transient D1 failure inside pollFeedBatch's initial SELECT while pollXBatch and postProcess/prune/decay succeed.
    const oldPostedAt = t0 - 31 * 86_400_000;
    await db
      .prepare(
        `INSERT INTO clusters (id, project, chains, task_types, summary, summary_source, risk_level, risk_reasons, score, source_count, first_seen, last_seen)
         VALUES ('c:old-iso', 'OldIso', '[]', '["other"]', 'rule', 'rule', 'ok', '[]', 1, 1, ?1, ?1)`,
      )
      .bind(oldPostedAt)
      .run();
    await db
      .prepare(
        `INSERT INTO posts (id, source_id, post_url, posted_at, text, urls, cluster_id, created_at)
         VALUES ('p:old-iso', 'telegram:ch1', 'https://t.me/ch1/9', ?1, 'old post', '[]', 'c:old-iso', ?1)`,
      )
      .bind(oldPostedAt)
      .run();

    const feedFailingDb = {
      ...db,
      prepare(sql: string) {
        if (/WHERE\s+platform\s*=\s*'feed'/i.test(sql)) {
          return {
            bind() {
              return {
                async all() {
                  throw new Error('D1 feed select error');
                },
              };
            },
          };
        }
        return db.prepare(sql);
      },
      batch(stmts: D1PreparedStatement[]) {
        return db.batch(stmts);
      },
      exec(sql: string) {
        return db.exec(sql);
      },
    } as unknown as D1Database;

    const origErr = console.error;
    const errors: unknown[][] = [];
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      await withStubbedFetch(
        url => {
          if (url === 'https://surf.test/airdrops') {
            return new Response(JSON.stringify(surfPayload), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          return new Response('offline', { status: 503 });
        },
        async () => {
          await worker.scheduled(
            { cron: '*/5 * * * *', scheduledTime: t0, noRetry() {} } as ScheduledController,
            {
              DB: feedFailingDb,
              SURF_AIRDROPS_URL: 'https://surf.test/airdrops',
              X_BATCH_SIZE: '1',
              FEED_BATCH_SIZE: '1',
            },
            makeExecCtx(),
          );
        },
      );
    } finally {
      console.error = origErr;
    }

    // Stale >6h airdrops:defillama was excluded from merged airdrops snapshot
    const saved = JSON.parse((await readSnapshot(db, 'airdrops'))!.body) as { cards: { n: string }[] };
    expect(saved.cards.map(c => c.n)).toContain('LiveSurfFresh');
    expect(saved.cards.map(c => c.n)).not.toContain('StaleTokenlessProto');

    // pollFeedBatch rejection was isolated and logged; prune still ran!
    expect(errors.some(args => args[0] === 'cron-error:pollFeedBatch')).toBe(true);
    const pruned = await db.prepare(`SELECT id FROM posts WHERE id = 'p:old-iso'`).first<{ id: string }>();
    expect(pruned).toBeNull();
  });
});
