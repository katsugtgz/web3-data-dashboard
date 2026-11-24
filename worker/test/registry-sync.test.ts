import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { applyMigrations } from './helpers';
import { SEED_SOURCES, syncSources, validateSources } from '../src/sources/registry';

/**
 * SQLite-backed D1 shim that counts every mutation statement actually run
 * against `sources`, so tests can assert "no write happened" exactly.
 */
function createCountingD1(): {
  db: D1Database;
  sourceWriteCount(): number;
  /** Patches the results of exactly the next `all()` read, then disarms — simulates syncSources reading a stale snapshot. */
  staleReadOnce(patch: (rows: object[]) => void): void;
} {
  const sqlite = new Database(':memory:');
  applyMigrations(sqlite);
  let writes = 0;
  let staleNext: ((rows: object[]) => void) | null = null;
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
      if (staleNext) {
        staleNext(results as object[]);
        staleNext = null;
      }
      return { results, success: true, meta: { changes: 0 } };
    },
    async run() {
      const info = sqlite.query(sql).run(...(params as []));
      // Count rows actually written, not statements issued: a guarded UPDATE
      // that matches no row (the race-loser case) must count as zero writes.
      writes += info.changes;
      return { success: true, meta: { changes: info.changes } };
    },
  });
  const db = {
    prepare(sql: string) {
      return makeStmt(sql);
    },
    async batch(stmts: TestStmt[]) {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
    async exec(sql: string) {
      sqlite.exec(sql);
      return { count: 1, duration: 0 };
    },
  } as unknown as D1Database;
  return { db, sourceWriteCount: () => writes, staleReadOnce: patch => (staleNext = patch) };
}

/** Minimal prepared-statement shape used by the D1 shim above. */
interface TestStmt {
  bind(...args: unknown[]): TestStmt;
  run(): Promise<unknown>;
}

async function getSource(db: D1Database, id: string): Promise<Record<string, unknown> | null> {
  return db
    .prepare('SELECT * FROM sources WHERE id = ?1')
    .bind(id)
    .first<Record<string, unknown>>();
}

const ONE = validateSources([{ platform: 'telegram', handle: 'alpha_feed', lang: 'en', trust: 0.8, tags: [], enabled: true }]);

