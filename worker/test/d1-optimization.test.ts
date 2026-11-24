import { describe, expect, test } from 'bun:test';
import { runIfDue } from '../src/lib/cronGate';
import { listSnapshotsByPrefix, upsertSnapshot } from '../src/lib/db';
import { applyMigrations, createTestD1, MIGRATION_FILES } from './helpers';

describe('migration 0005 backfill and columns', () => {
  test('backfills trust_max from linked sources and defaults orphans to 0.5', async () => {
    const { db, sqlite } = createTestD1(MIGRATION_FILES.slice(0, 4));

    await db
      .prepare(
        `INSERT INTO sources (id, platform, handle, lang, trust, enabled)
         VALUES ('telegram:hi', 'telegram', 'hi', 'en', 0.85, 1),
                ('telegram:lo', 'telegram', 'lo', 'en', 0.4, 1)`,
      )
      .run();

    await db
      .prepare(
        `INSERT INTO clusters (id, project, chains, task_types, summary, summary_source, risk_level, risk_reasons, score, source_count, first_seen, last_seen)
         VALUES ('c-linked', 'LinkedProto', '[]', '["quest"]', 'Linked summary', 'rule', 'ok', '[]', 1.0, 2, 1000, 2000),
                ('c-orphan', 'OrphanProto', '[]', '["other"]', 'Orphan summary', 'rule', 'ok', '[]', 0.5, 0, 1000, 1500)`,
      )
      .run();

    await db
      .prepare(
        `INSERT INTO posts (id, source_id, post_url, posted_at, text, urls, cluster_id, created_at)
         VALUES ('p1', 'telegram:hi', 'https://t.me/hi/1', 1500, 'post 1', '[]', 'c-linked', 1500),
                ('p2', 'telegram:lo', 'https://t.me/lo/1', 2000, 'post 2', '[]', 'c-linked', 2000)`,
      )
      .run();

    applyMigrations(sqlite, [MIGRATION_FILES[4]]);

    const linked = await db
      .prepare('SELECT trust_max, ai_attempts, ai_retry_after FROM clusters WHERE id = ?1')
      .bind('c-linked')
      .first<{ trust_max: number; ai_attempts: number; ai_retry_after: number }>();
    const orphan = await db
      .prepare('SELECT trust_max, ai_attempts, ai_retry_after FROM clusters WHERE id = ?1')
      .bind('c-orphan')
      .first<{ trust_max: number; ai_attempts: number; ai_retry_after: number }>();

    expect(linked).toEqual({ trust_max: 0.85, ai_attempts: 0, ai_retry_after: 0 });
    expect(orphan).toEqual({ trust_max: 0.5, ai_attempts: 0, ai_retry_after: 0 });
  });
});

describe('listSnapshotsByPrefix', () => {
  test('filters by prefix sorted ASC and returns all rows for empty prefix', async () => {
    const { db } = createTestD1();
    const now = 1_795_240_000_000;
    for (const key of ['markets:z', 'markets:a', 'markets:m', 'airdrops', 'markets_extra', 'marketz']) {
      await upsertSnapshot(db, key, { key }, now);
    }

    const prefixed = await listSnapshotsByPrefix(db, 'markets:');
    expect(prefixed.map(r => r.key)).toEqual(['markets:a', 'markets:m', 'markets:z']);

    const all = await listSnapshotsByPrefix(db, '');
    expect(all.map(r => r.key)).toEqual([
      'airdrops',
      'markets:a',
      'markets:m',
      'markets:z',
      'markets_extra',
      'marketz',
    ]);
  });
});

