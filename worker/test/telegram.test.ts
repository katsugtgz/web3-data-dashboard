import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HAN_RE } from '../src/normalize/i18n';
import { parseDropPost } from '../src/normalize/parse';
import { parseTelegramHtml } from '../src/sources/telegram';

const FIXTURE_DIR = new URL('./fixtures/telegram/', import.meta.url).pathname;
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
        // Falls back to Date.now() when the page omits <time>, so only assert
        // parseability here; the exact timestamp is checked in the known-datetime test.
        expect(Number.isFinite(p.postedAt) && p.postedAt > 0).toBe(true);
        const parsed = parseDropPost(p.text, p.urls);
        expect(HAN_RE.test(parsed.summary)).toBe(false);
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
});