describe('syncSources conditional registry sync', () => {
  test('initial sync inserts every configured source once with runtime defaults', async () => {
    const { db } = createCountingD1();
    const sources = validateSources([
      { platform: 'telegram', handle: 'alpha_feed', lang: 'en', trust: 0.8, tags: ['airdrop'], enabled: true },
      { platform: 'telegram', handle: 'beta_feed', lang: 'zh', trust: 0.4, tags: [], enabled: false },
    ]);

    await syncSources(db, sources);

    const row = await getSource(db, 'telegram:alpha_feed');
    expect(row).toMatchObject({ platform: 'telegram', handle: 'alpha_feed', lang: 'en', trust: 0.8, enabled: 1, status: 'ok', fail_count: 0 });
    const disabled = await getSource(db, 'telegram:beta_feed');
    expect(disabled?.enabled).toBe(0);
  });

  test('second sync with unchanged config performs zero writes', async () => {
    const { db, sourceWriteCount } = createCountingD1();
    const sources = validateSources([
      { platform: 'telegram', handle: 'alpha_feed', lang: 'en', trust: 0.8, tags: ['airdrop'], enabled: true },
      { platform: 'x', handle: 'DefiIgnas', lang: 'en', trust: 0.85, tags: [], enabled: true },
    ]);
    await syncSources(db, sources);
    const afterFirst = sourceWriteCount();
    expect(afterFirst).toBeGreaterThan(0);

    await syncSources(db, sources);

    expect(sourceWriteCount()).toBe(afterFirst);
  });

  test('runtime polling state survives unchanged sync', async () => {
    const { db } = createCountingD1();
    const sources = validateSources([
      { platform: 'x', handle: 'DefiIgnas', lang: 'en', trust: 0.85, tags: [], enabled: true },
    ]);
    await syncSources(db, sources);
    await db
      .prepare(
        `UPDATE sources SET status = 'degraded', fail_count = 4, next_poll_at = 123456, first_fail_at = 42,
         last_seen_id = '18880001', last_ok_at = 777, last_polled_at = 888 WHERE id = 'x:DefiIgnas'`,
      )
      .run();

    await syncSources(db, sources);

    const row = await getSource(db, 'x:DefiIgnas');
    expect(row).toMatchObject({
      status: 'degraded',
      fail_count: 4,
      next_poll_at: 123456,
      first_fail_at: 42,
      last_seen_id: '18880001',
      last_ok_at: 777,
      last_polled_at: 888,
      trust: 0.85,
      enabled: 1,
    });
  });

  test('changed config updates exactly the changed columns and keeps status/cursor', async () => {
    const { db, sourceWriteCount } = createCountingD1();
    const original = validateSources([
      { platform: 'telegram', handle: 'alpha_feed', lang: 'en', trust: 0.8, tags: [], enabled: true },
      { platform: 'telegram', handle: 'beta_feed', lang: 'en', trust: 0.5, tags: [], enabled: true },
    ]);
    await syncSources(db, original);
    await db
      .prepare(`UPDATE sources SET status = 'degraded', fail_count = 3, last_seen_id = '99' WHERE id = 'telegram:alpha_feed'`)
      .run();
    const baseline = sourceWriteCount();

    const updated = validateSources([
      { platform: 'telegram', handle: 'alpha_feed', lang: 'en', trust: 0.8, tags: [], enabled: true }, // unchanged
      { platform: 'telegram', handle: 'beta_feed', lang: 'zh', trust: 0.9, tags: [], enabled: false }, // changed
    ]);
    await syncSources(db, updated);

    expect(sourceWriteCount() - baseline).toBe(1);

    const untouched = await getSource(db, 'telegram:alpha_feed');
    expect(untouched).toMatchObject({ status: 'degraded', fail_count: 3, last_seen_id: '99', trust: 0.8 });

    const changed = await getSource(db, 'telegram:beta_feed');
    expect(changed).toMatchObject({ lang: 'zh', trust: 0.9, enabled: 0, status: 'ok', fail_count: 0 });
  });

  test('re-enabling a disabled source keeps its runtime history', async () => {
    const { db } = createCountingD1();
    await syncSources(db, validateSources([
      { platform: 'telegram', handle: 'alpha_feed', lang: 'en', trust: 0.8, tags: [], enabled: false },
    ]));
    await db
      .prepare(`UPDATE sources SET status = 'down', fail_count = 12, next_poll_at = 555 WHERE id = 'telegram:alpha_feed'`)
      .run();

    await syncSources(db, validateSources([
      { platform: 'telegram', handle: 'alpha_feed', lang: 'en', trust: 0.8, tags: [], enabled: true },
    ]));

    const row = await getSource(db, 'telegram:alpha_feed');
    expect(row).toMatchObject({ enabled: 1, status: 'down', fail_count: 12, next_poll_at: 555 });
  });

  test('concurrent entry-point syncs on fresh D1 never clobber each other or rewrite rows', async () => {
    const { db, sourceWriteCount } = createCountingD1();
    // Two crons starting in the same minute: both run syncSources concurrently
    // against an empty table through the same shim.
    await Promise.all([
      syncSources(db, SEED_SOURCES),
      syncSources(db, SEED_SOURCES),
    ]);

    // Every source exists exactly once with pristine runtime defaults.
    const rows = await db.prepare('SELECT id, status, fail_count FROM sources').all<{ id: string; status: string; fail_count: number }>();
    expect(rows.results?.length).toBe(SEED_SOURCES.length);
    expect(new Set(rows.results?.map(r => r.id)).size).toBe(SEED_SOURCES.length);
    for (const r of rows.results ?? []) {
      expect(r.status).toBe('ok');
      expect(r.fail_count).toBe(0);
    }

    // A settled no-op sync performs zero writes.
    const baseline = sourceWriteCount();
    await syncSources(db, SEED_SOURCES);
    expect(sourceWriteCount()).toBe(baseline);
  });

  test('guarded update is a no-op when a concurrent writer already applied the same config', async () => {
    const { db, sourceWriteCount, staleReadOnce } = createCountingD1();
    await syncSources(db, ONE);
    // Concurrent writer applies the same trust bump first...
    await db.prepare('UPDATE sources SET trust = 0.9 WHERE id = ?1').bind('telegram:alpha_feed').run();

    // Make the stale view real: patch syncSources' one full-table read to
    // return the pre-bump trust 0.8, exactly as it would mid-race; the
    // concurrent writer's 0.9 lands only after that read.
    staleReadOnce(rows => {
      for (const row of rows) {
        if ('id' in row && row.id === 'telegram:alpha_feed' && 'trust' in row) row.trust = 0.8;
      }
    });

    const baseline = sourceWriteCount();
    // syncSources now diffs against the stale 0.8 view and still must write
    // nothing: the guarded UPDATE's WHERE re-checks live values and matches no row.
    await syncSources(db, validateSources([{ platform: 'telegram', handle: 'alpha_feed', lang: 'en', trust: 0.9, tags: [], enabled: true }]));
    expect(sourceWriteCount() - baseline).toBe(0);

    const row = await getSource(db, 'telegram:alpha_feed');
    expect(row).toMatchObject({ trust: 0.9, status: 'ok' });
  });

  test('repo SEED_SOURCES round-trips with no writes on second sync', async () => {
    const { db, sourceWriteCount } = createCountingD1();
    await syncSources(db, SEED_SOURCES);
    const baseline = sourceWriteCount();
    await syncSources(db, SEED_SOURCES);
    expect(sourceWriteCount()).toBe(baseline);
  });

  test('an empty config still disables previously enabled rows (no early return)', async () => {
    const { db } = createCountingD1();
    await syncSources(db, ONE);
    await syncSources(db, []);
    const row = await getSource(db, 'telegram:alpha_feed');
    expect(row).toMatchObject({ enabled: 0, status: 'ok' }); // history kept
  });

  test('a case-only handle edit updates the existing row instead of inserting a parallel source', async () => {
    const { db } = createCountingD1();
    await syncSources(db, validateSources([
      { platform: 'telegram', handle: 'Alpha_Feed', lang: 'en', trust: 0.8, tags: [], enabled: true },
    ]));
    await db
      .prepare("UPDATE sources SET status = 'down', fail_count = 3, next_poll_at = 777 WHERE id = 'telegram:Alpha_Feed'")
      .run();

    await syncSources(db, validateSources([
      { platform: 'telegram', handle: 'alpha_feed', lang: 'en', trust: 0.8, tags: [], enabled: true },
    ]));

    const rows = await db.prepare('SELECT id, status, fail_count, enabled FROM sources').all<{ id: string; status: string; fail_count: number; enabled: number }>();
    expect(rows.results?.length).toBe(1);
    expect(rows.results?.[0]).toMatchObject({ id: 'telegram:Alpha_Feed', status: 'down', fail_count: 3, enabled: 1 });
  });

  test('a source removed from the config is disabled and stops polling, history intact', async () => {
    const { db, sourceWriteCount } = createCountingD1();
    await syncSources(db, validateSources([
      { platform: 'telegram', handle: 'keep_me', lang: 'en', trust: 0.8, tags: [], enabled: true },
      { platform: 'telegram', handle: 'drop_me', lang: 'en', trust: 0.7, tags: [], enabled: true },
    ]));
    await db
      .prepare("UPDATE sources SET status = 'ok', fail_count = 0, next_poll_at = 999 WHERE id = 'telegram:drop_me'")
      .run();
    const baseline = sourceWriteCount();

    await syncSources(db, validateSources([
      { platform: 'telegram', handle: 'keep_me', lang: 'en', trust: 0.8, tags: [], enabled: true },
    ]));

    expect(sourceWriteCount() - baseline).toBe(1); // exactly the disable write
    const dropped = await getSource(db, 'telegram:drop_me');
    expect(dropped).toMatchObject({ enabled: 0, next_poll_at: 999 }); // history preserved
    const kept = await getSource(db, 'telegram:keep_me');
    expect(kept).toMatchObject({ enabled: 1 });
  });

  test('a tags-only edit is persisted as a config change', async () => {
    const { db, sourceWriteCount } = createCountingD1();
    await syncSources(db, validateSources([
      { platform: 'telegram', handle: 'alpha_feed', lang: 'en', trust: 0.8, tags: [], enabled: true },
    ]));
    const baseline = sourceWriteCount();
    await syncSources(db, validateSources([
      { platform: 'telegram', handle: 'alpha_feed', lang: 'en', trust: 0.8, tags: ['alpha'], enabled: true },
    ]));
    expect(sourceWriteCount() - baseline).toBe(1);
    const row = await getSource(db, 'telegram:alpha_feed');
    expect(row).not.toBeNull();
    expect(JSON.parse((row?.tags as string) ?? 'null')).toEqual(['alpha']);
    expect(row).toMatchObject({ status: 'ok' });
  });
});