describe('cronGate runIfDue', () => {
  test('runs when missing, skips within intervalMs with 1 SELECT and 0 writes, and reruns at boundary', async () => {
    const { db, queries } = createTestD1();
    const intervalMs = 60_000;
    const t0 = 1_795_240_000_000;
    let calls = 0;

    const ran1 = await runIfDue(db, 'job:a', intervalMs, t0, async () => {
      calls++;
    });
    expect(ran1).toBe(true);
    expect(calls).toBe(1);

    const row1 = await db
      .prepare('SELECT last_run_at FROM cron_state WHERE key = ?1')
      .bind('job:a')
      .first<{ last_run_at: number }>();
    expect(row1?.last_run_at).toBe(t0);

    // Within intervalMs: returns false, does not call fn, 1 SELECT only, 0 writes.
    const beforeSkip = queries.length;
    const ran2 = await runIfDue(db, 'job:a', intervalMs, t0 + intervalMs - 1, async () => {
      calls++;
    });
    expect(ran2).toBe(false);
    expect(calls).toBe(1);
    const skipQueries = queries.slice(beforeSkip);
    expect(skipQueries.length).toBe(1);
    expect(skipQueries[0]).not.toMatch(/INSERT|UPDATE/i);

    // Exact boundary (nowMs - last_run_at === intervalMs): reruns and updates last_run_at.
    const t1 = t0 + intervalMs;
    const ran3 = await runIfDue(db, 'job:a', intervalMs, t1, async () => {
      calls++;
    });
    expect(ran3).toBe(true);
    expect(calls).toBe(2);
    const row2 = await db
      .prepare('SELECT last_run_at FROM cron_state WHERE key = ?1')
      .bind('job:a')
      .first<{ last_run_at: number }>();
    expect(row2?.last_run_at).toBe(t1);
  });

  test('does not advance cron_state when fn throws (both missing and previously run)', async () => {
    const { db } = createTestD1();
    const intervalMs = 60_000;
    const t0 = 1_795_240_000_000;

    await expect(
      runIfDue(db, 'job:missing', intervalMs, t0, async () => {
        throw new Error('boom missing');
      }),
    ).rejects.toThrow('boom missing');

    const missingRow = await db
      .prepare('SELECT last_run_at FROM cron_state WHERE key = ?1')
      .bind('job:missing')
      .first<{ last_run_at: number }>();
    expect(missingRow).toBeNull();

    // Seed an earlier successful run, then fail on the next due tick.
    await runIfDue(db, 'job:existing', intervalMs, t0, async () => {});
    await expect(
      runIfDue(db, 'job:existing', intervalMs, t0 + intervalMs, async () => {
        throw new Error('boom existing');
      }),
    ).rejects.toThrow('boom existing');

    const existingRow = await db
      .prepare('SELECT last_run_at FROM cron_state WHERE key = ?1')
      .bind('job:existing')
      .first<{ last_run_at: number }>();
    expect(existingRow?.last_run_at).toBe(t0);
  });

  test('rejects out-of-order older nowMs both sequentially and under overlapping writes', async () => {
    const { db, queries } = createTestD1();
    const intervalMs = 60_000;
    const t0 = 1_795_240_000_000;

    await runIfDue(db, 'job:order', intervalMs, t0, async () => {});

    // 1. Sequential older nowMs < last_run_at: skips without calling fn or writing.
    let seqCalls = 0;
    const beforeSeq = queries.length;
    const seqRan = await runIfDue(db, 'job:order', intervalMs, t0 - 5_000, async () => {
      seqCalls++;
    });
    expect(seqRan).toBe(false);
    expect(seqCalls).toBe(0);
    const seqQueries = queries.slice(beforeSeq);
    expect(seqQueries.length).toBe(1);
    expect(seqQueries[0]).not.toMatch(/INSERT|UPDATE/i);

    // 2. Overlapping race: an older run finishes after a newer timestamp already committed.
    const tOlder = t0 + intervalMs;
    const tNewer = tOlder + 10_000;
    const ranOlder = await runIfDue(db, 'job:order', intervalMs, tOlder, async () => {
      await db
        .prepare(
          `INSERT INTO cron_state (key, last_run_at) VALUES (?1, ?2)
           ON CONFLICT(key) DO UPDATE SET last_run_at = excluded.last_run_at
           WHERE excluded.last_run_at >= cron_state.last_run_at`,
        )
        .bind('job:order', tNewer)
        .run();
    });
    expect(ranOlder).toBe(true);

    const row = await db
      .prepare('SELECT last_run_at FROM cron_state WHERE key = ?1')
      .bind('job:order')
      .first<{ last_run_at: number }>();
    expect(row?.last_run_at).toBe(tNewer);
  });
});

function assertIndexedNoTempBTree(plan: { detail: string }[], expectedIndexPatterns: RegExp[]): void {
  expect(plan.length).toBeGreaterThan(0);
  const details = plan.map(step => step.detail);
  for (const detail of details) {
    expect(detail).not.toMatch(/TEMP B-TREE/i);
  }
  const joined = details.join('\n');
  expect(joined).toMatch(/USING (?:COVERING )?INDEX \S+|sqlite_autoindex_/i);
  for (const pattern of expectedIndexPatterns) {
    expect(joined).toMatch(pattern);
  }
}

