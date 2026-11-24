import { describe, expect, test } from 'bun:test';
import { createTestD1 } from './helpers';
import { computeXBackoff, parseCdnSyndication, parseNextDataTimeline, pollXBatch } from '../src/sources/x';

function createSqliteD1(): D1Database {
  return createTestD1().db;
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

  test('parses CDN JSON {entries:[...]} payloads and rejects undated tweets in both paths', () => {
    const now = Date.parse('2026-11-21T00:00:00Z');
    const body = JSON.stringify({
      entries: [
        {
          id_str: '18880002',
          created_at: 'Wed Nov 19 10:30:00 +0000 2026',
          full_text: 'Airdrop checklist https://example.com/guide',
          entities: { urls: [{ url: 'https://t.co/x', expanded_url: 'https://example.com/guide' }] },
        },
        // Undated: must be dropped, never stamped with the current time.
        { id_str: '18880003', full_text: 'undated post' },
        // Invalid date string: also dropped.
        { id_str: '18880004', created_at: 'garbage', full_text: 'bad date post' },
      ],
    });
    const parsed = parseCdnSyndication(body, 'DefiIgnas');
    expect(parsed.map(p => p.idStr)).toEqual(['18880002']);
    expect(parsed[0].postUrl).toBe('https://x.com/DefiIgnas/status/18880002');
    expect(parsed[0].urls).toEqual(['https://example.com/guide']);
    expect(parsed[0].postedAt).toBeLessThanOrEqual(now);

    // __NEXT_DATA__ path: same rejection rule.
    const undatedHtml = `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: { pageProps: { timeline: { entries: [{ content: { tweet: { id_str: '1', full_text: 'x' } } }] } } },
    })}</script></html>`;
    expect(parseNextDataTimeline(undatedHtml, 'DefiIgnas')).toEqual([]);
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

  test('pollXBatch success: ingests drop tweets, skips non-drop chatter, advances last_seen_id, resets fail_count', async () => {
    const now = 1_795_240_000_000;
    const db = createSqliteD1();
    await db
      .prepare(
        `INSERT INTO sources (id, platform, handle, lang, trust, enabled, last_seen_id, fail_count, first_fail_at, status)
         VALUES ('x:DefiIgnas', 'x', 'DefiIgnas', 'en', 0.85, 1, '18880001', 2, ?1, 'degraded')`,
      )
      .bind(now - 3_600_000)
      .run();

    const postedAt = now - 60_000;
    const summary = await pollXBatch(db, 3, now, null, async handle => [
      {
        idStr: '18880009',
        postUrl: `https://x.com/${handle}/status/18880009`,
        postedAt,
        text: 'Fresh testnet airdrop quest live https://novaproto.xyz/quest',
        urls: ['https://novaproto.xyz/quest'],
      },
      // Newer non-drop chatter: skipped from ingest, but cursor still advances past it.
      {
        idStr: '18880010',
        postUrl: `https://x.com/${handle}/status/18880010`,
        postedAt,
        text: 'Good morning everyone, grabbing coffee before checking charts!',
        urls: [],
      },
      // Older than last_seen_id: filtered out by the cursor, not by cutoff.
      {
        idStr: '18880001',
        postUrl: `https://x.com/${handle}/status/18880001`,
        postedAt,
        text: 'old seeded airdrop post',
        urls: [],
      },
    ]);

    expect(summary.polled).toBe(1);
    expect(summary.degraded).toBe(0);
    expect(summary.insertedPosts).toBe(1);
    expect(summary.ingestedResults.length).toBe(1);

    const row = await db
      .prepare(`SELECT status, fail_count, first_fail_at, last_seen_id FROM sources WHERE id = 'x:DefiIgnas'`)
      .first<{ status: string; fail_count: number; first_fail_at: number | null; last_seen_id: string }>();
    expect(row?.status).toBe('ok');
    expect(row?.fail_count).toBe(0);
    expect(row?.first_fail_at).toBeNull();
    expect(row?.last_seen_id).toBe('18880010');
  });

  test('pollXBatch degrades the whole batch when loadKnownDomains fails (cron survives)', async () => {
    const now = 1_795_240_000_000;
    const db = createSqliteD1();
    await db
      .prepare(`INSERT INTO sources (id, platform, handle, lang, trust, enabled) VALUES ('x:A', 'x', 'A', 'en', 0.8, 1)`)
      .run();
    // Break the known_domains table so loadKnownDomains rejects.
    await db.exec('DROP TABLE known_domains');

    const summary = await pollXBatch(db, 3, now, null, async () => {
      throw new Error('fetcher must not be reached');
    });
    expect(summary.polled).toBe(1);
    expect(summary.degraded).toBe(1);
    expect(summary.insertedPosts).toBe(0);

    const row = await db.prepare(`SELECT status, last_polled_at FROM sources WHERE id = 'x:A'`).first<{ status: string; last_polled_at: number }>();
    expect(row?.status).toBe('degraded');
    expect(row?.last_polled_at).toBe(now);
  });
});
