import { describe, expect, test } from 'bun:test';
import { createTestD1 } from './helpers';
import { parseDropPost } from '../src/normalize/parse';
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

    const now = Date.parse('2026-11-24T12:00:00Z');
    try {
      // With mirror configured: tries mirror first and canonicalizes link to x.com
      const withMirror = await fetchXTimelineBestEffort('DefiIgnas', 'https://mirror.example', now);
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

  test('accepts explicitly configured local/Docker RSS mirror bases (rsshub, 127.0.0.1, localhost over http) and parses RSSHub twitter/user RSS', async () => {
    const now = Date.parse('2026-11-24T12:00:00Z');
    const prevFetch = globalThis.fetch;
    const requested: string[] = [];
    // Shape served by RSSHub /twitter/user/<handle>/rss (verified against a live RSSHub instance).
    const rssHubXml = (mirrorBase: string) => `<?xml version="1.0" encoding="UTF-8"?><rss xmlns:atom="http://www.w3.org/2005/Atom" version="2.0"><channel>
      <title>Twitter / DefiIgnas</title>
      <link>https://twitter.com/DefiIgnas</link>
      <atom:link href="${mirrorBase}/DefiIgnas/rss" rel="self" type="application/rss+xml"></atom:link>
      <description>Twitter User for DefiIgnas , Powered by RSSHub(https://github.com/DIYgod/RSSHub)</description>
      <lastBuildDate>Mon, 23 Nov 2026 12:05:00 GMT</lastBuildDate>
      <ttl>300</ttl>
      <item>
        <title>Monad points guide</title>
        <description>&lt;a href="https://twitter.com/DefiIgnas"&gt;Monad&lt;/a&gt; points guide: farm &lt;a href="https://monad.xyz/quest?ref=xyz"&gt;monad.xyz/quest&lt;/a&gt;&lt;br&gt;New testnet is live ${mirrorBase}/DefiIgnas</description>
        <pubDate>Mon, 23 Nov 2026 12:00:00 GMT</pubDate>
        <guid isPermaLink="false">https://twitter.com/DefiIgnas/status/212500201</guid>
        <link>https://twitter.com/DefiIgnas/status/212500201</link>
      </item>
      <item>
        <title>RT @OtherAcct: NovaDrop testnet airdrop is live https://t.co/AbC123</title>
        <description><![CDATA[RT @OtherAcct: <a href="https://twitter.com/OtherAcct">@OtherAcct</a> NovaDrop testnet airdrop is live <a href="https://t.co/AbC123">https://t.co/AbC123</a>]]></description>
        <pubDate>Mon, 23 Nov 2026 12:03:00 GMT</pubDate>
        <guid isPermaLink="false">https://x.com/DefiIgnas/status/212500202</guid>
        <link>https://x.com/DefiIgnas/status/212500202</link>
      </item>
      <item>
        <title>No status id here</title>
        <link>https://twitter.com/DefiIgnas</link>
        <pubDate>Mon, 23 Nov 2026 12:04:00 GMT</pubDate>
        <description>profile link only</description>
      </item>
      <item>
        <title>Undated item is dropped</title>
        <link>https://x.com/DefiIgnas/status/212500203</link>
        <description>no pubDate</description>
      </item>
    </channel></rss>`;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      if (url.includes('rsshub:1200/') || url.startsWith('http://127.0.0.1:1200/') || url.startsWith('http://localhost:1200/')) {
        return new Response(rssHubXml(url.slice(0, url.indexOf('/DefiIgnas/rss'))), {
          status: 200,
          headers: { 'Content-Type': 'application/rss+xml' },
        });
      }
      return new Response('rate limited', { status: 429 });
    }) as unknown as typeof fetch;

    try {
      for (const base of ['http://rsshub:1200/twitter/user', 'http://127.0.0.1:1200/twitter/user', 'http://localhost:1200/twitter/user']) {
        requested.length = 0;
        const posts = await fetchXTimelineBestEffort('DefiIgnas', base, now);
        // Only the configured local mirror is contacted; syndication is never touched.
        expect(requested).toEqual([`${base}/DefiIgnas/rss`]);
        expect(posts.map(p => p.idStr)).toEqual(['212500201', '212500202']);

        const [guide, rt] = posts;
        expect(guide.postUrl).toBe('https://x.com/DefiIgnas/status/212500201');
        expect(rt.postUrl).toBe('https://x.com/DefiIgnas/status/212500202');
        expect(guide.postedAt).toBe(Date.parse('Mon, 23 Nov 2026 12:00:00 GMT'));
        // HTML description: anchors + <br> newlines, mirror self-links stripped.
        expect(guide.text).toContain('Monad points guide: farm monad.xyz/quest\nNew testnet is live');
        expect(guide.urls).toContain('https://monad.xyz/quest');
        // RT prefix kept verbatim, t.co short link preserved for downstream shortener handling.
        expect(rt.text).toBe('RT @OtherAcct: @OtherAcct NovaDrop testnet airdrop is live https://t.co/AbC123');
        expect(rt.urls).toContain('https://t.co/AbC123');
        for (const p of posts) {
          expect(p.urls.some(u => /rsshub|127\.0\.0\.1|localhost/i.test(u))).toBe(false);
          expect(p.text).not.toMatch(/rsshub|127\.0\.0\.1|localhost/);
        }
      }
    } finally {
      globalThis.fetch = prevFetch;
    }
  });

  test('rejects metadata IPs, RFC1918, IPv6 loopback, .local, multi-label internal names, creds, query, hash and non-http schemes even when configured as the mirror base', async () => {
    const prevFetch = globalThis.fetch;
    const requested: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requested.push(String(input));
      return new Response('rate limited', { status: 429 });
    }) as unknown as typeof fetch;
    const syndication = 'https://syndication.twitter.com/srv/timeline-profile/screen-name/DefiIgnas';

    try {
      const unsafeLocalBases = [
        'http://169.254.169.254',
        'http://169.254.169.254:1200/twitter/user',
        'http://10.0.0.5:1200/twitter/user',
        'http://192.168.1.10:1200/twitter/user',
        'http://0.0.0.0:1200/twitter/user',
        'http://[::1]:1200/twitter/user',
        'http://rsshub.local:1200/twitter/user',
        'http://metadata.google.internal/computeMetadata/v1/',
        'http://rsshub.internal:1200/twitter/user',
        'http://user:pass@rsshub:1200/twitter/user',
        'http://rsshub:1200/twitter/user?token=1',
        'http://rsshub:1200/twitter/user#frag',
        'file://rsshub:1200/twitter/user',
        'ftp://rsshub:1200/twitter/user',
      ];
      for (const bad of unsafeLocalBases) {
        requested.length = 0;
        await expect(fetchXTimelineBestEffort('DefiIgnas', bad)).rejects.toThrow();
        expect(requested).toEqual([syndication]);
      }
    } finally {
      globalThis.fetch = prevFetch;
    }
  });

  test('local mirror follows only same-origin redirects; external, cross-port, credential and metadata redirect targets are never requested', async () => {
    const prevFetch = globalThis.fetch;
    const base = 'http://rsshub:1200/twitter/user';
    const syndication = 'https://syndication.twitter.com/srv/timeline-profile/screen-name/DefiIgnas';

    try {
      const unsafeLocations = [
        'http://169.254.169.254/latest/meta-data/',
        'http://127.0.0.1:2375/containers/json',
        'http://evil-service:1200/twitter/user/DefiIgnas',
        'http://rsshub:1201/twitter/user/DefiIgnas',
        'https://user:pass@rsshub:1200/twitter/user/DefiIgnas',
        'file:///etc/passwd',
      ];
      for (const badLocation of unsafeLocations) {
        const requested: string[] = [];
        globalThis.fetch = (async (input: RequestInfo | URL) => {
          const url = String(input);
          requested.push(url);
          if (url === `${base}/DefiIgnas/rss`) {
            return new Response('', { status: 302, headers: { Location: badLocation } });
          }
          return new Response('rate limited', { status: 429 });
        }) as unknown as typeof fetch;

        await expect(fetchXTimelineBestEffort('DefiIgnas', base)).rejects.toThrow();
        expect(requested).toEqual([`${base}/DefiIgnas/rss`, syndication]);
        expect(requested.some(r => r.includes(badLocation))).toBe(false);
      }

      // Same-origin redirect (absolute or relative) from the configured service is followed.
      const rss = (host: string) =>
        `<rss version="2.0"><channel><item><title>Guide https://realproto.xyz/quest</title><link>https://twitter.com/DefiIgnas/status/212500301</link><guid isPermaLink="false">https://twitter.com/DefiIgnas/status/212500301</guid><pubDate>Mon, 23 Nov 2026 12:00:00 GMT</pubDate><description><![CDATA[<a href="http://${host}/img.png">img</a> <a href="https://realproto.xyz/quest">Quest</a>]]></description></item></channel></rss>`;
      const sameOriginCases: { base: string; location: string; finalUrl: string }[] = [
        { base, location: '/twitter/user/DefiIgnas', finalUrl: `${base}/DefiIgnas` },
        { base: 'http://127.0.0.1:1200/twitter/user', location: 'http://127.0.0.1:1200/twitter/user/DefiIgnas/rss.xml', finalUrl: 'http://127.0.0.1:1200/twitter/user/DefiIgnas/rss.xml' },
      ];
      for (const c of sameOriginCases) {
        const requested: string[] = [];
        globalThis.fetch = (async (input: RequestInfo | URL) => {
          const url = String(input);
          requested.push(url);
          if (url === `${c.base}/DefiIgnas/rss`) {
            return new Response('', { status: 301, headers: { Location: c.location } });
          }
          return new Response(rss(new URL(c.base).hostname), { status: 200 });
        }) as unknown as typeof fetch;

        const posts = await fetchXTimelineBestEffort('DefiIgnas', c.base, Date.parse('2026-11-24T12:00:00Z'));
        expect(requested).toEqual([`${c.base}/DefiIgnas/rss`, c.finalUrl]);
        expect(posts.length).toBe(1);
        expect(posts[0].idStr).toBe('212500301');
        expect(posts[0].urls).toEqual(['https://realproto.xyz/quest']);
      }

      // A public HTTPS mirror may not redirect into a local/http target.
      const requested: string[] = [];
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        requested.push(url);
        if (url === 'https://mirror.example/DefiIgnas/rss') {
          return new Response('', { status: 302, headers: { Location: `${base}/DefiIgnas/rss` } });
        }
        return new Response('rate limited', { status: 429 });
      }) as unknown as typeof fetch;
      await expect(fetchXTimelineBestEffort('DefiIgnas', 'https://mirror.example')).rejects.toThrow();
      expect(requested).toEqual(['https://mirror.example/DefiIgnas/rss', syndication]);
    } finally {
      globalThis.fetch = prevFetch;
    }
  });

  test('RSSHub 429/503 falls through to syndication once (body cancelled, no retry storm) and health-aware backoff throttles the source', async () => {
    const prevFetch = globalThis.fetch;
    const base = 'http://rsshub:1200/twitter/user';
    const syndication = 'https://syndication.twitter.com/srv/timeline-profile/screen-name/DefiIgnas';
    const now = Date.parse('2026-11-24T12:00:00Z');

    try {
      for (const status of [429, 503]) {
        const requested: string[] = [];
        let cancels = 0;
        globalThis.fetch = (async (input: RequestInfo | URL) => {
          requested.push(String(input));
          return {
            ok: false,
            status,
            body: {
              async cancel() {
                cancels++;
              },
            },
          };
        }) as unknown as typeof fetch;

        await expect(fetchXTimelineBestEffort('DefiIgnas', base, now)).rejects.toThrow('X endpoints unavailable');
        expect(requested).toEqual([`${base}/DefiIgnas/rss`, syndication]);
        expect(cancels).toBe(2);
      }

      const db = createSqliteD1();
      await db
        .prepare(`INSERT INTO sources (id, platform, handle, lang, trust, enabled) VALUES ('x:RsshubUser', 'x', 'RsshubUser', 'en', 0.85, 1)`)
        .run();
      let mirrorStatus = 429;
      const row = () =>
        db
          .prepare(`SELECT status, fail_count, next_poll_at FROM sources WHERE id = 'x:RsshubUser'`)
          .first<{ status: string; fail_count: number; next_poll_at: number | null }>();
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === `${base}/RsshubUser/rss` && mirrorStatus === 200) {
          return new Response(
            `<rss version="2.0"><channel><item><title>Quiet account</title><link>https://twitter.com/RsshubUser/status/212500401</link><guid isPermaLink="false">https://twitter.com/RsshubUser/status/212500401</guid><pubDate>Mon, 23 Nov 2026 12:00:00 GMT</pubDate><description>Quiet account</description></item></channel></rss>`,
            { status: 200 },
          );
        }
        return new Response('rate limited', { status: mirrorStatus });
      }) as unknown as typeof fetch;

      const t0 = Date.parse('2026-11-24T13:00:00Z');
      const poll1 = await pollXBatch(db, 3, t0, null, undefined, base);
      expect(poll1.degraded).toBe(1);
      expect(await row()).toEqual({ status: 'degraded', fail_count: 1, next_poll_at: t0 + 5 * 60_000 });

      // Not due yet: the mirror is not hammered between backoff windows.
      expect((await pollXBatch(db, 3, t0 + 60_000, null, undefined, base)).polled).toBe(0);

      const t1 = t0 + 5 * 60_000;
      expect((await pollXBatch(db, 3, t1, null, undefined, base)).degraded).toBe(1);
      expect(await row()).toEqual({ status: 'degraded', fail_count: 2, next_poll_at: t1 + 10 * 60_000 });

      // RSSHub recovers: source returns to ok and the backoff state resets.
      mirrorStatus = 200;
      const t2 = t1 + 10 * 60_000;
      const poll3 = await pollXBatch(db, 3, t2, null, undefined, base);
      expect(poll3.degraded).toBe(0);
      expect(await row()).toEqual({ status: 'ok', fail_count: 0, next_poll_at: null });
    } finally {
      globalThis.fetch = prevFetch;
    }
  });

  test('hardens rssMirrorBase (rejects external http/metadata IP/.local/creds/query/hash), filters mirror subdomains & redirect host, strips script/style, preserves <br> newlines, falls back to guid, and preserves raw-IP hrefs', async () => {
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
      // Loopback bases are now allowed when explicitly configured (see the local mirror tests).
      const unsafeBases = [
        'http://mirror.example',
        'http://rsshub.evil.com:1200/twitter/user',
        'https://169.254.169.254',
        'https://169.254.169.254:1200',
        'https://10.0.0.5:1200/twitter/user',
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
      const posts = await fetchXTimelineBestEffort(
        'DefiIgnas',
        'https://mirror.example/',
        Date.parse('2026-11-24T12:00:00Z'),
      );
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

      const followed = await fetchXTimelineBestEffort(
        'DefiIgnas',
        'https://mirror.example',
        Date.parse('2026-11-24T12:00:00Z'),
      );
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

  test('parses __NEXT_DATA__ regardless of attribute order and rejects future-skew timestamps beyond 15m', () => {
    const now = Date.parse('2026-11-24T12:00:00Z');
    const html = `<html><body><script type="application/json" nonce="abc" id='__NEXT_DATA__'>${JSON.stringify({
      props: {
        pageProps: {
          timeline: {
            entries: [
              {
                content: {
                  tweet: {
                    id_str: '19000001',
                    created_at: '2026-11-24T12:10:00Z',
                    full_text: 'Valid slight skew tweet https://novaproto.xyz',
                  },
                },
              },
              {
                content: {
                  tweet: {
                    id_str: '19000002',
                    created_at: '2026-11-24T12:16:00Z',
                    full_text: 'Future tweet beyond 15m skew',
                  },
                },
              },
            ],
          },
        },
      },
    })}</script></body></html>`;

    const nextParsed = parseNextDataTimeline(html, 'DefiIgnas', now);
    expect(nextParsed.map(p => p.idStr)).toEqual(['19000001']);

    const cdnParsed = parseCdnSyndication(
      JSON.stringify({
        entries: [
          { id_str: '19000003', created_at: '2026-11-24T12:10:00Z', full_text: 'Valid CDN tweet' },
          { id_str: '19000004', created_at: '2026-11-24T12:20:00Z', full_text: 'Future CDN tweet' },
        ],
      }),
      'DefiIgnas',
      now,
    );
    expect(cdnParsed.map(p => p.idStr)).toEqual(['19000003']);
  });

  test('fetchXTimelineBestEffort cancels response body on !res.ok', async () => {
    const prevFetch = globalThis.fetch;
    let cancelCount = 0;
    globalThis.fetch = (async () => ({
      ok: false,
      status: 429,
      body: {
        async cancel() {
          cancelCount++;
        },
      },
    })) as unknown as typeof fetch;
    try {
      // Without mirror: only syndication endpoint is attempted (dead cdn.syndication skipped)
      await expect(fetchXTimelineBestEffort('DefiIgnas')).rejects.toThrow('X endpoints unavailable');
      expect(cancelCount).toBe(1);

      // With mirror configured: both mirror and syndication !res.ok bodies are cancelled
      cancelCount = 0;
      await expect(fetchXTimelineBestEffort('DefiIgnas', 'https://mirror.example')).rejects.toThrow('X endpoints unavailable');
      expect(cancelCount).toBe(2);
    } finally {
      globalThis.fetch = prevFetch;
    }
  });

  test('pollXBatch commits highest contiguous succeeded snowflake ID on partial failure', async () => {
    const now = Date.parse('2026-11-24T12:00:00Z');
    const db = createSqliteD1();
    await db
      .prepare(
        `INSERT INTO sources (id, platform, handle, lang, trust, enabled, last_seen_id)
         VALUES ('x:DefiIgnas', 'x', 'DefiIgnas', 'en', 0.85, 1, '18880000')`,
      )
      .run();

    const partialDb = {
      ...db,
      prepare(sql: string) {
        const stmt = db.prepare(sql);
        if (/INSERT\s+OR\s+IGNORE\s+INTO\s+posts/i.test(sql)) {
          return {
            bind(...args: unknown[]) {
              const bound = stmt.bind(...args);
              return {
                ...bound,
                async run() {
                  if (args[0] === 'x:DefiIgnas:18880002') throw new Error('simulated D1 write fail on tweet 2');
                  return bound.run();
                },
              };
            },
          };
        }
        return stmt;
      },
    } as unknown as D1Database;

    const postedAt = now - 60_000;
    const summary = await pollXBatch(partialDb, 3, now, null, async handle => [
      {
        idStr: '18880003',
        postUrl: `https://x.com/${handle}/status/18880003`,
        postedAt,
        text: 'ThirdXProto testnet airdrop live https://thirdx.xyz',
        urls: ['https://thirdx.xyz'],
      },
      {
        idStr: '18880001',
        postUrl: `https://x.com/${handle}/status/18880001`,
        postedAt,
        text: 'FirstXProto testnet airdrop live https://firstx.xyz',
        urls: ['https://firstx.xyz'],
      },
      {
        idStr: '18880002',
        postUrl: `https://x.com/${handle}/status/18880002`,
        postedAt,
        text: 'SecondXProto faucet claim live https://secondx.xyz',
        urls: ['https://secondx.xyz'],
      },
    ]);

    expect(summary.degraded).toBe(1);
    expect(summary.insertedPosts).toBe(1);
    const row = await db
      .prepare(`SELECT last_seen_id, status, fail_count FROM sources WHERE id = 'x:DefiIgnas'`)
      .first<{ last_seen_id: string; status: string; fail_count: number }>();
    expect(row).toEqual({ last_seen_id: '18880001', status: 'degraded', fail_count: 1 });
  });

  test('parseXRssTimeline strips visible mirror URLs from description and fallback title while preserving non-mirror and raw-IP links', () => {
    const now = Date.parse('2026-11-24T12:00:00Z');
    const isMirrorHost = (u: string) =>
      /(?:^|\.)(?:mirror\.net|redirected-mirror\.net)$/i.test(new URL(u).hostname);
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel>
      <item>
        <title>Visible mirror links in description</title>
        <link>https://mirror.net/DefiIgnas/status/212500101</link>
        <pubDate>Mon, 23 Nov 2026 12:00:00 GMT</pubDate>
        <description><![CDATA[<p>RealProto testnet airdrop live at <a href="https://realproto.xyz/quest">https://realproto.xyz/quest</a> (also https://realproto.xyz/claim?tag=mirror.net/ref and notmirror.net/drop). Quote <a href="https://mirror.net/other/status/999">https://mirror.net/other/status/999</a> media <a href="https://pic.mirror.net/media/1.png">pic.mirror.net/media/1.png</a> bare mirror.net/DefiIgnas/status/123 redir alt.redirected-mirror.net/x/1 and raw IP http://185.220.101.9/claim</p>]]></description>
      </item>
      <item>
        <title>NovaDrop testnet airdrop https://mirror.net/a/status/1 mirror.net/u/2 mirror.net https://novadrop.xyz/claim</title>
        <link>https://mirror.net/DefiIgnas/status/212500102</link>
        <pubDate>Mon, 23 Nov 2026 12:05:00 GMT</pubDate>
        <description></description>
      </item>
      <item>
        <title>Bare mirror host test</title>
        <link>https://mirror.net/DefiIgnas/status/212500104</link>
        <pubDate>Mon, 23 Nov 2026 12:08:00 GMT</pubDate>
        <description><![CDATA[Bare mirror.net and (alt.redirected-mirror.net) and mirror.net. Keep notmirror.net, mirror.net.evil.com, mirror.net-safe, and https://keepproto.xyz/airdrop]]></description>
      </item>
      <item>
        <title>PhishDrop airdrop claim</title>
        <link>https://mirror.net/DefiIgnas/status/212500103</link>
        <pubDate>Mon, 23 Nov 2026 12:10:00 GMT</pubDate>
        <description><![CDATA[<a href="http://185.220.101.9/claim">https://mirror.net/img.png</a>]]></description>
      </item>
    </channel></rss>`;

    const posts = parseXRssTimeline(xml, 'DefiIgnas', ['mirror.net', 'alt.redirected-mirror.net'], now);
    expect(posts.length).toBe(4);

    const descPost = posts.find(p => p.idStr === '212500101')!;
    expect(descPost.text).not.toContain('mirror.net/other');
    expect(descPost.text).not.toContain('pic.mirror.net');
    expect(descPost.text).not.toContain('mirror.net/DefiIgnas');
    expect(descPost.text).not.toContain('alt.redirected-mirror.net');
    expect(descPost.text).toContain('https://realproto.xyz/quest');
    expect(descPost.text).toContain('https://realproto.xyz/claim?tag=mirror.net/ref');
    expect(descPost.text).toContain('notmirror.net/drop');
    expect(descPost.text).toContain('http://185.220.101.9/claim');
    expect(descPost.urls).toContain('https://realproto.xyz/quest');
    expect(descPost.urls).toContain('http://185.220.101.9/claim');
    expect(descPost.urls.some(isMirrorHost)).toBe(false);

    const downstreamDesc = parseDropPost(descPost.text, descPost.urls);
    expect(downstreamDesc.urls.some(isMirrorHost)).toBe(false);
    expect(downstreamDesc.urls).toContain('https://realproto.xyz/quest');
    expect(downstreamDesc.urls).toContain('https://realproto.xyz/claim?tag=mirror.net/ref');
    expect(downstreamDesc.urls).toContain('https://notmirror.net/drop');
    expect(downstreamDesc.rawIpUrls).toContain('http://185.220.101.9/claim');

    const titlePost = posts.find(p => p.idStr === '212500102')!;
    expect(titlePost.text).not.toContain('mirror.net');
    expect(titlePost.text).toContain('https://novadrop.xyz/claim');
    const downstreamTitle = parseDropPost(titlePost.text, titlePost.urls);
    expect(downstreamTitle.urls).toEqual(['https://novadrop.xyz/claim']);

    const bareHostPost = posts.find(p => p.idStr === '212500104')!;
    expect(bareHostPost.text).not.toMatch(/(?<![a-z0-9-])mirror\.net(?![a-z0-9.-])/i);
    expect(bareHostPost.text).not.toContain('alt.redirected-mirror.net');
    expect(bareHostPost.text).toContain('notmirror.net');
    expect(bareHostPost.text).toContain('mirror.net.evil.com');
    expect(bareHostPost.text).toContain('mirror.net-safe');
    expect(bareHostPost.text).toContain('https://keepproto.xyz/airdrop');
    expect(bareHostPost.urls.some(isMirrorHost)).toBe(false);
    const downstreamBare = parseDropPost(bareHostPost.text, bareHostPost.urls);
    expect(downstreamBare.urls.some(isMirrorHost)).toBe(false);
    expect(downstreamBare.urls).toContain('https://keepproto.xyz/airdrop');

    const rawIpFallbackPost = posts.find(p => p.idStr === '212500103')!;
    expect(rawIpFallbackPost.text).toBe('PhishDrop airdrop claim');
    expect(rawIpFallbackPost.urls).toContain('http://185.220.101.9/claim');
    const downstreamRawIp = parseDropPost(rawIpFallbackPost.text, rawIpFallbackPost.urls);
    expect(downstreamRawIp.rawIpUrls).toContain('http://185.220.101.9/claim');
    expect(downstreamRawIp.urls.some(isMirrorHost)).toBe(false);

    // Loopback mirror URL in both description-only and fallback title must stay filtered while keeping unrelated raw-IP URLs.
    const loopbackXml = `<?xml version="1.0"?><rss version="2.0"><channel>
      <item>
        <title>Loopback fallback http://127.0.0.1:1200/media/1.png and http://185.220.101.9/claim</title>
        <link>http://127.0.0.1:1200/DefiIgnas/status/212500109</link>
        <pubDate>Mon, 23 Nov 2026 12:12:00 GMT</pubDate>
        <description><![CDATA[http://127.0.0.1:1200/DefiIgnas/status/212500109]]></description>
      </item>
    </channel></rss>`;
    const loopbackPosts = parseXRssTimeline(loopbackXml, 'DefiIgnas', ['127.0.0.1'], now);
    expect(loopbackPosts).toHaveLength(1);
    expect(loopbackPosts[0].urls).toEqual(['http://185.220.101.9/claim']);
  });

  test('fetchXTimelineBestEffort falls through to syndication when mirror only returns stale (>14d) posts and accepts fresh mirror posts immediately', async () => {
    const now = Date.parse('2026-11-24T12:00:00Z');
    const prevFetch = globalThis.fetch;
    const requested: string[] = [];

    const makeRss = (id: string, pubDate: string, text: string) =>
      `<?xml version="1.0"?><rss version="2.0"><channel><item>
        <title>${text}</title>
        <link>https://mirror.example/DefiIgnas/status/${id}</link>
        <pubDate>${pubDate}</pubDate>
        <description>${text}</description>
      </item></channel></rss>`;

    const syndicationHtml = `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: {
        pageProps: {
          timeline: {
            entries: [
              {
                content: {
                  tweet: {
                    id_str: '212500999',
                    created_at: '2026-11-23T12:00:00Z',
                    full_text: 'Syndication fresh airdrop https://freshproto.xyz/claim',
                    entities: { urls: [{ expanded_url: 'https://freshproto.xyz/claim' }] },
                  },
                },
              },
            ],
          },
        },
      },
    })}</script></body></html>`;

    try {
      // 1. Stale-only mirror response (14d + 1s old) must fall through to syndication
      requested.length = 0;
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        requested.push(url);
        if (url.startsWith('https://mirror.example/')) {
          return new Response(makeRss('212500001', 'Tue, 10 Nov 2026 11:59:59 GMT', 'Stale tweet'), {
            status: 200,
            headers: { 'Content-Type': 'application/rss+xml' },
          });
        }
        return new Response(syndicationHtml, { status: 200, headers: { 'Content-Type': 'text/html' } });
      }) as unknown as typeof fetch;

      const fellThrough = await fetchXTimelineBestEffort('DefiIgnas', 'https://mirror.example', now);
      expect(requested).toEqual([
        'https://mirror.example/DefiIgnas/rss',
        'https://syndication.twitter.com/srv/timeline-profile/screen-name/DefiIgnas',
      ]);
      expect(fellThrough.map(p => p.idStr)).toEqual(['212500999']);

      // 2. Mirror response at exact 14d cutoff is accepted without touching syndication
      requested.length = 0;
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        requested.push(url);
        if (url.startsWith('https://mirror.example/')) {
          return new Response(makeRss('212500002', 'Tue, 10 Nov 2026 12:00:00 GMT', 'Exact cutoff tweet'), {
            status: 200,
            headers: { 'Content-Type': 'application/rss+xml' },
          });
        }
        return new Response('should not call syndication', { status: 500 });
      }) as unknown as typeof fetch;

      const accepted = await fetchXTimelineBestEffort('DefiIgnas', 'https://mirror.example', now);
      expect(requested).toEqual(['https://mirror.example/DefiIgnas/rss']);
      expect(accepted.map(p => p.idStr)).toEqual(['212500002']);

      // 3. Stale-only mirror response + failing syndication returns the stale mirror posts instead of throwing/degrading
      requested.length = 0;
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        requested.push(url);
        if (url.startsWith('https://mirror.example/')) {
          return new Response(makeRss('212500003', 'Tue, 10 Nov 2026 11:59:59 GMT', 'Quiet account old tweet'), {
            status: 200,
            headers: { 'Content-Type': 'application/rss+xml' },
          });
        }
        return new Response('rate limited', { status: 429 });
      }) as unknown as typeof fetch;

      const staleFallback = await fetchXTimelineBestEffort('DefiIgnas', 'https://mirror.example', now);
      expect(requested).toEqual([
        'https://mirror.example/DefiIgnas/rss',
        'https://syndication.twitter.com/srv/timeline-profile/screen-name/DefiIgnas',
      ]);
      expect(staleFallback.map(p => p.idStr)).toEqual(['212500003']);

      const db = createSqliteD1();
      await db
        .prepare(
          `INSERT INTO sources (id, platform, handle, lang, trust, enabled)
           VALUES ('x:QuietAcct', 'x', 'QuietAcct', 'en', 0.85, 1)`,
        )
        .run();
      const pollRes = await pollXBatch(db, 3, now, null, undefined, 'https://mirror.example');
      expect(pollRes.degraded).toBe(0);
      expect(pollRes.insertedPosts).toBe(0);
      const quietRow = await db
        .prepare(`SELECT status, fail_count, last_seen_id FROM sources WHERE id = 'x:QuietAcct'`)
        .first<{ status: string; fail_count: number; last_seen_id: string }>();
      expect(quietRow).toEqual({ status: 'ok', fail_count: 0, last_seen_id: '212500003' });
    } finally {
      globalThis.fetch = prevFetch;
    }
  });

  test('pollXBatch multi-poll cap: ingests oldest 10 on poll 1 with cursor at 10th, then remaining 5 on poll 2 advancing cursor to 15th', async () => {
    const now = Date.parse('2026-11-24T12:00:00Z');
    const db = createSqliteD1();
    await db
      .prepare(
        `INSERT INTO sources (id, platform, handle, lang, trust, enabled)
         VALUES ('x:MultiPoll', 'x', 'MultiPoll', 'en', 0.85, 1)`,
      )
      .run();

    // Return 15 relevant tweets in newest-first order (matching real X timelines)
    const tweets = Array.from({ length: 15 }, (_, idx) => {
      const seq = 15 - idx;
      const idStr = String(19100000 + seq);
      return {
        idStr,
        postUrl: `https://x.com/MultiPoll/status/${idStr}`,
        postedAt: now - (16 - seq) * 60_000,
        text: `MultiProto${seq} testnet airdrop quest live at https://mpproto${seq}.xyz/quest`,
        urls: [`https://mpproto${seq}.xyz/quest`],
      };
    });

    const poll1 = await pollXBatch(db, 3, now, null, async () => tweets);
    expect(poll1.insertedPosts).toBe(10);
    expect(poll1.degraded).toBe(0);

    const row1 = await db
      .prepare(`SELECT last_seen_id FROM sources WHERE id = 'x:MultiPoll'`)
      .first<{ last_seen_id: string }>();
    expect(row1?.last_seen_id).toBe('19100010');

    const postsAfterPoll1 = await db
      .prepare(`SELECT id FROM posts WHERE source_id = 'x:MultiPoll' ORDER BY id ASC`)
      .all<{ id: string }>();
    expect((postsAfterPoll1.results ?? []).map(r => r.id)).toEqual(
      Array.from({ length: 10 }, (_, i) => `x:MultiPoll:${19100001 + i}`),
    );

    const poll2 = await pollXBatch(db, 3, now + 60_000, null, async () => tweets);
    expect(poll2.insertedPosts).toBe(5);
    expect(poll2.degraded).toBe(0);

    const row2 = await db
      .prepare(`SELECT last_seen_id FROM sources WHERE id = 'x:MultiPoll'`)
      .first<{ last_seen_id: string }>();
    expect(row2?.last_seen_id).toBe('19100015');

    const postsAfterPoll2 = await db
      .prepare(`SELECT id FROM posts WHERE source_id = 'x:MultiPoll' ORDER BY id ASC`)
      .all<{ id: string }>();
    expect((postsAfterPoll2.results ?? []).map(r => r.id)).toEqual(
      Array.from({ length: 15 }, (_, i) => `x:MultiPoll:${19100001 + i}`),
    );
  });
});