describe('migration 0005 query plans', () => {
  test('drops clusters_score and uses indexed plans without TEMP B-TREE for all hot queries', async () => {
    const { db, explain } = createTestD1();

    const dropped = await db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'clusters_score'`)
      .first<{ name: string }>();
    expect(dropped).toBeNull();

    // 1. AI backlog query
    assertIndexedNoTempBTree(
      explain(
        `SELECT c.id, c.project, c.risk_level
         FROM clusters c
         WHERE c.summary_source = 'rule'
           AND c.risk_level != 'risk'
           AND c.ai_attempts < 3
           AND c.ai_retry_after <= ?1
           AND EXISTS (SELECT 1 FROM posts p WHERE p.cluster_id = c.id)
         ORDER BY c.score DESC, c.last_seen DESC
         LIMIT ?2`,
        [1000, 10],
      ),
      [/clusters_ai_backlog/, /posts_cluster/],
    );

    // 2. queryFeed score sort (risk included)
    assertIndexedNoTempBTree(
      explain(
        `SELECT id, project, ticker, domain, chains, task_types, summary, summary_source,
                risk_level, risk_reasons, score, source_count, surf_tier, surf_rank, first_seen, last_seen
         FROM clusters
         WHERE last_seen >= ?1
         ORDER BY score DESC, last_seen DESC, id ASC
         LIMIT ?2`,
        [0, 100],
      ),
      [/clusters_feed_score/],
    );

    // 3. queryFeed score sort (risk excluded)
    assertIndexedNoTempBTree(
      explain(
        `SELECT id, project, ticker, domain, chains, task_types, summary, summary_source,
                risk_level, risk_reasons, score, source_count, surf_tier, surf_rank, first_seen, last_seen
         FROM clusters
         WHERE last_seen >= ?1 AND risk_level != 'risk'
         ORDER BY score DESC, last_seen DESC, id ASC
         LIMIT ?2`,
        [0, 100],
      ),
      [/clusters_feed_score/],
    );

    // 4. queryFeed new sort (risk included)
    assertIndexedNoTempBTree(
      explain(
        `SELECT id, project, ticker, domain, chains, task_types, summary, summary_source,
                risk_level, risk_reasons, score, source_count, surf_tier, surf_rank, first_seen, last_seen
         FROM clusters
         WHERE last_seen >= ?1
         ORDER BY last_seen DESC, score DESC, id ASC
         LIMIT ?2`,
        [0, 100],
      ),
      [/clusters_feed_new/],
    );

    // 5. queryFeed new sort (risk excluded)
    assertIndexedNoTempBTree(
      explain(
        `SELECT id, project, ticker, domain, chains, task_types, summary, summary_source,
                risk_level, risk_reasons, score, source_count, surf_tier, surf_rank, first_seen, last_seen
         FROM clusters
         WHERE last_seen >= ?1 AND risk_level != 'risk'
         ORDER BY last_seen DESC, score DESC, id ASC
         LIMIT ?2`,
        [0, 100],
      ),
      [/clusters_feed_new/],
    );

    // 6. pollTelegramBatch source polling query
    assertIndexedNoTempBTree(
      explain(
        `SELECT id, handle, trust, last_seen_id, fail_count
         FROM sources
         WHERE platform = 'telegram' AND enabled = 1
         ORDER BY last_polled_at ASC NULLS FIRST
         LIMIT ?1`,
        [4],
      ),
      [/sources_poll/],
    );

    // 7. pollXBatch source polling query
    assertIndexedNoTempBTree(
      explain(
        `SELECT id, handle, trust, last_seen_id, fail_count, first_fail_at
         FROM sources
         WHERE platform = 'x' AND enabled = 1 AND (next_poll_at IS NULL OR next_poll_at <= ?1)
         ORDER BY last_polled_at ASC NULLS FIRST
         LIMIT ?2`,
        [1000, 3],
      ),
      [/sources_poll/],
    );

    // 8. decayClusterScores clusters-only PK scan
    assertIndexedNoTempBTree(
      explain(
        `SELECT id, source_count, last_seen, surf_tier, risk_level, score, trust_max
         FROM clusters
         WHERE id > ?1
         ORDER BY id ASC
         LIMIT ?2`,
        ['', 400],
      ),
      [/sqlite_autoindex_clusters_1/],
    );

    // 9. listSnapshotsByPrefix
    assertIndexedNoTempBTree(
      explain(
        `SELECT key, body, etag, fetched_at, ok, error
         FROM snapshots
         WHERE key >= ?1 AND key < ?2
         ORDER BY key ASC`,
        ['markets:', 'markets;'],
      ),
      [/sqlite_autoindex_snapshots_1/],
    );
  });
});
