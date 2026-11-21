import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { computeXBackoff, parseCdnSyndication, parseNextDataTimeline, pollXBatch } from '../src/sources/x';

function createSqliteD1(): D1Database {
  const sqlite = new Database(':memory:');
  for (const file of ['../migrations/0001_init.sql', '../migrations/0002_feed.sql', '../migrations/0003_p4.sql']) {
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

describe('X best-effort syndication parser & backoff', () => {
  test('parses __NEXT_DATA__ timeline JSON and CDN JSON gracefully', () => {
    const html = `<html><head></head><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: {
        pageProps: {
          timeline: {
            entries: [
              {
                content: {
                  tweet: {
                    id_str: '18880001',
                    created_at: '2026-11-21T01:00:00Z',
                    full_text: 'HyperLiquid Season 3 $HYPE points guide https://app.hyperliquid.xyz',
                    entities: { urls: [{ expanded_url: 'https://app.hyperliquid.xyz' }] },
                  },
                },
              },
            ],
          },
        },
      },
    })}</script></body></html>`;

    const parsed = parseNextDataTimeline(html, 'DefiIgnas');
    expect(parsed.length).toBe(1);
    expect(parsed[0].idStr).toBe('18880001');
    expect(parsed[0].postUrl).toBe('https://x.com/DefiIgnas/status/18880001');
    expect(parsed[0].urls).toEqual(['https://app.hyperliquid.xyz']);

    expect(parseCdnSyndication('', 'DefiIgnas')).toEqual([]);
  });

  test('applies exponential backoff -> degraded, then 24h -> down (6h poll)', async () => {
    const now = 1_795_240_000_000;
    const b1 = computeXBackoff(0, null, now);
    expect(b1.status).toBe('degraded');
    expect(b1.nextPollAt).toBe(now + 5 * 60_000);

    const bDown = computeXBackoff(8, now - 25 * 3_600_000, now);
    expect(bDown.status).toBe('down');
    expect(bDown.nextPollAt).toBe(now + 6 * 3_600_000);

    const db = createSqliteD1();
    await db
      .prepare(`INSERT INTO sources (id, platform, handle, lang, trust, enabled) VALUES ('x:DefiIgnas', 'x', 'DefiIgnas', 'en', 0.85, 1)`)
      .run();

    const summary = await pollXBatch(db, 3, now, null, async () => {
      throw new Error('429 rate limited');
    });
    expect(summary.polled).toBe(1);
    expect(summary.degraded).toBe(1);

    const row = await db.prepare(`SELECT status, fail_count FROM sources WHERE id = 'x:DefiIgnas'`).first<{ status: string; fail_count: number }>();
    expect(row?.status).toBe('degraded');
    expect(row?.fail_count).toBe(1);
  });
});
