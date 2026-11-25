import { describe, expect, test } from 'bun:test';
import { createTestD1 } from './helpers';
import {
  computeXBackoff,
  fetchXTimelineBestEffort,
  parseCdnSyndication,
  parseNextDataTimeline,
  parseXRssTimeline,
  pollXBatch,
} from '../src/sources/x';

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

  test('fetchXTimelineBestEffort skips dead cdn.syndication endpoint and tries optional rssMirrorBase first', async () => {
    const requested: string[] = [];
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      if (url.startsWith('https://mirror.example/DefiIgnas/rss')) {
        return new Response(
          `<?xml version="1.0"?><rss version="2.0"><channel>
            <item>
              <title>Monad points guide https://monad.xyz/quest</title>
              <link>https://mirror.example/DefiIgnas/status/212500001#m</link>
              <pubDate>Mon, 23 Nov 2026 12:00:00 GMT</pubDate>
              <description><![CDATA[<p>Farm points on <a href="https://monad.xyz/quest?ref=xyz">Monad</a></p>]]></description>
            </item>
          </channel></rss>`,
          { status: 200, headers: { 'Content-Type': 'application/rss+xml' } },
        );
      }
      return new Response('rate limited', { status: 429 });
    }) as unknown as typeof fetch;

    try {
      // With mirror configured: tries mirror first and canonicalizes link to x.com
      const withMirror = await fetchXTimelineBestEffort('DefiIgnas', 'https://mirror.example');
      expect(requested).toEqual(['https://mirror.example/DefiIgnas/rss']);
      expect(withMirror.length).toBe(1);
      expect(withMirror[0].idStr).toBe('212500001');
      expect(withMirror[0].postUrl).toBe('https://x.com/DefiIgnas/status/212500001');
      expect(withMirror[0].urls).toContain('https://monad.xyz/quest');

      // Without mirror: never touches dead cdn.syndication.twimg.com
      requested.length = 0;
      await expect(fetchXTimelineBestEffort('DefiIgnas')).rejects.toThrow();
      expect(requested).toEqual(['https://syndication.twitter.com/srv/timeline-profile/screen-name/DefiIgnas']);
      expect(requested.some(u => u.includes('cdn.syndication.twimg.com'))).toBe(false);
    } finally {
      globalThis.fetch = prevFetch;
    }

    // parseXRssTimeline rejects undated items
    expect(
      parseXRssTimeline(`<rss><channel><item><title>No date</title><link>https://x.com/a/status/123456</link></item></channel></rss>`, 'a'),
    ).toEqual([]);
  });

  test('hardens rssMirrorBase (rejects http/IP/localhost/.local/creds/query/hash), filters mirror subdomains & redirect host, strips script/style, preserves <br> newlines, falls back to guid, and preserves raw-IP hrefs', async () => {
    const requested: string[] = [];
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      if (url.startsWith('https://mirror.example/DefiIgnas/rss')) {
        const res = new Response(
          `<?xml version="1.0"?><rss version="2.0"><channel>
            <item>
              <title>Fallback title</title>
              <link>https://mirror.example/DefiIgnas</link>
              <guid>https://x.com/DefiIgnas/status/212500009</guid>
              <pubDate>Mon, 23 Nov 2026 12:00:00 GMT</pubDate>
              <description><![CDATA[<style>.hide{display:none}</style><script>alert(1)</script><p>Line one<br/>Line two <a href="https://pic.mirror.example/photo.png">img</a> <a href="https://cdn.redirected-mirror.net/a.png">redir</a> <a href="https://realproto.xyz/quest">Quest</a> <a href="http://185.220.101.9/claim">Phish</a> <a href="http://1.1.1.1/">DNS</a></p>]]></description>
            </item>
          </channel></rss>`,
          { status: 200, headers: { 'Content-Type': 'application/rss+xml' } },
        );
        Object.defineProperty(res, 'url', { value: 'https://alt.redirected-mirror.net/DefiIgnas/rss' });
        return res;
      }
      return new Response('rate limited', { status: 429 });
    }) as unknown as typeof fetch;

    try {
      const unsafeBases = [
        'http://mirror.example',
        'https://127.0.0.1',
        'https://169.254.169.254',
        'https://localhost',
        'https://internal.local',
        'https://user:pass@mirror.example',
        'https://mirror.example/?foo=bar',
        'https://mirror.example/#frag',
      ];
      for (const bad of unsafeBases) {
        requested.length = 0;
        await expect(fetchXTimelineBestEffort('DefiIgnas', bad)).rejects.toThrow();
        expect(requested).toEqual(['https://syndication.twitter.com/srv/timeline-profile/screen-name/DefiIgnas']);
      }

      requested.length = 0;
      const posts = await fetchXTimelineBestEffort('DefiIgnas', 'https://mirror.example/');
      expect(posts.length).toBe(1);
      expect(posts[0].idStr).toBe('212500009');
      expect(posts[0].text).toContain('Line one\nLine two');
      expect(posts[0].text).not.toContain('alert(1)');
      expect(posts[0].text).not.toContain('display:none');
      expect(posts[0].urls).toContain('https://realproto.xyz/quest');
      expect(posts[0].urls).toContain('http://185.220.101.9/claim');
      expect(posts[0].urls.some(u => u.includes('1.1.1.1'))).toBe(false);
      expect(posts[0].urls.some(u => u.includes('mirror.example'))).toBe(false);
      expect(posts[0].urls.some(u => u.includes('redirected-mirror.net'))).toBe(false);
    } finally {
      globalThis.fetch = prevFetch;
    }
  });

  test('pollXBatch caps ingested relevant tweets per source to MAX_POSTS_PER_POLL = 10', async () => {
    const now = 1_795_240_000_000;
    const db = createSqliteD1();
    await db
      .prepare(`INSERT INTO sources (id, platform, handle, lang, trust, enabled) VALUES ('x:BusyAlpha', 'x', 'BusyAlpha', 'en', 0.85, 1)`)
      .run();

    const tweets = Array.from({ length: 15 }, (_, i) => ({
      idStr: String(19000000 + i),
      postUrl: `https://x.com/BusyAlpha/status/${19000000 + i}`,
      postedAt: now - (15 - i) * 60_000,
      text: `Proto${i} testnet airdrop quest live at https://xproto${i}.xyz/quest`,
      urls: [`https://xproto${i}.xyz/quest`],
    }));

    const summary = await pollXBatch(db, 3, now, null, async () => tweets);
    expect(summary.insertedPosts).toBe(10);
  });

  test('fetchXTimelineBestEffort uses manual redirects, validates redirect destinations before following, and falls back to syndication on unsafe redirects', async () => {
    const requests: { url: string; redirect?: string }[] = [];
    const prevFetch = globalThis.fetch;

    try {
      // 1. Unsafe redirect targets must NEVER be requested; must fall back to syndication.
      const unsafeLocations = [
        'http://mirror.example/DefiIgnas/rss',
        'https://127.0.0.1/internal',
        'https://169.254.169.254/latest/meta-data/',
        'https://localhost/rss',
        'https://user:pass@alt.example/rss',
      ];
      for (const badLocation of unsafeLocations) {
        requests.length = 0;
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          requests.push({ url, redirect: init?.redirect });
          if (url === 'https://mirror.example/DefiIgnas/rss') {
            return new Response('', { status: 302, headers: { Location: badLocation } });
          }
          return new Response('rate limited', { status: 429 });
        }) as unknown as typeof fetch;

        await expect(fetchXTimelineBestEffort('DefiIgnas', 'https://mirror.example')).rejects.toThrow();
        expect(requests[0]).toEqual({ url: 'https://mirror.example/DefiIgnas/rss', redirect: 'manual' });
        expect(requests.some(r => r.url === badLocation)).toBe(false);
        expect(requests.map(r => r.url)).toEqual([
          'https://mirror.example/DefiIgnas/rss',
          'https://syndication.twitter.com/srv/timeline-profile/screen-name/DefiIgnas',
        ]);
      }

      // 2. Safe HTTPS redirect is followed manually and its host is filtered out of post URLs.
      requests.length = 0;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        requests.push({ url, redirect: init?.redirect });
        if (url === 'https://mirror.example/DefiIgnas/rss') {
          return new Response('', {
            status: 302,
            headers: { Location: 'https://alt.redirected-mirror.net/DefiIgnas/rss' },
          });
        }
        if (url === 'https://alt.redirected-mirror.net/DefiIgnas/rss') {
          return new Response(
            `<?xml version="1.0"?><rss version="2.0"><channel><item>
              <title>Safe redirect post</title>
              <link>https://alt.redirected-mirror.net/DefiIgnas/status/212500077</link>
              <pubDate>Mon, 23 Nov 2026 12:00:00 GMT</pubDate>
              <description><![CDATA[<a href="https://alt.redirected-mirror.net/img.png">img</a> <a href="https://realdrop.xyz/quest">Drop</a>]]></description>
            </item></channel></rss>`,
            { status: 200, headers: { 'Content-Type': 'application/rss+xml' } },
          );
        }
        return new Response('unexpected', { status: 500 });
      }) as unknown as typeof fetch;

      const followed = await fetchXTimelineBestEffort('DefiIgnas', 'https://mirror.example');
      expect(requests).toEqual([
        { url: 'https://mirror.example/DefiIgnas/rss', redirect: 'manual' },
        { url: 'https://alt.redirected-mirror.net/DefiIgnas/rss', redirect: 'manual' },
      ]);
      expect(followed.length).toBe(1);
      expect(followed[0].urls).toEqual(['https://realdrop.xyz/quest']);
    } finally {
      globalThis.fetch = prevFetch;
    }
  });
});
