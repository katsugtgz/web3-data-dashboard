import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestD1, FORBIDDEN_CJK_RE } from './helpers';
import { parseDropPost } from '../src/normalize/parse';
import { fetchTelegramChannelHtml, parseTelegramHtml, pollTelegramBatch, pruneOldPosts } from '../src/sources/telegram';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/telegram/', import.meta.url));
const fixtureFiles = readdirSync(FIXTURE_DIR).filter(f => f.endsWith('.html')).sort();

describe('Telegram HTMLRewriter parser across >=15 real channel fixtures', () => {
  test('parses all real channel fixtures with zero CJK in normalized summaries', async () => {
    expect(fixtureFiles.length).toBeGreaterThanOrEqual(15);

    let totalPosts = 0;
    for (const file of fixtureFiles) {
      const handle = file.replace(/\.html$/, '');
      const html = readFileSync(join(FIXTURE_DIR, file), 'utf8');
      const posts = await parseTelegramHtml(html, handle);
      expect(posts.length).toBeGreaterThan(0);
      totalPosts += posts.length;

      for (const p of posts) {
        expect(p.postUrl).toBe(`https://t.me/${handle}/${p.msgId}`);
        // Undated messages are dropped (never stamped Date.now()), so every
        // surviving post must carry a parseable timestamp; the exact value is
        // checked in the known-datetime test.
        expect(Number.isFinite(p.postedAt) && p.postedAt > 0).toBe(true);
        const parsed = parseDropPost(p.text, p.urls);
        expect(FORBIDDEN_CJK_RE.test(parsed.summary)).toBe(false);
        expect(parsed.taskTypes.length).toBeGreaterThan(0);
      }
    }
    expect(totalPosts).toBeGreaterThanOrEqual(15);
  });

  test('decodes nested message_text, <br>, entities, and forwarded_from href', async () => {
    const html = `
      <div class="tgme_widget_message" data-post="alpha_feed/420">
        <div class="tgme_widget_message_forwarded_from">
          Forwarded from <a class="tgme_widget_message_forwarded_from_name" href="https://t.me/upstream_gems">Upstream Gems</a>
        </div>
        <div class="tgme_widget_message_text">
          <div class="tgme_widget_message_text">
            <b>HyperNova Testnet</b> &#036;HNVA on Arbitrum<br/>
            Claim faucet &amp; bridge at <a href="https://hypernova.xyz/faucet?utm_source=tg">hypernova.xyz</a>
          </div>
        </div>
        <a class="tgme_widget_message_date"><time datetime="2026-11-20T12:00:00+00:00">12:00</time></a>
      </div>`;
    const posts = await parseTelegramHtml(html, 'alpha_feed');
    expect(posts.length).toBe(1);
    expect(posts[0].msgId).toBe('420');
    expect(posts[0].forwardedFrom).toBe('upstream_gems');
    // Known datetime in the fixture: assert the exact parse (2026-11-20T12:00:00Z).
    expect(posts[0].postedAt).toBe(Date.parse('2026-11-20T12:00:00+00:00'));
    expect(posts[0].text).toContain('$HNVA on Arbitrum');
    expect(posts[0].text).toContain('faucet & bridge');
    expect(posts[0].urls).toContain('https://hypernova.xyz/faucet?utm_source=tg');
  });

  test('drops messages with missing or invalid <time> instead of stamping now', async () => {
    const html = `
<div class="tgme_widget_message" data-post="alpha_feed/501">
  <div class="tgme_widget_message_text">No time element anywhere in this message</div>
</div>
<div class="tgme_widget_message" data-post="alpha_feed/502">
  <a class="tgme_widget_message_date"><time datetime="not-a-date">??</time></a>
  <div class="tgme_widget_message_text">Invalid datetime attribute value</div>
</div>
<div class="tgme_widget_message" data-post="alpha_feed/503">
  <a class="tgme_widget_message_date"><time datetime="2026-11-20T12:00:00+00:00">12:00</time></a>
  <div class="tgme_widget_message_text">Dated control message</div>
</div>`;
    const posts = await parseTelegramHtml(html, 'alpha_feed');
    expect(posts.map(p => p.msgId)).toEqual(['503']);
    expect(posts[0].postedAt).toBe(Date.parse('2026-11-20T12:00:00+00:00'));
  });

  test('skips service_message, separates block/anchor boundaries, decodes href entities before scheme check, and drops future-skew posts', async () => {
    const now = Date.parse('2026-11-24T12:00:00Z');
    const html = `
      <div class="tgme_widget_message service_message" data-post="alpha_feed/600">
        <div class="tgme_widget_message_text">Channel photo updated</div>
        <a class="tgme_widget_message_date"><time datetime="2026-11-24T11:00:00Z">11:00</time></a>
      </div>
      <div class="tgme_widget_message" data-post="alpha_feed/601">
        <div class="tgme_widget_message_text">
          <p>First line</p><blockquote>Quoted quest</blockquote><a href="  &#104;ttps://nova.xyz/claim?a=1&amp;b=2  ">https://nova.xyz/claim</a>Update now
        </div>
        <a class="tgme_widget_message_date"><time datetime="2026-11-24T12:10:00Z">12:10</time></a>
      </div>
      <div class="tgme_widget_message" data-post="alpha_feed/602">
        <div class="tgme_widget_message_text">Future post beyond 15m skew</div>
        <a class="tgme_widget_message_date"><time datetime="2026-11-24T12:16:00Z">12:16</time></a>
      </div>`;

    const posts = await parseTelegramHtml(html, 'alpha_feed', now);
    expect(posts.map(p => p.msgId)).toEqual(['601']);
    expect(posts[0].urls).toContain('https://nova.xyz/claim?a=1&b=2');
    expect(posts[0].text).toContain('First line\nQuoted quest');
    expect(posts[0].text).toContain('https://nova.xyz/claim Update now');
    expect(posts[0].text).not.toContain('claimUpdate');
  });

  test('fetchTelegramChannelHtml cancels response body on !res.ok', async () => {
    const prevFetch = globalThis.fetch;
    let cancelled = false;
    globalThis.fetch = (async () => ({
      ok: false,
      status: 503,
      body: {
        async cancel() {
          cancelled = true;
        },
      },
    })) as unknown as typeof fetch;
    try {
      await expect(fetchTelegramChannelHtml('demo_chan')).rejects.toThrow('HTTP 503');
      expect(cancelled).toBe(true);
    } finally {
      globalThis.fetch = prevFetch;
    }
  });

  test('pollTelegramBatch invokes lazy surf loader only on new posts, caps fetch concurrency at 6, backs off errors, and advances last_seen_id monotonically on partial failure', async () => {
    const makeHtml = (handle: string, entries: { id: number; iso: string; text: string }[]) =>
      entries
        .map(
          e =>
            `<div class="tgme_widget_message" data-post="${handle}/${e.id}"><div class="tgme_widget_message_text">${e.text}</div><a class="tgme_widget_message_date"><time datetime="${e.iso}">12:00</time></a></div>`,
        )
        .join('\n');

    const { db } = createTestD1();
    const now = Date.parse('2026-11-24T12:00:00Z');
    for (let i = 1; i <= 8; i++) {
      await db
        .prepare(
          `INSERT INTO sources (id, platform, handle, lang, trust, enabled, last_seen_id)
           VALUES (?1, 'telegram', ?2, 'en', 0.8, 1, '10')`,
        )
        .bind(`telegram:ch${i}`, `ch${i}`)
        .run();
    }

    // Quiet tick with 8 channels: concurrency <= 6 and lazy surf loader is NOT invoked.
    let inFlight = 0;
    let maxInFlight = 0;
    let surfLoads = 0;
    const quiet = await pollTelegramBatch(
      db,
      8,
      now,
      async () => {
        surfLoads++;
        return null;
      },
      async handle => {
        inFlight++;
        if (inFlight > maxInFlight) maxInFlight = inFlight;
        await new Promise(r => setTimeout(r, 10));
        inFlight--;
        if (handle === 'ch8') throw new Error('boom 502');
        return makeHtml(handle, [{ id: 10, iso: '2026-11-24T11:00:00Z', text: 'old post' }]);
      },
    );
    expect(quiet.polled).toBe(8);
    expect(quiet.errors).toBe(1);
    expect(maxInFlight).toBeLessThanOrEqual(6);
    expect(surfLoads).toBe(0);

    // ch8 failed once -> next_poll_at = now + 4m; polling at now + 1m skips ch8.
    const ch8Row = await db
      .prepare(`SELECT fail_count, next_poll_at FROM sources WHERE id = 'telegram:ch8'`)
      .first<{ fail_count: number; next_poll_at: number | null }>();
    expect(ch8Row).toEqual({ fail_count: 1, next_poll_at: now + 4 * 60_000 });

    const skippedHandles: string[] = [];
    await pollTelegramBatch(db, 8, now + 60_000, null, async handle => {
      skippedHandles.push(handle);
      return makeHtml(handle, [{ id: 10, iso: '2026-11-24T11:00:00Z', text: 'old' }]);
    });
    expect(skippedHandles).not.toContain('ch8');

    // At now + 4m, ch8 recovers and clears next_poll_at = NULL.
    const recoveredHandles: string[] = [];
    const rec = await pollTelegramBatch(
      db,
      8,
      now + 4 * 60_000,
      async () => {
        surfLoads++;
        return null;
      },
      async handle => {
        recoveredHandles.push(handle);
        if (handle === 'ch8') {
          return makeHtml(handle, [
            { id: 11, iso: '2026-11-24T11:55:00Z', text: 'NovaProto testnet airdrop live https://novaproto.xyz' },
          ]);
        }
        return makeHtml(handle, [{ id: 10, iso: '2026-11-24T11:00:00Z', text: 'old' }]);
      },
    );
    expect(recoveredHandles).toContain('ch8');
    expect(rec.insertedPosts).toBe(1);
    expect(surfLoads).toBe(1);
    const ch8Recovered = await db
      .prepare(`SELECT fail_count, next_poll_at, last_seen_id FROM sources WHERE id = 'telegram:ch8'`)
      .first<{ fail_count: number; next_poll_at: number | null; last_seen_id: string }>();
    expect(ch8Recovered).toEqual({ fail_count: 0, next_poll_at: null, last_seen_id: '11' });

    // Partial failure: post 12 succeeds, post 13 fails, post 14 is skipped -> last_seen_id commits 12 only.
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
                  if (args[0] === 'telegram:ch1:13') throw new Error('simulated D1 write fail on post 13');
                  return bound.run();
                },
              };
            },
          };
        }
        return stmt;
      },
    } as unknown as D1Database;

    const partial = await pollTelegramBatch(partialDb, 1, now + 10 * 60_000, null, async handle =>
      makeHtml(handle, [
        { id: 14, iso: '2026-11-24T11:59:00Z', text: 'ThirdProto airdrop quest live https://thirdproto.xyz' },
        { id: 12, iso: '2026-11-24T11:57:00Z', text: 'FirstProto testnet live https://firstproto.xyz' },
        { id: 13, iso: '2026-11-24T11:58:00Z', text: 'SecondProto faucet live https://secondproto.xyz' },
      ]),
    );
    expect(partial.errors).toBe(1);
    expect(partial.insertedPosts).toBe(1);
    const ch1AfterPartial = await db
      .prepare(`SELECT last_seen_id, fail_count FROM sources WHERE id = 'telegram:ch1'`)
      .first<{ last_seen_id: string; fail_count: number }>();
    expect(ch1AfterPartial).toEqual({ last_seen_id: '12', fail_count: 1 });
  });

  test('pruneOldPosts deletes orphaned fallback_windows rows alongside orphaned clusters', async () => {
    const { db } = createTestD1();
    const now = 1_795_200_000_000;
    const DAY = 86_400_000;

    await db
      .prepare(
        `INSERT INTO clusters (id, project, chains, task_types, summary, summary_source, risk_level, risk_reasons, score, source_count, first_seen, last_seen)
         VALUES ('c-keep', 'KeepProto', '[]', '["quest"]', 'Keep', 'rule', 'ok', '[]', 1.0, 1, ?1, ?1),
                ('c-drop', 'DropProto', '[]', '["quest"]', 'Drop', 'rule', 'ok', '[]', 0.5, 1, ?2, ?2)`,
      )
      .bind(now - 2 * DAY, now - 31 * DAY)
      .run();
    await db
      .prepare(
        `INSERT INTO posts (id, source_id, post_url, posted_at, text, urls, cluster_id, created_at)
         VALUES ('p-keep', 'telegram:ch1', 'https://t.me/ch1/1', ?1, 'keep', '[]', 'c-keep', ?1),
                ('p-drop', 'telegram:ch1', 'https://t.me/ch1/2', ?2, 'drop', '[]', 'c-drop', ?2)`,
      )
      .bind(now - 2 * DAY, now - 31 * DAY)
      .run();
    await db
      .prepare(
        `INSERT INTO fallback_windows (identity_key, cluster_id, first_seen, last_seen)
         VALUES ('proj:keepproto', 'c-keep', ?1, ?1),
                ('proj:dropproto', 'c-drop', ?2, ?2)`,
      )
      .bind(now - 2 * DAY, now - 31 * DAY)
      .run();

    const res = await pruneOldPosts(db, now);
    expect(res).toEqual({ deletedPosts: 1, deletedClusters: 1 });
    const fw = await db.prepare('SELECT cluster_id FROM fallback_windows ORDER BY cluster_id ASC').all<{ cluster_id: string }>();
    expect(fw.results.map(r => r.cluster_id)).toEqual(['c-keep']);
  });
});
