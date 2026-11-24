import { describe, expect, test } from 'bun:test';
import worker from '../src/index';
import { applyMigrations, createTestD1, MIGRATION_FILES } from './helpers';
import { computeClusterId, ingestPostIntoCluster, queryFeed } from '../src/normalize/cluster';
import {
  cleanUrl,
  extractUrls,
  isNewsDomain,
  isPlatformDomain,
  selectFeedLinks,
} from '../src/normalize/domains';
import { parseDropPost } from '../src/normalize/parse';
import {
  classifyDropRelevance,
  cleanSummaryText,
  detectNonEnglishLatin,
  stripBilingualDuplicate,
  truncateAtWordBoundary,
} from '../src/normalize/text';
import { evaluateSafety, reconcileSafetyReasons } from '../src/safety';
import { normalizeSurf } from '../src/sources/surf';
import { parseTelegramHtml, pollTelegramBatch } from '../src/sources/telegram';

function createSqliteD1(): D1Database {
  return createTestD1().db;
}

describe('Telegram HTML parser — reply separation, bare-domain https, raw IP & footer hygiene', () => {
  test('ignores quoted reply preview text and URLs so posts never glue together', async () => {
    const html = `
      <div class="tgme_widget_message" data-post="airdropfind/129816">
        <a class="tgme_widget_message_reply" href="https://t.me/airdropfind/129778">
          <div class="tgme_widget_message_text js-message_reply_text">
            Old post ending in URL https://pixelateids.com
          </div>
        </a>
        <div class="tgme_widget_message_text js-message_text">
          the checker is live at <a href="https://pixelateids.com/check">pixelateids.com/check</a>
        </div>
        <a class="tgme_widget_message_date"><time datetime="2026-11-21T12:00:00Z">12:00</time></a>
      </div>`;

    const posts = await parseTelegramHtml(html, 'airdropfind');
    expect(posts).toHaveLength(1);
    expect(posts[0].text).not.toContain('Old post');
    expect(posts[0].urls).toEqual(['https://pixelateids.com/check']);
    expect(posts[0].urls.some(u => u.includes('comthe'))).toBe(false);
  });

  test('upgrades Telegram bare-domain http:// auto-links and always-HTTPS platforms while preserving explicit http:// and dropping benign DNS IPs', async () => {
    const html = `
      <div class="tgme_widget_message" data-post="AirdropJacks/27291">
        <div class="tgme_widget_message_text js-message_text">
          Clocked Waitlist <a href="http://getclocked.com/?ref=HQAKP9">getclocked.com/?ref=HQAKP9</a><br/>
          Site <a href="http://rgbstone.com/">rgbstone.com</a><br/>
          Holder <a href="http://Agent.id/"><b>Agent.id</b></a><br/>
          DNS <a href="http://1.1.1.1/">1.1.1.1</a><br/>
          Chat <a href="http://t.me/atoms_chat"><b>Chat</b></a><br/>
          Boost <a href="https://t.me/AirdropJacks?boost"><b>Boost</b></a><br/>
          Hidden <a href="https://ct.com/news/hidden"> </a>
        </div>
        <a class="tgme_widget_message_date"><time datetime="2026-11-21T12:00:00Z">12:00</time></a>
      </div>
      <div class="tgme_widget_message" data-post="AirdropJacks/27292">
        <div class="tgme_widget_message_text js-message_text">
          Explicit plain http <a href="http://sketchy-claim.xyz/airdrop">http://sketchy-claim.xyz/airdrop</a>
          and disguised <a href="http://evil-drain.xyz/claim">Claim now</a>
        </div>
        <a class="tgme_widget_message_date"><time datetime="2026-11-21T12:05:00Z">12:05</time></a>
      </div>`;

    const posts = await parseTelegramHtml(html, 'AirdropJacks');
    expect(posts).toHaveLength(2);
    expect(posts[0].urls).toContain('https://getclocked.com/?ref=HQAKP9');
    expect(posts[0].urls).toContain('https://rgbstone.com/');
    expect(posts[0].urls).toContain('https://agent.id/');
    expect(posts[0].urls).toContain('https://t.me/atoms_chat');
    expect(posts[0].urls.some(u => u.includes('1.1.1.1'))).toBe(false);
    expect(posts[0].urls.some(u => u.startsWith('http://'))).toBe(false);
    expect(posts[0].urls.some(u => u.includes('?boost'))).toBe(false);
    expect(posts[0].urls.some(u => u.includes('ct.com/news/hidden'))).toBe(false);

    // Explicit http:// links MUST remain plain http so safety still flags them.
    expect(posts[1].urls).toContain('http://sketchy-claim.xyz/airdrop');
    expect(posts[1].urls).toContain('http://evil-drain.xyz/claim');
  });

  test('extracts bare-domain URL paths from t.co shortener anchor text (H3)', async () => {
    const html = `
      <div class="tgme_widget_message" data-post="airdropfind/130001">
        <div class="tgme_widget_message_text js-message_text">
          $JRNY CLAIM GOES LIVE IN 30 MINUTES! Claim here:
          <a href="https://t.co/abc123XYZ">jrny.club/token-hub/claim</a>
        </div>
        <a class="tgme_widget_message_date"><time datetime="2026-11-22T12:00:00Z">12:00</time></a>
      </div>`;

    const posts = await parseTelegramHtml(html, 'airdropfind');
    expect(posts).toHaveLength(1);
    const parsed = parseDropPost(posts[0].text, posts[0].urls);
    expect(parsed.urls).toContain('https://jrny.club/token-hub/claim');
    expect(parsed.projectDomain).toBe('jrny.club');
    expect(parsed.isRelevantDrop).toBe(true);
  });

  test('pollTelegramBatch filters out non-drop chatter while still advancing last_seen_id', async () => {
    const db = createSqliteD1();
    const now = Date.parse('2026-11-22T12:00:00Z');
    await db
      .prepare(`INSERT INTO sources (id, platform, handle, lang, trust, enabled) VALUES ('telegram:airdropfind', 'telegram', 'airdropfind', 'en', 0.75, 1)`)
      .run();

    const html = `
      <div class="tgme_widget_message" data-post="airdropfind/100">
        <div class="tgme_widget_message_text js-message_text">
          Clocked Waitlist live <a href="http://getclocked.com/?ref=ABC">getclocked.com/?ref=ABC</a>
        </div>
        <a class="tgme_widget_message_date"><time datetime="2026-11-22T10:00:00Z">10:00</time></a>
      </div>
      <div class="tgme_widget_message" data-post="airdropfind/101">
        <div class="tgme_widget_message_text js-message_text">siap2 bro</div>
        <a class="tgme_widget_message_date"><time datetime="2026-11-22T11:00:00Z">11:00</time></a>
      </div>`;

    const summary = await pollTelegramBatch(db, 4, now, null, async () => html);
    expect(summary.polled).toBe(1);
    expect(summary.insertedPosts).toBe(1);
    expect(summary.ingestedResults[0].parsed.project).toBe('Clocked');
    expect(summary.ingestedResults[0].riskLevel).toBe('warn'); // only unverified registry, no plain http!

    const src = await db
      .prepare(`SELECT last_seen_id FROM sources WHERE id = 'telegram:airdropfind'`)
      .first<{ last_seen_id: string }>();
    expect(src?.last_seen_id).toBe('101');
  });
});

describe('Domain classification & URL hygiene', () => {
  test('excludes news media, trackers, marketplaces, launchpads, events, and quest wrappers from project domains', () => {
    for (const dom of [
      'coindesk.com',
      'cointelegraph.com',
      'ct.com',
      'theblock.co',
      'thedefiant.io',
      'decrypt.co',
      'chaincatcher.com',
      'watcherguru.com',
      'fortune.com',
      'cnbc.com',
      'nasdaq.com',
      'globenewswire.com',
      'naver.com',
      'heraldcorp.com',
      'whale-alert.io',
      'dropstab.com',
      'opensea.io',
      'magiceden.io',
      'satsea.xyz',
      'pump.fun',
      'onelink.me',
      'luma.com',
      'tokopedia.com',
      'bitget.cloud',
      'taskon.xyz',
      'tokenops.xyz',
      'moongate.com',
      'chungdailynote.com',
    ]) {
      expect(isPlatformDomain(dom)).toBe(true);
    }
    expect(isNewsDomain('coindesk.com')).toBe(true);
    expect(isNewsDomain('theblock.co')).toBe(true);
    expect(isNewsDomain('cointelegraph.com')).toBe(true);
    expect(isNewsDomain('getclocked.com')).toBe(false);
    expect(isPlatformDomain('getclocked.com')).toBe(false);
    expect(isPlatformDomain('rgbstone.com')).toBe(false);
  });

  test('cleanUrl decodes &amp;, strips raw & encoded emoji+glue, rejects raw IPs & ellipsis URLs, strips refs & X share params', () => {
    expect(
      cleanUrl('https://app.decalabs.ai/join?next=/rewards&amp;ref=rw7RV9nik3fiHfl2USqzkZpQ'),
    ).toBe('https://app.decalabs.ai/join?next=%2Frewards');
    expect(
      cleanUrl('https://chungdailynote.substack.com/p/note?r=2dzpjp&amp;utm_campaign=post&amp;utm_medium=web'),
    ).toBe('https://chungdailynote.substack.com/p/note');
    expect(cleanUrl('https://getclocked.com/?ref=HQAKP9')).toBe('https://getclocked.com/');
    expect(cleanUrl('https://topnod.onelink.me/orvm/events?inviteCode=TRTN1')).toBe(
      'https://topnod.onelink.me/orvm/events',
    );
    expect(cleanUrl('https://penguclash.io/?p=ggsk2i02')).toBe('https://penguclash.io/');
    // Raw trailing emoji BEFORE URL encoding (live-auditor catch on JASPER).
    expect(
      cleanUrl('https://x.com/jaspervault/status/2121688834337542229?a=tc1HyU-9ZcTGFEIg2YA&s=19\u{1F3C2}'),
    ).toBe('https://x.com/jaspervault/status/2121688834337542229');
    // Percent-encoded emoji followed by glued prose (live #8 RGB_Stone case).
    expect(
      cleanUrl('https://x.com/RGB_Stone/status/2124855273265459430?s=19%F0%9F%94%88Update'),
    ).toBe('https://x.com/RGB_Stone/status/2124855273265459430');
    // Truncated ellipsis URLs (live #7 and #8 cases) -> null.
    expect(cleanUrl('https://x.com/T%E2%80%A6lumayan')).toBeNull();
    expect(cleanUrl('https://discord.gg/acepyr%E2%80%A6Musang:')).toBeNull();
    expect(cleanUrl('https://x.com/voicecc/s%E2%80%A6Introducing')).toBeNull();
    // Raw IP literals (live #8 Acepyr `http://1.1.1.1/` and malicious `http://45.33.12.9/claim`) -> null for display links.
    expect(cleanUrl('http://1.1.1.1/')).toBeNull();
    expect(cleanUrl('http://45.33.12.9/claim')).toBeNull();
    // Trailing slash normalization on non-root paths.
    expect(cleanUrl('https://voice.cc/socialcamp/')).toBe('https://voice.cc/socialcamp');
    // Always-HTTPS platform upgrade.
    expect(cleanUrl('http://t.me/atoms_chat')).toBe('https://t.me/atoms_chat');
  });

  test('extractUrls captures bare-domain URLs with paths from plain post text (H3)', () => {
    const urls = extractUrls('$JRNY CLAIM GOES LIVE IN 30 MINUTES -> jrny.club/token-hub/claim');
    expect(urls).toContain('https://jrny.club/token-hub/claim');
  });

  test('selectFeedLinks deduplicates refs/http/www, filters self-promo & private t.me, and prioritizes project links', () => {
    const selected = selectFeedLinks(
      [
        'https://t.me/atoms_research?boost',
        'http://t.me/atoms_chat',
        'https://t.me/c/2082220326/430628',
        'https://linktr.ee/atoms_research',
        'https://x.com/search?q=%24ZXO&amp;src=cashtag_click',
        'https://x.com/getclocked/status/2120575879177032073?a=GAOm2kwYKWBENZwiNNc&s=20',
        'http://getclocked.com/?ref=75372W',
        'https://getclocked.com/?ref=RDJ9H8',
        'https://www.getclocked.com/',
        'https://getclocked.com/',
      ],
      {
        projectDomain: 'getclocked.com',
        sourceHandles: new Set(['atoms_research']),
      },
    );

    expect(selected[0]).toBe('https://getclocked.com/');
    expect(selected.filter(u => u.includes('getclocked.com'))).toHaveLength(1);
    expect(selected).toContain('https://x.com/getclocked/status/2120575879177032073');
    expect(selected.some(u => u.includes('t.me/'))).toBe(false);
    expect(selected.some(u => u.includes('linktr.ee'))).toBe(false);
    expect(selected.some(u => u.includes('x.com/search'))).toBe(false);
  });

  test('selectFeedLinks does not discard higher-priority project links behind 40 X URLs and preserves /join/code alongside /docs', () => {
    const xSpam = Array.from(
      { length: 40 },
      (_, i) => `https://x.com/user${i}/status/${2120000000000000000 + i}`,
    );
    const ranked = selectFeedLinks([...xSpam, 'https://novaprotocol.xyz/claim'], {
      projectDomain: 'novaprotocol.xyz',
      maxLinks: 6,
    });
    expect(ranked[0]).toBe('https://novaprotocol.xyz/claim');
    expect(ranked).toHaveLength(2);

    const joinWithDocs = selectFeedLinks(
      ['https://example.com/join/AB12', 'https://example.com/docs'],
      { projectDomain: 'example.com' },
    );
    expect(joinWithDocs).toEqual([
      'https://example.com/docs',
      'https://example.com/join/AB12',
    ]);

    const joinWithClean = selectFeedLinks(
      ['https://example.com/join/AB12', 'https://example.com/join'],
      { projectDomain: 'example.com' },
    );
    expect(joinWithClean).toEqual(['https://example.com/join']);

    const distinctRefActions = selectFeedLinks(
      [
        'https://example.com/r/AB12',
        'https://example.com/ref/XY99',
        'https://example.com/join/CD34',
        'https://example.com/join/EF56',
      ],
      { projectDomain: 'example.com' },
    );
    expect(distinctRefActions).toEqual([
      'https://example.com/join/CD34',
      'https://example.com/r/AB12',
    ]);
  });
});

describe('Drop relevance classifier — real production live & snapshot regression cases', () => {
  test('rejects news wires, macro/stock wires, whale alerts, price bots, essays, deposit ads, casual chat, and loose-keyword FPs (M1)', () => {
    const nonDrops: { text: string; urls?: string[] }[] = [
      {
        text: 'REGULATION: The ECB is recruiting groups of banks to test tokenized deposits under Appia. News | Markets | YouTube',
        urls: ['https://cointelegraph.com/news/ecb-tokenized-deposits', 'https://ct.com/category/markets'],
      },
      {
        text: 'North Korean hackers routed funds through Sky PSM, putting $2.7B reserve at freeze risk \u2013 Link',
        urls: ['https://www.coindesk.com/business/2026/11/19/north-korean-hackers'],
      },
      {
        text: 'Chainflip confirms $12M vault hack and offers attacker 10% bounty for return of stolen funds',
        urls: ['https://cointelegraph.com/news/chainflip-12m-crypto-hack-10-percent-bounty'],
      },
      {
        text: "*NVIDIA BOARD IS NOT CONSIDERING ANY MERGER ACCORDING TO SOURCES *Bir kaynak CNBC'ye konustu",
        urls: ['https://t.me/AstronomicaNews/6102'],
      },
      {
        text: '*HUANG: NVIDIA TO INVEST IN AI CHIP SUPPLY CHAIN: FT\nNvidia CEO Jensen Huang AI yatirimi yapacagini acikladi.',
        urls: ['https://t.me/AstronomicaNews/6100'],
      },
      {
        text: '*TRUMP: NEW CUBA CAMPAIGN STATEMENT\n*Trump aciklama yapti',
        urls: ['https://t.me/AstronomicaNews/6105'],
      },
      {
        text: 'JUST IN: Top Democrat threatens to cut government funding for SpaceX $SPCX. @WatcherGuru',
        urls: ['https://watcherguru.com/'],
      },
      {
        text: '127,745,921 $USDC (127,824,166 USD) transferred from Coinbase Institutional to #Coinbase',
        urls: ['https://whale-alert.io/transaction/ethereum/0x86ca328'],
      },
      {
        text: 'Top Price movements: Last 5 minutes: ADA $0.1400 => $0.1354 -3.29% BTC $58293 => $57006 -2.21%',
        urls: ['https://dropstab.com/coins/venice'],
      },
      {
        text: '2026/11/9 Today\u2019s Newsletter News \u2022 Strategy bought 1,037 BTC \u2022 Coinbase wins approval',
        urls: ['https://chungdailynote.substack.com/p/chung-daily-note-20261122'],
      },
      {
        text: 'Weekly Recap: biggest DeFi news and token unlocks from this week',
        urls: ['https://t.me/atoms_research/12220'],
      },
      {
        text: 'ANTHROPIC SHARES OPEN AT $114.5 IN DEBUT VS IPO PRICE OF $83 PER SHARE',
      },
      {
        text: 'Russia approves $BTC, $ETH and $USDT for retail investors starting today. @News_Crypto',
      },
      {
        text: 'Bitcoin Drops Below $60,000',
      },
      {
        text: 'Binance Futures adds JNJ, AMDL and NIO perpetuals with up to 20x leverage \u2013 Link',
        urls: ['https://www.chaincatcher.com/en/article/2306626'],
      },
      {
        text: 'A Seramount survey finds only 18% of Gen Z workers want to build AI skills',
        urls: ['https://fortune.com/2026/11/21/gen-z-workers-ai-skills-seramount-survey/'],
      },
      {
        text: 'Samsung and Apple are close to a DRAM long term supply deal',
        urls: ['https://n.news.naver.com/mnews/article/374/0000545031?sid=101'],
      },
      {
        text: 'Nick Tomaino: Lessons Learned from 15 Years in Crypto > Run your race',
        urls: ['https://x.com/NTmoney/status/2124498180289315099'],
      },
      {
        text: 'PRIME XBT \u2014 100% DEPOSIT BONUS! Deposit $5 -> Get $10 Margin. Get 2X your deposit up to $7,000!',
      },
      {
        text: 'Black Friday is coming to Drops Bot Respect Price Somebody gets GTA VI',
      },
      {
        text: 'Suara Dengarkan Lah Aku Register With Email Completed All Survey & Polling isi Bebas Min WD 100 Point est 50K',
        urls: ['https://suara.me/r/1XIB6BERZF'],
      },
      {
        text: 'Di film ini bukan cuma ceritain ram, ravana, sama sita. Tapi diceritain juga tentang Dharma',
      },
      { text: 'Ada yg udah nonton ramayana?' },
      { text: 'Btw kopi di sini makin mahal aja' },
      { text: 'siap2' },
      { text: 'Wiarsobek' },
      { text: 'Born to meow. Forced to lock in.' },
      { text: 'anyone know how to get grok premium free 1 month?' },
      { text: 'Hyperliquid generated more revenue for its holders in the last 24 hours than all other projects combined.' },
      // M1 tightened single-word false positives:
      { text: 'GM fam! Season 2 of my podcast is live on Spotify' },
      { text: 'Snapshot of BTC price action over the last 24 hours' },
      { text: 'Bitcoin validator count hits record as ETF inflows continue' },
      { text: 'antropoc udah tge ?' },
    ];

    for (const item of nonDrops) {
      const parsed = parseDropPost(item.text, item.urls ?? []);
      expect(parsed.isRelevantDrop).toBe(false);
    }
  });

  test('accepts genuine Web3 drops, testnets, waitlists, mints, quests, bounties, checkers, and all 9 H3 drops', () => {
    const validDrops: { text: string; urls?: string[] }[] = [
      {
        text: 'Clocked Waitlist \u2022 Login with x/email \u2022 Claim Username \u2022 Done Rewards Pool $100k Trading Competition di Testnet',
        urls: ['https://getclocked.com/'],
      },
      {
        text: 'Zero Guys Checker is live: zeroguys.fun/mint Check your eligibility. Mint starts free.',
        urls: ['https://zeroguys.fun/mint'],
      },
      {
        text: 'ZXOXO Signal (LayerZero Testnet) Connect X, Complete All Task, Submit Wallet EVM Testnet',
        urls: ['https://zxoxo.xyz/mine'],
      },
      {
        text: 'New Airdrops: TopNod Spin & Win Reward Pool: $50,000 USDC Download TopNod App, complete all tasks, unlock free spins',
        urls: ['https://topnod.com/'],
      },
      {
        text: 'New Whitelist : De1 Platform Register Submit Email Done',
        urls: ['https://platform.de1.ai/waitlist'],
      },
      {
        text: 'MagicBlock Quest Update: Play Solana apps, earn points, spin & win rewards',
        urls: ['https://quests.magicblock.app/projects/voble'],
      },
      {
        text: 'Make.fun Bounty for AI Agents: earn cash rewards on coding bounties',
        urls: ['https://make.fun/'],
      },
      {
        text: 'New Waitlist: Cookie Pro Early Access Connect Your X Account Complete All Task Submit Email',
        urls: ['https://pro.cookie.fun/infofi-early-access'],
      },
      {
        text: 'DECA Labs Raised $12M. Join The Creator Campaign Apply here Submit your handle & Email',
        urls: ['https://app.decalabs.ai/join/creator'],
      },
      {
        text: 'StrikeLabs Waitlist Register Submit Details Connect New Wallet Done',
        urls: ['https://strikelabs.app/waitlist'],
      },
      {
        text: 'City Protocol Wall Street Survival: Connect EVM Wallet, Start funds simulation, Earn Points',
        urls: ['https://www.cityprotocol.co/campaign'],
      },
      {
        text: 'Aligned Airdrop Update: The next monthly unlock is available to claim $ALIGN',
        urls: ['https://airdrop.alignedlayer.com/claim'],
      },
      {
        text: '\u6d4b\u8bd5\u7f51\u7a7a\u6295\u4efb\u52a1\uff1aNova Protocol $NOVA on Monad https://novaprotocol.xyz',
      },
      // H3: 9 genuine drops previously dropped by overly strict classifier
      {
        text: '$JRNY CLAIM GOES LIVE IN 30 MINUTES! Visit jrny.club/token-hub/claim',
      },
      {
        text: 'GenLayer Tokenomics is Live! Genesis Supply: 4.2B GEN Allocation details announced',
      },
      {
        text: 'LFWallet have a new easy task for all users',
      },
      {
        text: 'Hyperliquid genesis event live — check allocation for early traders',
      },
      {
        text: 'Linea token distribution is open, check if you qualify today',
      },
      {
        text: 'Kaito leaderboard rewards are live for top contributors',
      },
      {
        text: 'Earn Plume Miles on mainnet this week',
      },
      {
        text: 'Scroll Retroactive rewards announced for early users',
      },
      {
        text: 'Update garapan baru nih, langsung klaim poin harian',
      },
    ];

    for (const item of validDrops) {
      const parsed = parseDropPost(item.text, item.urls ?? []);
      const res = classifyDropRelevance({
        text: item.text,
        urls: parsed.urls,
        projectDomain: parsed.projectDomain,
        taskTypes: parsed.taskTypes,
      });
      expect(res.isDrop).toBe(true);
      expect(parsed.isRelevantDrop).toBe(true);
    }
  });

  test('recognizes both Simplified and Traditional Chinese drop terms without relying on URL alone', () => {
    const homepageOnly = parseDropPost('Nova https://novaprotocol.xyz/');
    expect(
      classifyDropRelevance({
        text: 'Nova https://novaprotocol.xyz/',
        urls: homepageOnly.urls,
        projectDomain: homepageOnly.projectDomain,
        taskTypes: homepageOnly.taskTypes,
      }).isDrop,
    ).toBe(false);

    const simplified = 'Nova \u6d4b\u8bd5\u7f51\u5df2\u4e0a\u7ebf https://novaprotocol.xyz/';
    const parsedSimp = parseDropPost(simplified);
    const resSimp = classifyDropRelevance({
      text: simplified,
      urls: parsedSimp.urls,
      projectDomain: parsedSimp.projectDomain,
      taskTypes: parsedSimp.taskTypes,
    });
    expect(resSimp).toEqual({ isDrop: true, reason: 'drop-keyword' });

    const traditional = 'Nova \u6e2c\u8a66\u7db2\u5df2\u4e0a\u7dda https://novaprotocol.xyz/';
    const parsedTrad = parseDropPost(traditional);
    const resTrad = classifyDropRelevance({
      text: traditional,
      urls: parsedTrad.urls,
      projectDomain: parsedTrad.projectDomain,
      taskTypes: parsedTrad.taskTypes,
    });
    expect(resTrad).toEqual({ isDrop: true, reason: 'drop-keyword' });
  });

  test('does not reject italicized announcements as wire prefixes while keeping genuine wire rejection', () => {
    const italicLower = parseDropPost('*Nova testnet is live* https://novaprotocol.xyz/');
    expect(italicLower.isRelevantDrop).toBe(true);

    const italicCaps = parseDropPost('*NOVA TESTNET IS LIVE* https://novaprotocol.xyz/');
    expect(italicCaps.isRelevantDrop).toBe(true);

    const wireColon = classifyDropRelevance({
      text: '*NVIDIA: earnings beat expectations in Q3',
      urls: [],
      taskTypes: ['other'],
    });
    expect(wireColon).toEqual({ isDrop: false, reason: 'news-wire' });

    const wireNoColon = classifyDropRelevance({
      text: "*NVIDIA BOARD IS NOT CONSIDERING ANY MERGER ACCORDING TO SOURCES *Bir kaynak CNBC'ye konustu",
      urls: [],
      taskTypes: ['other'],
    });
    expect(wireNoColon).toEqual({ isDrop: false, reason: 'news-wire' });
  });
});

describe('Project naming, ticker extraction, text cleanup, and bilingual/i18n handling', () => {
  test('humanizes domain-derived names from post text and unifies TopNod across wrapper domains', () => {
    expect(
      parseDropPost('Clocked Waitlist \u2022 Login with x/email \u2022 Claim Username', ['https://getclocked.com/']).project,
    ).toBe('Clocked');
    expect(
      parseDropPost('Zero Guys Checker is live Check your eligibility', ['https://zeroguys.fun/mint']).project,
    ).toBe('Zero Guys');
    expect(
      parseDropPost('City Protocol Wall Street Survival \u2022 Earn Points', ['https://www.cityprotocol.co/campaign']).project,
    ).toBe('City Protocol');
    expect(
      parseDropPost('DECA Labs | Join The Creator Campaign', ['https://app.decalabs.ai/join/creator']).project,
    ).toBe('DECA Labs');
    expect(
      parseDropPost('StrikeLabs Waitlist Register Submit Details', ['https://strikelabs.app/waitlist']).project,
    ).toBe('StrikeLabs');
    expect(
      parseDropPost('MagicBlock Quest Update \u2022 Earn points', ['https://quests.magicblock.app/']).project,
    ).toBe('MagicBlock');
    expect(
      parseDropPost('Coin Island Waitlist \u2022 Register Email \u2022 Claim Role', ['https://coinisland.io/play']).project,
    ).toBe('Coin Island');

    // TopNod split regression: topnod.onelink.me + taskon.xyz + topnod.com all resolve to "TopNod".
    const p1 = parseDropPost('TopNod Free Daily Spin Total Rewards 50k USDC', ['https://topnod.onelink.me/orvm/events']);
    const p2 = parseDropPost('#Update please check Topnod result and claim your USDC rewards', ['https://taskon.xyz/quest/385587001']);
    const p3 = parseDropPost('New Airdrops: TopNod Spin & Win Reward Pool: $50,000 USDC', ['https://topnod.com/']);
    expect(p1.project.toLowerCase()).toBe('topnod');
    expect(p2.project.toLowerCase()).toBe('topnod');
    expect(p3.project.toLowerCase()).toBe('topnod');
    expect(p1.projectDomain).toBeUndefined();
    expect(p2.projectDomain).toBeUndefined();
    expect(p3.projectDomain).toBe('topnod.com');
  });

  test('blocks major base-asset and payout-currency tickers from hijacking project ticker', () => {
    expect(parseDropPost('Claim rewards paid in $BTC and $ETH on testnet').ticker).toBeUndefined();
    expect(parseDropPost('Season 2 closed with 193,028,176 $HYPE paid out across 32 decks', ['https://hypest.gg/']).ticker).toBeUndefined();
    expect(parseDropPost('Nova Protocol $NOVA testnet & faucet live', ['https://novaprotocol.xyz']).ticker).toBe('NOVA');
    expect(parseDropPost('Aligned Airdrop Update: claim $ALIGN now', ['https://airdrop.alignedlayer.com/claim']).ticker).toBe('ALIGN');
  });

  test('cleans wire artifacts, dangling labels, bare referral URLs, bilingual duplicates, and truncates at word boundaries', () => {
    expect(
      cleanSummaryText(
        'New Waitlist: Cookie Pro Early Access \u{1FA82} Register : https://pro.cookie.fun/infofi-early-access \u2796 Connect Your X Account \u2796 Complete All Task \u2796 Done \u{1F4D6} Source: https://x.com/cookiedotfun/status/1',
      ),
    ).toBe('New Waitlist: Cookie Pro Early Access \u00b7 Connect Your X Account \u00b7 Complete All Task \u00b7 Done');

    expect(
      cleanSummaryText('Clocked Waitlist getclocked.com/?ref=HQAKP9 \u2022 Login with x/email \u2022 Claim Username \u2022 Done'),
    ).toBe('Clocked Waitlist \u00b7 Login with x/email \u00b7 Claim Username \u00b7 Done');

    expect(cleanSummaryText('Check Reward Make Fun\nCheck Reward Make Fun')).toBe('Check Reward Make Fun');
    expect(cleanSummaryText('Check Reward Make FunCheck Reward Make Fun')).toBe('Check Reward Make Fun');

    // Bilingual EN + TR duplicate keeps English only.
    const enTr = stripBilingualDuplicate(
      "Nvidia expands AI chip supply chain in Asia.\nNvidia Asya'da yapay zeka \u00e7ipi tedarik zincirini geni\u015fletiyor ve yeni yat\u0131r\u0131m a\u00e7\u0131klad\u0131.",
    );
    expect(enTr).toContain('Nvidia expands AI chip supply chain');
    expect(enTr).not.toContain('geni\u015fletiyor');

    // Indonesian detection flags non-English Latin posts.
    expect(
      detectNonEnglishLatin('Ini game mekanisme nya hold to earn. Di bilang full gratis sih gak juga karna minimal klo mau play harus punya karakter.'),
    ).toBe(true);
    expect(detectNonEnglishLatin('Complete daily testnet quests and claim your faucet tokens on Base.')).toBe(false);

    // Word-boundary truncation never cuts mid-word.
    const long =
      'Elysium x Opensea 8,888 Commemorative NFTs Eligibility held a Hypurr NFT and received genesis allocation across HyperCore and HyperEVM including staked balances for early participants in the community';
    const cut = truncateAtWordBoundary(long, 120);
    expect(cut.length).toBeLessThanOrEqual(120);
    expect(cut.endsWith('\u2026')).toBe(true);
    expect(cut).not.toMatch(/\b[a-zA-Z]{1,2}\u2026$/);
  });
});

describe('Safety precision — doubling scams, raw IP links, exact http twin suppression, and shortener retention', () => {
  test('M1: flags crypto doubling / advance-fee scams as risk and leaves points multipliers ok', () => {
    const res = evaluateSafety({
      urls: ['https://promo-claim.xyz/'],
      text: 'Send 100 USDT to receive 1000 back, airdrop guaranteed',
      knownProjectDomains: new Map(),
      trustMax: 0.8,
      sourceCount: 2,
    });
    expect(res.level).toBe('risk');
    expect(res.reasons).toContain('Crypto doubling / advance-fee scam phrasing');

    const depositMultiplier = evaluateSafety({
      urls: ['https://promo-claim.xyz/'],
      text: 'Deposit 1 ETH and get 2x back instantly',
      knownProjectDomains: new Map(),
      trustMax: 0.8,
      sourceCount: 2,
    });
    expect(depositMultiplier.level).toBe('risk');
    expect(depositMultiplier.reasons).toContain('Crypto doubling / advance-fee scam phrasing');

    const pointsMultiplier = evaluateSafety({
      domain: 'novaprotocol.xyz',
      urls: ['https://novaprotocol.xyz/quest'],
      text: 'Nova testnet quest: earn 2x back in points on each completed task',
      knownProjectDomains: new Map([['novaprotocol.xyz', 'Nova Protocol']]),
      trustMax: 0.8,
      sourceCount: 2,
    });
    expect(pointsMultiplier.level).toBe('ok');
    expect(pointsMultiplier.reasons).toEqual([]);
  });

  test('M2: flags non-DNS raw IP links as risk and strips from display links while benign DNS IP stays silent', async () => {
    const maliciousText = 'Airdrop claim live now http://45.33.12.9/claim';
    const parsed = parseDropPost(maliciousText);
    expect(parsed.rawIpUrls?.some(u => u.includes('45.33.12.9'))).toBe(true);

    const safety = evaluateSafety({
      domain: parsed.projectDomain,
      urls: parsed.urls,
      rawIpUrls: parsed.rawIpUrls,
      text: maliciousText,
      knownProjectDomains: new Map(),
      trustMax: 0.8,
      sourceCount: 2,
    });
    expect(safety.level).toBe('risk');
    expect(safety.reasons).toContain('Raw IP link: 45.33.12.9');
    expect(selectFeedLinks([...parsed.urls, ...(parsed.rawIpUrls ?? [])])).toEqual([]);

    // End-to-end ingest + queryFeed: flagged risk with Raw IP reason, stripped from displayed links.
    const db = createSqliteD1();
    const now = 1_795_300_000_000;
    await db
      .prepare(`INSERT INTO sources (id, platform, handle, lang, trust, enabled) VALUES ('telegram:ch1', 'telegram', 'ch1', 'en', 0.8, 1)`)
      .run();
    const surfIndex = { byDomain: new Map(), byTicker: new Map() };
    const ing = await ingestPostIntoCluster(
      db,
      {
        postId: 'telegram:ch1:ip1',
        sourceId: 'telegram:ch1',
        sourceTrust: 0.8,
        postUrl: 'https://t.me/ch1/ip1',
        postedAt: now,
        text: maliciousText,
      },
      { knownDomains: new Map() },
      surfIndex,
      new Map(),
      new Set(),
      now,
    );
    expect(ing.riskLevel).toBe('risk');

    const feed = await queryFeed(db, new Set(), { risk: 'include' });
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0].risk.level).toBe('risk');
    expect(feed.items[0].risk.reasons).toContain('Raw IP link: 45.33.12.9');
    expect(feed.items[0].links.some(l => l.url.includes('45.33.12.9'))).toBe(false);

    // Benign DNS IP (1.1.1.1) stays cleanly stripped with zero warning.
    const benignSafety = evaluateSafety({
      domain: 'acepyr.xyz',
      urls: ['https://acepyr.xyz/', 'http://1.1.1.1/'],
      text: 'Acepyr testnet live http://1.1.1.1/',
      knownProjectDomains: new Map([['acepyr.xyz', 'Acepyr']]),
      trustMax: 0.8,
      sourceCount: 2,
    });
    expect(benignSafety.level).toBe('ok');
    expect(benignSafety.reasons).toEqual([]);
  });

  test('M3: suppresses plain http:// only for an exact canonical https:// twin, not host-wide', () => {
    const known = new Map([['novaproto.xyz', 'NovaProto']]);

    // Different path on same host: MUST still flag Insecure transport.
    const diffPath = evaluateSafety({
      domain: 'novaproto.xyz',
      urls: ['https://novaproto.xyz', 'http://novaproto.xyz/claim'],
      text: 'NovaProto testnet claim live',
      knownProjectDomains: known,
      trustMax: 0.8,
      sourceCount: 2,
    });
    expect(diffPath.level).toBe('warn');
    expect(diffPath.reasons).toContain('Insecure transport (plain http): http://novaproto.xyz/claim');

    // Exact canonical twin: suppressed cleanly.
    const exactTwin = evaluateSafety({
      domain: 'novaproto.xyz',
      urls: ['https://novaproto.xyz/claim', 'http://novaproto.xyz/claim'],
      text: 'NovaProto testnet claim live',
      knownProjectDomains: known,
      trustMax: 0.8,
      sourceCount: 2,
    });
    expect(exactTwin.level).toBe('ok');
    expect(exactTwin.reasons).toEqual([]);
  });

  test('L3: reconcileSafetyReasons preserves URL shortener warning even when shortener is absent from displayed links', () => {
    const reconciled = reconcileSafetyReasons({
      level: 'warn',
      reasons: ['URL shortener used: t.co', 'Domain not in verified registry: jrny.club'],
      domain: 'jrny.club',
      cleanedLinks: ['https://jrny.club/token-hub/claim'],
      knownDomains: new Set(['jrny.club']),
    });
    expect(reconciled.level).toBe('warn');
    expect(reconciled.reasons).toEqual(['URL shortener used: t.co']);
  });
});

describe('D1 clustering, sliding windows, pagination, ingest verdict persistence, and SQL warning precision', () => {
  test('M4: sliding window merges posts 2 minutes apart across a 3-day boundary and separates posts 8 days apart', async () => {
    const db = createSqliteD1();
    await db
      .prepare(`INSERT INTO sources (id, platform, handle, lang, trust, enabled) VALUES ('telegram:ch1', 'telegram', 'ch1', 'en', 0.75, 1)`)
      .run();
    const surfIndex = { byDomain: new Map(), byTicker: new Map() };
    const THREE_DAYS_MS = 3 * 86_400_000;
    const boundary = Math.ceil(Date.parse('2026-11-10T00:00:00Z') / THREE_DAYS_MS) * THREE_DAYS_MS;
    const tBefore = boundary - 60_000; // 1 min before 3-day epoch boundary
    const tAfter = boundary + 60_000; // 1 min after 3-day epoch boundary
    const tFar = tBefore + 8 * 86_400_000; // 8 days later
    const tFarFollowup = tFar + 3_600_000; // 1 hour after tFar

    // computeClusterId remains backward-compatible regardless of postedAt.
    expect(await computeClusterId(undefined, undefined, 'TopNod', 'p1', tBefore)).toBe(
      await computeClusterId(undefined, undefined, 'TopNod', 'p2', tFar),
    );

    const r1 = await ingestPostIntoCluster(
      db,
      {
        postId: 'telegram:ch1:m4_1',
        sourceId: 'telegram:ch1',
        sourceTrust: 0.75,
        postUrl: 'https://t.me/ch1/m4_1',
        postedAt: tBefore,
        text: 'TopNod Free Daily Spin Total Rewards 50k USDC https://topnod.onelink.me/orvm/events',
      },
      { knownDomains: new Map() },
      surfIndex,
      new Map(),
      new Set(),
      tAfter,
    );

    const r2 = await ingestPostIntoCluster(
      db,
      {
        postId: 'telegram:ch1:m4_2',
        sourceId: 'telegram:ch1',
        sourceTrust: 0.75,
        postUrl: 'https://t.me/ch1/m4_2',
        postedAt: tAfter,
        text: '#Update please check Topnod result and claim rewards https://taskon.xyz/quest/385587001',
      },
      { knownDomains: new Map() },
      surfIndex,
      new Map(),
      new Set(),
      tAfter,
    );

    // 2 minutes apart across the 3-day epoch boundary MUST merge!
    expect(r2.clusterId).toBe(r1.clusterId);

    const rFar = await ingestPostIntoCluster(
      db,
      {
        postId: 'telegram:ch1:m4_3',
        sourceId: 'telegram:ch1',
        sourceTrust: 0.75,
        postUrl: 'https://t.me/ch1/m4_3',
        postedAt: tFar,
        text: 'TopNod New Airdrop Campaign Season 3 Rewards https://taskon.xyz/quest/999999',
      },
      { knownDomains: new Map() },
      surfIndex,
      new Map(),
      new Set(),
      tFar,
    );

    // 8 days apart MUST stay separate!
    expect(rFar.clusterId).not.toBe(r1.clusterId);

    // Follow-up 1 hour after the new cluster MUST merge into rFar!
    const rFarFollow = await ingestPostIntoCluster(
      db,
      {
        postId: 'telegram:ch1:m4_4',
        sourceId: 'telegram:ch1',
        sourceTrust: 0.75,
        postUrl: 'https://t.me/ch1/m4_4',
        postedAt: tFarFollowup,
        text: 'TopNod New Airdrop Campaign reminder check eligibility https://taskon.xyz/quest/999999',
      },
      { knownDomains: new Map() },
      surfIndex,
      new Map(),
      new Set(),
      tFarFollowup,
    );
    expect(rFarFollow.clusterId).toBe(rFar.clusterId);
  });

  test('H2: persists ingest is_drop verdict so CJK ("Nexus: other") and >195-char English drops are never hidden by queryFeed', async () => {
    const db = createSqliteD1();
    const now = 1_795_364_909_000;
    await db
      .prepare(`INSERT INTO sources (id, platform, handle, lang, trust, enabled) VALUES ('telegram:ch1', 'telegram', 'ch1', 'en', 0.8, 1)`)
      .run();
    const surfIndex = { byDomain: new Map(), byTicker: new Map() };

    // 1) CJK drop post whose rule summary collapses to "Nexus: other"
    const cjkPost = '\u7a7a\u6295\u4efb\u52a1 Nexus';
    const cjkRes = await ingestPostIntoCluster(
      db,
      {
        postId: 'telegram:ch1:cjk1',
        sourceId: 'telegram:ch1',
        sourceTrust: 0.8,
        postUrl: 'https://t.me/ch1/cjk1',
        postedAt: now - 1_000,
        text: cjkPost,
        sourceLang: 'zh',
      },
      { knownDomains: new Map() },
      surfIndex,
      new Map(),
      new Set(),
      now,
    );
    expect(cjkRes.parsed.isRelevantDrop).toBe(true);
    expect(cjkRes.parsed.summary).toBe('Nexus: other');

    // 2) >195-char English drop whose drop keyword appears AFTER char 210
    const longLead =
      'VortexLayer is building a modular verifiable compute mesh connecting independent GPU clusters across global regions for real-time inference routing, low-latency proof verification, and open developer tooling across the ecosystem. ';
    expect(longLead.length).toBeGreaterThan(200);
    const longDropText = `${longLead}Join the incentivized testnet and claim your airdrop allocation today.`;
    const longRes = await ingestPostIntoCluster(
      db,
      {
        postId: 'telegram:ch1:long1',
        sourceId: 'telegram:ch1',
        sourceTrust: 0.8,
        postUrl: 'https://t.me/ch1/long1',
        postedAt: now,
        text: longDropText,
      },
      { knownDomains: new Map() },
      surfIndex,
      new Map(),
      new Set(),
      now,
    );
    expect(longRes.parsed.isRelevantDrop).toBe(true);
    expect(longRes.parsed.summary.length).toBeLessThanOrEqual(195);
    expect(longRes.parsed.summary.toLowerCase()).not.toContain('airdrop');

    // Verify is_drop = 1 persisted and never demoted by a subsequent non-drop post on the same cluster.
    await ingestPostIntoCluster(
      db,
      {
        postId: 'telegram:ch1:long2',
        sourceId: 'telegram:ch1',
        sourceTrust: 0.8,
        postUrl: 'https://t.me/ch1/long2',
        postedAt: now + 500,
        text: 'VortexLayer team is live on stage right now',
      },
      { knownDomains: new Map() },
      surfIndex,
      new Map(),
      new Set(),
      now + 500,
    );

    const row = await db
      .prepare('SELECT is_drop FROM clusters WHERE id = ?1')
      .bind(longRes.clusterId)
      .first<{ is_drop: number | null }>();
    expect(row?.is_drop).toBe(1);

    // 3) Legacy pre-migration row (is_drop IS NULL) with truncated summary "LegacyNexus: other"
    //    but full CJK drop post in posts.text -> also survives queryFeed!
    await db
      .prepare(
        `INSERT INTO clusters (id, project, ticker, domain, chains, task_types, summary, summary_source, risk_level, risk_reasons, score, source_count, first_seen, last_seen, is_drop)
         VALUES ('legacy_cjk', 'LegacyNexus', NULL, NULL, '[]', '["other"]', 'LegacyNexus: other', 'rule', 'ok', '[]', 0.7, 1, ?1, ?1, NULL)`,
      )
      .bind(now - 2_000)
      .run();
    await db
      .prepare(
        `INSERT INTO posts (id, source_id, post_url, posted_at, text, urls, cluster_id, created_at)
         VALUES ('p_legacy_cjk', 'telegram:ch1', 'https://t.me/ch1/legacy_cjk', ?1, ?2, '[]', 'legacy_cjk', ?1)`,
      )
      .bind(now - 2_000, '\u7a7a\u6295\u4efb\u52a1 LegacyNexus')
      .run();

    const feed = await queryFeed(db, new Set(), { risk: 'include' });
    const ids = feed.items.map(i => i.id);
    expect(ids).toContain(cjkRes.clusterId);
    expect(ids).toContain(longRes.clusterId);
    expect(ids).toContain('legacy_cjk');
  });

  test('H1: keyset batch pagination prevents page starvation when 100 high-score legacy noise rows precede 5 real drops', async () => {
    const db = createSqliteD1();
    const now = 1_795_364_909_000;
    await db
      .prepare(`INSERT INTO sources (id, platform, handle, lang, trust, enabled) VALUES ('telegram:ch1', 'telegram', 'ch1', 'en', 0.8, 1)`)
      .run();

    // Seed 100 high-score legacy noise rows (is_drop = NULL, news/chatter post text).
    for (let i = 0; i < 100; i++) {
      const cid = `noise_${String(i).padStart(3, '0')}`;
      const ts = now - i * 1_000;
      await db
        .prepare(
          `INSERT INTO clusters (id, project, ticker, domain, chains, task_types, summary, summary_source, risk_level, risk_reasons, score, source_count, first_seen, last_seen, is_drop)
           VALUES (?1, 'Noise', NULL, NULL, '[]', '["other"]', 'Bitcoin Drops Below $60,000', 'rule', 'ok', '[]', 0.99, 3, ?2, ?2, NULL)`,
        )
        .bind(cid, ts)
        .run();
      await db
        .prepare(
          `INSERT INTO posts (id, source_id, post_url, posted_at, text, urls, cluster_id, created_at)
           VALUES (?1, 'telegram:ch1', ?2, ?3, 'Bitcoin Drops Below $60,000', '[]', ?4, ?3)`,
        )
        .bind(`p_${cid}`, `https://t.me/ch1/${i}`, ts, cid)
        .run();
    }

    // Seed 5 real drops with lower score and older timestamps than all 100 noise rows.
    const expectedIds: string[] = [];
    for (let j = 0; j < 5; j++) {
      const cid = `real_drop_${j}`;
      expectedIds.push(cid);
      const ts = now - 200_000 - j * 1_000;
      await db
        .prepare(
          `INSERT INTO clusters (id, project, ticker, domain, chains, task_types, summary, summary_source, risk_level, risk_reasons, score, source_count, first_seen, last_seen, is_drop)
           VALUES (?1, ?2, NULL, ?3, '["Base"]', '["testnet"]', 'Testnet airdrop live on Base', 'rule', 'ok', '[]', 0.45, 1, ?4, ?4, 1)`,
        )
        .bind(cid, `RealProto${j}`, `realproto${j}.xyz`, ts)
        .run();
      await db
        .prepare(
          `INSERT INTO posts (id, source_id, post_url, posted_at, text, urls, cluster_id, created_at)
           VALUES (?1, 'telegram:ch1', ?2, ?3, 'Testnet airdrop live on Base', ?4, ?5, ?3)`,
        )
        .bind(`p_${cid}`, `https://t.me/ch1/real_${j}`, ts, JSON.stringify([`https://realproto${j}.xyz/testnet`]), cid)
        .run();
    }

    const byScore = await queryFeed(db, new Set(), { sort: 'score', limit: 20 });
    expect(byScore.items.map(i => i.id)).toEqual(expectedIds);

    const byNew = await queryFeed(db, new Set(), { sort: 'new', limit: 20 });
    expect(byNew.items.map(i => i.id)).toEqual(expectedIds);
  });

  test('safety suppresses http:// warning for exact https twin and always-HTTPS platforms, and reconciles stale registry warnings in queryFeed', async () => {
    const known = new Map([['magicblock.app', 'MagicBlock']]);
    const safety = evaluateSafety({
      domain: 'magicblock.app',
      urls: ['https://quests.magicblock.app/', 'http://quests.magicblock.app/', 'http://t.me/atoms_chat', 'http://1.1.1.1/'],
      text: 'MagicBlock Quest Update: earn points on Solana',
      knownProjectDomains: known,
      trustMax: 0.7,
      sourceCount: 2,
    });
    expect(safety.level).toBe('ok');
    expect(safety.reasons).toEqual([]);

    // Legacy D1 rows: news/disabled-source rows filtered out; stale warnings reconciled; links cleaned.
    const db = createSqliteD1();
    const now = 1_795_364_909_000;
    await db
      .prepare(
        `INSERT INTO sources (id, platform, handle, lang, trust, enabled)
         VALUES ('telegram:cointelegraph', 'telegram', 'cointelegraph', 'en', 0.75, 0),
                ('telegram:airdropfind', 'telegram', 'airdropfind', 'en', 0.75, 1)`,
      )
      .run();

    // Legacy junk news cluster from disabled source.
    await db
      .prepare(
        `INSERT INTO clusters (id, project, ticker, domain, chains, task_types, summary, summary_source, risk_level, risk_reasons, score, source_count, first_seen, last_seen)
         VALUES ('news1', 'Cointelegraph', NULL, 'cointelegraph.com', '[]', '["quest"]', 'ECB regulation News | Markets | YouTube', 'rule', 'warn', '["Domain not in verified registry: cointelegraph.com"]', 1.02, 3, ?1, ?1)`,
      )
      .bind(now)
      .run();
    await db
      .prepare(
        `INSERT INTO posts (id, source_id, post_url, posted_at, text, urls, cluster_id, created_at)
         VALUES ('p_news', 'telegram:cointelegraph', 'https://t.me/cointelegraph/73439', ?1, 'ECB News | Markets | YouTube', '["https://cointelegraph.com/"]', 'news1', ?1)`,
      )
      .bind(now)
      .run();

    // Legacy valid drop cluster with stale "Domain not in verified registry" + exact http twin + ref duplicates.
    await db
      .prepare(
        `INSERT INTO clusters (id, project, ticker, domain, chains, task_types, summary, summary_source, risk_level, risk_reasons, score, source_count, first_seen, last_seen)
         VALUES ('drop1', 'Magicblock', NULL, 'magicblock.app', '["Solana"]', '["points","quest"]', 'MagicBlock Quest Update \u2022 Earn points \u2013 Link', 'rule', 'warn', '["Domain not in verified registry: magicblock.app","Insecure transport (plain http): http://quests.magicblock.app/"]', 0.85, 2, ?1, ?1)`,
      )
      .bind(now)
      .run();
    await db
      .prepare(
        `INSERT INTO posts (id, source_id, post_url, posted_at, text, urls, cluster_id, created_at)
         VALUES ('p_drop', 'telegram:airdropfind', 'https://t.me/airdropfind/129858', ?1, 'MagicBlock Quest', '["https://quests.magicblock.app/?ref=ABC","http://quests.magicblock.app/","https://t.me/airdropfind?boost"]', 'drop1', ?1)`,
      )
      .bind(now)
      .run();

    const feed = await queryFeed(db, new Set(['magicblock.app']), { risk: 'include' });
    expect(feed.items.map(i => i.id)).toEqual(['drop1']);
    expect(feed.items[0].risk.level).toBe('ok');
    expect(feed.items[0].risk.reasons).toEqual([]);
    expect(feed.items[0].links).toEqual([{ url: 'https://quests.magicblock.app/', known: true }]);
    expect(feed.items[0].summary).not.toContain('\u2013 Link');
  });

  test('L2: known domain clears ONLY its own unverified registry warning and preserves another unverified domain warning', async () => {
    const db = createSqliteD1();
    const now = 1_795_200_000_000;
    await db
      .prepare(`INSERT INTO sources (id, platform, handle, lang, trust, enabled) VALUES ('telegram:ch1', 'telegram', 'ch1', 'en', 0.7, 1)`)
      .run();
    const surfIndex = { byDomain: new Map(), byTicker: new Map() };

    // First ingest before known_domains was seeded -> warn "Domain not in verified registry: magicblock.app".
    const first = await ingestPostIntoCluster(
      db,
      {
        postId: 'telegram:ch1:1',
        sourceId: 'telegram:ch1',
        sourceTrust: 0.7,
        postUrl: 'https://t.me/ch1/1',
        postedAt: now - 3600_000,
        text: 'MagicBlock Quest Update: earn points on Solana https://quests.magicblock.app/',
      },
      { knownDomains: new Map() },
      surfIndex,
      new Map(),
      new Set(),
      now,
    );
    expect(first.riskLevel).toBe('warn');

    // Inject a second unverified domain warning on the same cluster (e.g. from another linked domain).
    await db
      .prepare(`UPDATE clusters SET risk_reasons = ?2 WHERE id = ?1`)
      .bind(
        first.clusterId,
        JSON.stringify([
          'Domain not in verified registry: magicblock.app',
          'Domain not in verified registry: unverified-partner.xyz',
        ]),
      )
      .run();

    // Second ingest after known_domains seeds magicblock.app ONLY -> magicblock.app warning clears,
    // while unverified-partner.xyz warning MUST survive!
    const knownNow = new Map([['magicblock.app', 'MagicBlock']]);
    const second = await ingestPostIntoCluster(
      db,
      {
        postId: 'telegram:ch1:2',
        sourceId: 'telegram:ch1',
        sourceTrust: 0.7,
        postUrl: 'https://t.me/ch1/2',
        postedAt: now - 600_000,
        text: 'MagicBlock New Quest on Solana https://quests.magicblock.app/voble',
      },
      { knownDomains: knownNow },
      surfIndex,
      knownNow,
      new Set(),
      now,
    );
    expect(second.riskLevel).toBe('warn');

    const row = await db
      .prepare('SELECT risk_level, risk_reasons FROM clusters WHERE id = ?1')
      .bind(first.clusterId)
      .first<{ risk_level: string; risk_reasons: string }>();
    expect(row?.risk_level).toBe('warn');
    expect(JSON.parse(row?.risk_reasons ?? '[]')).toEqual([
      'Domain not in verified registry: unverified-partner.xyz',
    ]);
  });

  test('ingestPostIntoCluster clears sole stale registry warning to ok when domain becomes known', async () => {
    const db = createSqliteD1();
    const now = 1_795_200_000_000;
    await db
      .prepare(`INSERT INTO sources (id, platform, handle, lang, trust, enabled) VALUES ('telegram:ch1', 'telegram', 'ch1', 'en', 0.7, 1)`)
      .run();
    const surfIndex = { byDomain: new Map(), byTicker: new Map() };

    const first = await ingestPostIntoCluster(
      db,
      {
        postId: 'telegram:ch1:10',
        sourceId: 'telegram:ch1',
        sourceTrust: 0.7,
        postUrl: 'https://t.me/ch1/10',
        postedAt: now - 3600_000,
        text: 'MagicBlock Quest Update: earn points on Solana https://quests.magicblock.app/',
      },
      { knownDomains: new Map() },
      surfIndex,
      new Map(),
      new Set(),
      now,
    );
    expect(first.riskLevel).toBe('warn');

    const knownNow = new Map([['magicblock.app', 'MagicBlock']]);
    const second = await ingestPostIntoCluster(
      db,
      {
        postId: 'telegram:ch1:11',
        sourceId: 'telegram:ch1',
        sourceTrust: 0.7,
        postUrl: 'https://t.me/ch1/11',
        postedAt: now - 600_000,
        text: 'MagicBlock New Quest on Solana https://quests.magicblock.app/voble',
      },
      { knownDomains: knownNow },
      surfIndex,
      knownNow,
      new Set(),
      now,
    );
    expect(second.riskLevel).toBe('ok');

    const row = await db
      .prepare('SELECT risk_level, risk_reasons FROM clusters WHERE id = ?1')
      .bind(first.clusterId)
      .first<{ risk_level: string; risk_reasons: string }>();
    expect(row?.risk_level).toBe('ok');
    expect(JSON.parse(row?.risk_reasons ?? '[]')).toEqual([]);
  });

  test('base ID occupancy and identity-filtered candidates stay accurate past 200 unrelated domainless clusters', async () => {
    const { db } = createTestD1();
    const now = 1_795_364_909_000;
    await db
      .prepare(`INSERT INTO sources (id, platform, handle, lang, trust, enabled) VALUES ('telegram:ch1', 'telegram', 'ch1', 'en', 0.8, 1)`)
      .run();
    const surfIndex = { byDomain: new Map(), byTicker: new Map() };

    // 1. Seed older base cluster for "GammaQuest" 10 days before `now` (out of 3d window).
    const oldTs = now - 10 * 86_400_000;
    const baseOld = await ingestPostIntoCluster(
      db,
      {
        postId: 'telegram:ch1:gq_old',
        sourceId: 'telegram:ch1',
        sourceTrust: 0.8,
        postUrl: 'https://t.me/ch1/gq_old',
        postedAt: oldTs,
        text: 'GammaQuest testnet campaign live on Base',
      },
      { knownDomains: new Map() },
      surfIndex,
      new Map(),
      new Set(),
      oldTs,
    );

    // 2. Seed an in-window cluster for "BetaQuest" (1 hour before `now`).
    const betaBase = await ingestPostIntoCluster(
      db,
      {
        postId: 'telegram:ch1:bq_1',
        sourceId: 'telegram:ch1',
        sourceTrust: 0.8,
        postUrl: 'https://t.me/ch1/bq_1',
        postedAt: now - 3_600_000,
        text: 'BetaQuest testnet campaign live on Base',
      },
      { knownDomains: new Map() },
      surfIndex,
      new Map(),
      new Set(),
      now - 3_600_000,
    );

    // 3. Insert 205 newer unrelated domainless clusters within the 3d window so LIMIT 200 would fill up.
    for (let i = 0; i < 205; i++) {
      const ts = now - i * 1_000;
      await db
        .prepare(
          `INSERT INTO clusters (id, project, ticker, domain, chains, task_types, summary, summary_source, risk_level, risk_reasons, score, source_count, first_seen, last_seen, is_drop, project_key)
           VALUES (?1, ?2, NULL, NULL, '[]', '["testnet"]', 'Unrelated testnet', 'rule', 'ok', '[]', 0.5, 1, ?3, ?3, 1, ?4)`,
        )
        .bind(`filler_${i}`, `UnrelatedProto${i}`, ts, `unrelatedproto${i}`)
        .run();
    }

    // 4. Ingest new "GammaQuest" post at `now`: must detect out-of-window base row and NOT merge into `baseOld`.
    const gammaNew = await ingestPostIntoCluster(
      db,
      {
        postId: 'telegram:ch1:gq_new',
        sourceId: 'telegram:ch1',
        sourceTrust: 0.8,
        postUrl: 'https://t.me/ch1/gq_new',
        postedAt: now,
        text: 'GammaQuest Season 2 airdrop claim live',
      },
      { knownDomains: new Map() },
      surfIndex,
      new Map(),
      new Set(),
      now,
    );
    expect(gammaNew.clusterId).not.toBe(baseOld.clusterId);

    // 5. Ingest follow-up "BetaQuest" post at `now`: identity filter runs before LIMIT 200 so it STILL merges.
    const betaFollow = await ingestPostIntoCluster(
      db,
      {
        postId: 'telegram:ch1:bq_2',
        sourceId: 'telegram:ch1',
        sourceTrust: 0.8,
        postUrl: 'https://t.me/ch1/bq_2',
        postedAt: now,
        text: 'BetaQuest reminder complete testnet tasks',
      },
      { knownDomains: new Map() },
      surfIndex,
      new Map(),
      new Set(),
      now,
    );
    expect(betaFollow.clusterId).toBe(betaBase.clusterId);
  });

  test('normalizes full non-alphanumeric project keys in migration 0006 and merges non-base candidates behind 200 fillers', async () => {
    const { db, sqlite } = createTestD1(MIGRATION_FILES.slice(0, 5));
    const now = 1_795_364_909_000;
    await db
      .prepare(`INSERT INTO sources (id, platform, handle, lang, trust, enabled) VALUES ('telegram:ch1', 'telegram', 'ch1', 'en', 0.8, 1)`)
      .run();
    const surfIndex = { byDomain: new Map(), byTicker: new Map() };

    // Legacy pre-0006 in-window non-base clusters (ticker-derived IDs) with punctuation or Unicode uppercase.
    const legacyTickerClusterId = await computeClusterId(undefined, 'ABT', 'Alpha+Beta', 'p_legacy', now - 3_600_000);
    const istanbulLegacyId = await computeClusterId(undefined, 'IST', '\u0130stanbul', 'p_ist', now - 3_600_000);
    const kelvinLegacyId = await computeClusterId(undefined, 'KLV', '\u212Aelvin', 'p_klv', now - 3_600_000);
    await db
      .prepare(
        `INSERT INTO clusters (id, project, ticker, domain, chains, task_types, summary, summary_source, risk_level, risk_reasons, score, source_count, first_seen, last_seen)
         VALUES (?1, 'Alpha+Beta', 'ABT', NULL, '[]', '["testnet"]', 'Alpha+Beta testnet live', 'rule', 'ok', '[]', 0.5, 1, ?2, ?2),
                (?3, '\u0130stanbul', 'IST', NULL, '[]', '["testnet"]', 'Istanbul testnet live', 'rule', 'ok', '[]', 0.5, 1, ?2, ?2),
                (?4, '\u212Aelvin', 'KLV', NULL, '[]', '["testnet"]', 'Kelvin testnet live', 'rule', 'ok', '[]', 0.5, 1, ?2, ?2)`,
      )
      .bind(legacyTickerClusterId, now - 3_600_000, istanbulLegacyId, kelvinLegacyId)
      .run();

    applyMigrations(sqlite, [MIGRATION_FILES[5]]);

    const migratedRow = await db
      .prepare('SELECT project_key FROM clusters WHERE id = ?1')
      .bind(legacyTickerClusterId)
      .first<{ project_key: string | null }>();
    expect(migratedRow?.project_key).toBe('alphabeta');
    const migratedIst = await db
      .prepare('SELECT project_key FROM clusters WHERE id = ?1')
      .bind(istanbulLegacyId)
      .first<{ project_key: string | null }>();
    expect(migratedIst?.project_key).toBe('istanbul');
    const migratedKelvin = await db
      .prepare('SELECT project_key FROM clusters WHERE id = ?1')
      .bind(kelvinLegacyId)
      .first<{ project_key: string | null }>();
    expect(migratedKelvin?.project_key).toBe('kelvin');

    // Non-base clusters still with project_key = NULL (e.g. legacy unmigrated rows inserted raw).
    const nullKeyClusterId = 'win_plus_proto_nonbase';
    const nullIstanbulClusterId = 'win_istanbul_net_nonbase';
    const nullKelvinClusterId = 'win_kelvin_net_nonbase';
    await db
      .prepare(
        `INSERT INTO clusters (id, project, ticker, domain, chains, task_types, summary, summary_source, risk_level, risk_reasons, score, source_count, first_seen, last_seen, is_drop, project_key)
         VALUES (?1, 'Plus+Proto', NULL, NULL, '[]', '["quest"]', 'Plus+Proto quest live', 'rule', 'ok', '[]', 0.5, 1, ?2, ?2, 1, NULL),
                (?3, '\u0130stanbulNet', NULL, NULL, '[]', '["quest"]', 'IstanbulNet quest live', 'rule', 'ok', '[]', 0.5, 1, ?2, ?2, 1, NULL),
                (?4, '\u212AelvinNet', NULL, NULL, '[]', '["quest"]', 'KelvinNet quest live', 'rule', 'ok', '[]', 0.5, 1, ?2, ?2, 1, NULL)`,
      )
      .bind(nullKeyClusterId, now - 3_600_000, nullIstanbulClusterId, nullKelvinClusterId)
      .run();

    // Seed 205 newer unrelated domainless filler clusters within the 3d window.
    for (let i = 0; i < 205; i++) {
      const ts = now - i * 1_000;
      await db
        .prepare(
          `INSERT INTO clusters (id, project, ticker, domain, chains, task_types, summary, summary_source, risk_level, risk_reasons, score, source_count, first_seen, last_seen, is_drop, project_key)
           VALUES (?1, ?2, NULL, NULL, '[]', '["testnet"]', 'Unrelated testnet', 'rule', 'ok', '[]', 0.5, 1, ?3, ?3, 1, ?4)`,
        )
        .bind(`filler_nonbase_${i}`, `FillerNonBase${i}`, ts, `fillernonbase${i}`)
        .run();
    }

    // Domainless, tickerless posts have project base IDs != tick:$..., so only full
    // ASCII+Unicode project_key normalization can locate each non-base cluster.
    const alphaFollow = await ingestPostIntoCluster(
      db,
      {
        postId: 'telegram:ch1:ab_follow',
        sourceId: 'telegram:ch1',
        sourceTrust: 0.8,
        postUrl: 'https://t.me/ch1/ab_follow',
        postedAt: now,
        text: 'AlphaBeta testnet campaign live now',
      },
      { knownDomains: new Map() },
      surfIndex,
      new Map(),
      new Set(),
      now,
    );
    expect(alphaFollow.clusterId).toBe(legacyTickerClusterId);

    const istFollow = await ingestPostIntoCluster(
      db,
      {
        postId: 'telegram:ch1:ist_follow',
        sourceId: 'telegram:ch1',
        sourceTrust: 0.8,
        postUrl: 'https://t.me/ch1/ist_follow',
        postedAt: now,
        text: 'Istanbul testnet campaign live now',
      },
      { knownDomains: new Map() },
      surfIndex,
      new Map(),
      new Set(),
      now,
    );
    expect(istFollow.clusterId).toBe(istanbulLegacyId);

    const klvFollow = await ingestPostIntoCluster(
      db,
      {
        postId: 'telegram:ch1:klv_follow',
        sourceId: 'telegram:ch1',
        sourceTrust: 0.8,
        postUrl: 'https://t.me/ch1/klv_follow',
        postedAt: now,
        text: 'Kelvin testnet campaign live now',
      },
      { knownDomains: new Map() },
      surfIndex,
      new Map(),
      new Set(),
      now,
    );
    expect(klvFollow.clusterId).toBe(kelvinLegacyId);

    const plusFollow = await ingestPostIntoCluster(
      db,
      {
        postId: 'telegram:ch1:pp_follow',
        sourceId: 'telegram:ch1',
        sourceTrust: 0.8,
        postUrl: 'https://t.me/ch1/pp_follow',
        postedAt: now,
        text: 'PlusProto airdrop quest live now',
      },
      { knownDomains: new Map() },
      surfIndex,
      new Map(),
      new Set(),
      now,
    );
    expect(plusFollow.clusterId).toBe(nullKeyClusterId);

    const istNetFollow = await ingestPostIntoCluster(
      db,
      {
        postId: 'telegram:ch1:istnet_follow',
        sourceId: 'telegram:ch1',
        sourceTrust: 0.8,
        postUrl: 'https://t.me/ch1/istnet_follow',
        postedAt: now,
        text: 'IstanbulNet airdrop quest live now',
      },
      { knownDomains: new Map() },
      surfIndex,
      new Map(),
      new Set(),
      now,
    );
    expect(istNetFollow.clusterId).toBe(nullIstanbulClusterId);

    const klvNetFollow = await ingestPostIntoCluster(
      db,
      {
        postId: 'telegram:ch1:klvnet_follow',
        sourceId: 'telegram:ch1',
        sourceTrust: 0.8,
        postUrl: 'https://t.me/ch1/klvnet_follow',
        postedAt: now,
        text: 'KelvinNet airdrop quest live now',
      },
      { knownDomains: new Map() },
      surfIndex,
      new Map(),
      new Set(),
      now,
    );
    expect(klvNetFollow.clusterId).toBe(nullKelvinClusterId);
  });

  test('concurrent fallback ingests reserve targets atomically for both project and ticker clusters (in-process & cross-isolate)', async () => {
    const { db, sqlite } = createTestD1();
    const now = 1_795_364_909_000;
    await db
      .prepare(
        `INSERT INTO sources (id, platform, handle, lang, trust, enabled)
         VALUES ('telegram:ch1', 'telegram', 'ch1', 'en', 0.8, 1),
                ('x:ch2', 'x', 'ch2', 'en', 0.8, 1),
                ('telegram:ch3', 'telegram', 'ch3', 'en', 0.8, 1)`,
      )
      .run();
    const surfIndex = { byDomain: new Map(), byTicker: new Map() };

    // A. Concurrent project fallback posts 8 days apart -> MUST stay separate.
    const [projA, projB] = await Promise.all([
      ingestPostIntoCluster(
        db,
        {
          postId: 'telegram:ch1:conc_p1',
          sourceId: 'telegram:ch1',
          sourceTrust: 0.8,
          postUrl: 'https://t.me/ch1/conc_p1',
          postedAt: now - 8 * 86_400_000,
          text: 'ParallelProto testnet quest live now',
        },
        { knownDomains: new Map() },
        surfIndex,
        new Map(),
        new Set(),
        now,
      ),
      ingestPostIntoCluster(
        db,
        {
          postId: 'x:ch2:conc_p2',
          sourceId: 'x:ch2',
          sourceTrust: 0.8,
          postUrl: 'https://x.com/ch2/status/conc_p2',
          postedAt: now,
          text: 'ParallelProto Season 2 airdrop claim open',
        },
        { knownDomains: new Map() },
        surfIndex,
        new Map(),
        new Set(),
        now,
      ),
    ]);
    expect(projA.clusterId).not.toBe(projB.clusterId);

    // B. Concurrent ticker fallback posts 8 days apart -> MUST stay separate; 2h apart -> MUST merge.
    const [tickOld, tickNew] = await Promise.all([
      ingestPostIntoCluster(
        db,
        {
          postId: 'telegram:ch1:conc_t1',
          sourceId: 'telegram:ch1',
          sourceTrust: 0.8,
          postUrl: 'https://t.me/ch1/conc_t1',
          postedAt: now - 8 * 86_400_000,
          text: 'TickerSplit $TKSP testnet live',
        },
        { knownDomains: new Map() },
        surfIndex,
        new Map(),
        new Set(),
        now,
      ),
      ingestPostIntoCluster(
        db,
        {
          postId: 'x:ch2:conc_t2',
          sourceId: 'x:ch2',
          sourceTrust: 0.8,
          postUrl: 'https://x.com/ch2/status/conc_t2',
          postedAt: now,
          text: 'TickerSplit $TKSP claim live',
        },
        { knownDomains: new Map() },
        surfIndex,
        new Map(),
        new Set(),
        now,
      ),
    ]);
    expect(tickOld.clusterId).not.toBe(tickNew.clusterId);

    const [tickCloseA, tickCloseB] = await Promise.all([
      ingestPostIntoCluster(
        db,
        {
          postId: 'telegram:ch1:conc_m1',
          sourceId: 'telegram:ch1',
          sourceTrust: 0.8,
          postUrl: 'https://t.me/ch1/conc_m1',
          postedAt: now - 7_200_000,
          text: 'MergeTicker $MRGT testnet quest live',
        },
        { knownDomains: new Map() },
        surfIndex,
        new Map(),
        new Set(),
        now,
      ),
      ingestPostIntoCluster(
        db,
        {
          postId: 'x:ch2:conc_m2',
          sourceId: 'x:ch2',
          sourceTrust: 0.8,
          postUrl: 'https://x.com/ch2/status/conc_m2',
          postedAt: now,
          text: 'MergeTicker $MRGT faucet claim open',
        },
        { knownDomains: new Map() },
        surfIndex,
        new Map(),
        new Set(),
        now,
      ),
    ]);
    expect(tickCloseA.clusterId).toBe(tickCloseB.clusterId);
    const mergedRow = await db
      .prepare('SELECT source_count FROM clusters WHERE id = ?1')
      .bind(tickCloseA.clusterId)
      .first<{ source_count: number }>();
    expect(mergedRow?.source_count).toBe(2);

    // C. Cross-isolate simulation: two separate D1Database handles race past resolveClusterId before either writes.
    let barrierHits = 0;
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>(resolve => {
      releaseBarrier = resolve;
    });
    const wrapIsolateDb = (delayWrite: boolean): D1Database =>
      ({
        ...db,
        prepare(sql: string) {
          const stmt = db.prepare(sql);
          if (/SELECT id, project.*FROM clusters WHERE id = \?1/i.test(sql)) {
            return {
              bind(...args: unknown[]) {
                const bound = stmt.bind(...args);
                return {
                  ...bound,
                  async first<T>() {
                    const row = await bound.first<T>();
                    if (!row) {
                      barrierHits += 1;
                      if (barrierHits === 2) {
                        releaseBarrier();
                      } else if (barrierHits < 2) {
                        await barrier;
                      }
                    }
                    return row;
                  },
                };
              },
            };
          }
          if (delayWrite && /^\s*INSERT INTO clusters/i.test(sql)) {
            return {
              bind(...args: unknown[]) {
                const bound = stmt.bind(...args);
                return {
                  ...bound,
                  async run() {
                    await new Promise(r => setTimeout(r, 10));
                    return bound.run();
                  },
                };
              },
            };
          }
          return stmt;
        },
      }) as unknown as D1Database;

    const dbIso1 = wrapIsolateDb(false);
    const dbIso2 = wrapIsolateDb(true);
    const [isoFar1, isoFar2] = await Promise.all([
      ingestPostIntoCluster(
        dbIso1,
        {
          postId: 'telegram:ch1:iso_1',
          sourceId: 'telegram:ch1',
          sourceTrust: 0.8,
          postUrl: 'https://t.me/ch1/iso_1',
          postedAt: now - 8 * 86_400_000,
          text: 'CrossIsoProto testnet campaign live',
        },
        { knownDomains: new Map() },
        surfIndex,
        new Map(),
        new Set(),
        now,
      ),
      ingestPostIntoCluster(
        dbIso2,
        {
          postId: 'x:ch2:iso_2',
          sourceId: 'x:ch2',
          sourceTrust: 0.8,
          postUrl: 'https://x.com/ch2/status/iso_2',
          postedAt: now,
          text: 'CrossIsoProto Season 2 claim live',
        },
        { knownDomains: new Map() },
        surfIndex,
        new Map(),
        new Set(),
        now,
      ),
    ]);
    expect(isoFar1.clusterId).not.toBe(isoFar2.clusterId);
    const isoCount = sqlite
      .query(`SELECT COUNT(*) AS n FROM clusters WHERE project = 'CrossIsoProto'`)
      .get() as { n: number };
    expect(isoCount.n).toBe(2);
  });

  test('enforces window checks on the UPDATE path and coordinates concurrent new-window creation across isolates (project & ticker)', async () => {
    const { db, sqlite } = createTestD1();
    const now = 1_795_364_909_000;
    await db
      .prepare(
        `INSERT INTO sources (id, platform, handle, lang, trust, enabled)
         VALUES ('telegram:ch1', 'telegram', 'ch1', 'en', 0.8, 1),
                ('x:ch2', 'x', 'ch2', 'en', 0.8, 1),
                ('telegram:ch3', 'telegram', 'ch3', 'en', 0.8, 1)`,
      )
      .run();
    const surfIndex = { byDomain: new Map(), byTicker: new Map() };

    const scenarios = [
      {
        kind: 'project' as const,
        project: 'UpdateRaceProj',
        oldProject: 'UpdateRaceProj',
        text1: 'UpdateRaceProj testnet campaign live',
        text2: 'UpdateRaceProj Season 2 airdrop claim open',
        s2Project: 'WinRaceProj',
        s2OldText: 'WinRaceProj v1 testnet live',
        s2TextA: 'WinRaceProj Season 2 testnet live',
        s2TextB: 'WinRaceProj Season 2 claim open',
        windowMs: 3 * 86_400_000,
      },
      {
        kind: 'ticker' as const,
        project: 'UpdateRaceTick',
        oldProject: 'UpdateRaceTick',
        text1: 'UpdateRaceTick $URTK testnet campaign live',
        text2: 'UpdateRaceTick $URTK Season 2 claim open',
        s2Project: 'WinRaceTick',
        s2OldText: 'WinRaceTick $WRTK v1 testnet live',
        s2TextA: 'WinRaceTick $WRTK Season 2 testnet live',
        s2TextB: 'WinRaceTick $WRTK Season 2 claim open',
        windowMs: 7 * 86_400_000,
      },
    ];

    for (const s of scenarios) {
      // Schedule 1A: Isolate B selects empty base ID, then Isolate A inserts out-of-window base row
      // BEFORE Isolate B reads `existing`, forcing Isolate B into the `if (existing)` UPDATE path.
      const baseId = await computeClusterId(
        undefined,
        s.kind === 'ticker' ? (s.project === 'UpdateRaceTick' ? 'URTK' : undefined) : undefined,
        s.project,
        `s1a_${s.kind}`,
        now,
      );
      let injectedOld = false;
      const updateRaceDb = {
        ...db,
        prepare(sql: string) {
          const stmt = db.prepare(sql);
          if (/SELECT id, project, ticker, domain, chains.*FROM clusters WHERE id = \?1/is.test(sql)) {
            return {
              bind(...args: unknown[]) {
                const bound = stmt.bind(...args);
                return {
                  ...bound,
                  async first<T>() {
                    if (!injectedOld && args[0] === baseId) {
                      injectedOld = true;
                      const oldTs = now - s.windowMs - 86_400_000;
                      await db
                        .prepare(
                          `INSERT INTO clusters (id, project, ticker, domain, chains, task_types, summary, summary_source, risk_level, risk_reasons, score, source_count, first_seen, last_seen, is_drop)
                           VALUES (?1, ?2, ?3, NULL, '[]', '["testnet"]', 'Old season', 'rule', 'ok', '[]', 0.5, 1, ?4, ?4, 1)`,
                        )
                        .bind(baseId, s.project, s.kind === 'ticker' ? 'URTK' : null, oldTs)
                        .run();
                    }
                    return bound.first<T>();
                  },
                };
              },
            };
          }
          return stmt;
        },
      } as unknown as D1Database;

      const s1aRes = await ingestPostIntoCluster(
        updateRaceDb,
        {
          postId: `telegram:ch1:s1a_${s.kind}`,
          sourceId: 'telegram:ch1',
          sourceTrust: 0.8,
          postUrl: `https://t.me/ch1/s1a_${s.kind}`,
          postedAt: now,
          text: s.text2,
        },
        { knownDomains: new Map() },
        surfIndex,
        new Map(),
        new Set(),
        now,
      );
      expect(injectedOld).toBe(true);
      expect(s1aRes.clusterId).not.toBe(baseId);
      const oldBaseRow = await db
        .prepare('SELECT source_count FROM clusters WHERE id = ?1')
        .bind(baseId)
        .first<{ source_count: number }>();
      expect(oldBaseRow?.source_count).toBe(1);

      // Schedule 1B: Isolate B reads in-window `existing`, then another isolate shifts `last_seen`
      // out-of-window right before `UPDATE clusters` executes; SQL WHERE guard rejects & retries cleanly.
      const s1bProj = `${s.project}Moved`;
      const s1bOldRes = await ingestPostIntoCluster(
        db,
        {
          postId: `telegram:ch1:s1b_old_${s.kind}`,
          sourceId: 'telegram:ch1',
          sourceTrust: 0.8,
          postUrl: `https://t.me/ch1/s1b_old_${s.kind}`,
          postedAt: now - 3_600_000,
          text:
            s.kind === 'ticker'
              ? `${s1bProj} $M${s.kind[0].toUpperCase()}1B testnet live`
              : `${s1bProj} testnet live`,
        },
        { knownDomains: new Map() },
        surfIndex,
        new Map(),
        new Set(),
        now - 3_600_000,
      );
      let shiftedBeforeUpdate = false;
      const movedWindowDb = {
        ...db,
        prepare(sql: string) {
          const stmt = db.prepare(sql);
          if (/^\s*UPDATE\s+clusters/i.test(sql)) {
            return {
              bind(...args: unknown[]) {
                const bound = stmt.bind(...args);
                return {
                  ...bound,
                  async run() {
                    if (!shiftedBeforeUpdate && args[0] === s1bOldRes.clusterId) {
                      shiftedBeforeUpdate = true;
                      const outTs = now - s.windowMs - 86_400_000;
                      await db
                        .prepare('UPDATE clusters SET first_seen = ?2, last_seen = ?2 WHERE id = ?1')
                        .bind(s1bOldRes.clusterId, outTs)
                        .run();
                    }
                    return bound.run();
                  },
                };
              },
            };
          }
          return stmt;
        },
      } as unknown as D1Database;

      const s1bNewRes = await ingestPostIntoCluster(
        movedWindowDb,
        {
          postId: `x:ch2:s1b_new_${s.kind}`,
          sourceId: 'x:ch2',
          sourceTrust: 0.8,
          postUrl: `https://x.com/ch2/status/s1b_new_${s.kind}`,
          postedAt: now,
          text:
            s.kind === 'ticker'
              ? `${s1bProj} $M${s.kind[0].toUpperCase()}1B airdrop claim open`
              : `${s1bProj} airdrop claim open`,
        },
        { knownDomains: new Map() },
        surfIndex,
        new Map(),
        new Set(),
        now,
      );
      expect(shiftedBeforeUpdate).toBe(true);
      expect(s1bNewRes.clusterId).not.toBe(s1bOldRes.clusterId);
      const untouchedRow = await db
        .prepare('SELECT source_count FROM clusters WHERE id = ?1')
        .bind(s1bOldRes.clusterId)
        .first<{ source_count: number }>();
      expect(untouchedRow?.source_count).toBe(1);

      // Schedule 2: Occupied old base cluster exists; two nearby isolates concurrently finish
      // querying `clusters` before either creates the new window, and both MUST converge onto
      // the SAME newly created windowed cluster ID.
      const oldBase = await ingestPostIntoCluster(
        db,
        {
          postId: `telegram:ch1:s2_old_${s.kind}`,
          sourceId: 'telegram:ch1',
          sourceTrust: 0.8,
          postUrl: `https://t.me/ch1/s2_old_${s.kind}`,
          postedAt: now - s.windowMs - 2 * 86_400_000,
          text: s.s2OldText,
        },
        { knownDomains: new Map() },
        surfIndex,
        new Map(),
        new Set(),
        now,
      );

      let resolveBarrierHits = 0;
      let releaseResolveBarrier!: () => void;
      const resolveBarrier = new Promise<void>(resolve => {
        releaseResolveBarrier = resolve;
      });
      const makeResolveRacingDb = (): D1Database =>
        ({
          ...db,
          prepare(sql: string) {
            const stmt = db.prepare(sql);
            if (/SELECT id, project, first_seen, last_seen FROM clusters WHERE id = \?1/i.test(sql) ||
                /SELECT id, project, ticker, first_seen, last_seen FROM clusters WHERE id = \?1/i.test(sql)) {
              return {
                bind(...args: unknown[]) {
                  const bound = stmt.bind(...args);
                  return {
                    ...bound,
                    async first<T>() {
                      const row = await bound.first<T>();
                      if (args[0] === oldBase.clusterId) {
                        resolveBarrierHits += 1;
                        if (resolveBarrierHits === 2) {
                          releaseResolveBarrier();
                        } else if (resolveBarrierHits < 2) {
                          await resolveBarrier;
                        }
                      }
                      return row;
                    },
                  };
                },
              };
            }
            return stmt;
          },
        }) as unknown as D1Database;

      const [winA, winB] = await Promise.all([
        ingestPostIntoCluster(
          makeResolveRacingDb(),
          {
            postId: `telegram:ch1:s2_a_${s.kind}`,
            sourceId: 'telegram:ch1',
            sourceTrust: 0.8,
            postUrl: `https://t.me/ch1/s2_a_${s.kind}`,
            postedAt: now - 7_200_000,
            text: s.s2TextA,
          },
          { knownDomains: new Map() },
          surfIndex,
          new Map(),
          new Set(),
          now,
        ),
        ingestPostIntoCluster(
          makeResolveRacingDb(),
          {
            postId: `x:ch2:s2_b_${s.kind}`,
            sourceId: 'x:ch2',
            sourceTrust: 0.8,
            postUrl: `https://x.com/ch2/status/s2_b_${s.kind}`,
            postedAt: now,
            text: s.s2TextB,
          },
          { knownDomains: new Map() },
          surfIndex,
          new Map(),
          new Set(),
          now,
        ),
      ]);
      expect(resolveBarrierHits).toBeGreaterThanOrEqual(2);
      expect(winA.clusterId).toBe(winB.clusterId);
      expect(winA.clusterId).not.toBe(oldBase.clusterId);
      const s2Count = sqlite
        .query(`SELECT COUNT(*) AS n FROM clusters WHERE project = ?1`)
        .get(s.s2Project) as { n: number };
      expect(s2Count.n).toBe(2);
      const mergedNewRow = await db
        .prepare('SELECT source_count FROM clusters WHERE id = ?1')
        .bind(winA.clusterId)
        .first<{ source_count: number }>();
      expect(mergedNewRow?.source_count).toBe(2);

      // Schedule 3: Occupied old base exists; A (nearby), B (nearby), C (distant) all see
      // no matching new cluster; A reserves -> C reserves distant window BEFORE A writes ->
      // B reserves BEFORE A writes. A and B MUST converge and C MUST get its own cluster.
      const s3Proj = `ThreeWay${s.kind === 'ticker' ? 'Tick' : 'Proj'}`;
      const s3Ticker = s.kind === 'ticker' ? 'THWT' : undefined;
      const s3OldText = s3Ticker ? `${s3Proj} $${s3Ticker} v1 testnet live` : `${s3Proj} v1 testnet live`;
      const s3AText = s3Ticker ? `${s3Proj} $${s3Ticker} Season 2 testnet live` : `${s3Proj} Season 2 testnet live`;
      const s3BText = s3Ticker ? `${s3Proj} $${s3Ticker} Season 2 claim open` : `${s3Proj} Season 2 claim open`;
      const s3CText = s3Ticker ? `${s3Proj} $${s3Ticker} Season 3 waitlist open` : `${s3Proj} Season 3 waitlist open`;

      const s3OldBase = await ingestPostIntoCluster(
        db,
        {
          postId: `telegram:ch1:s3_old_${s.kind}`,
          sourceId: 'telegram:ch1',
          sourceTrust: 0.8,
          postUrl: `https://t.me/ch1/s3_old_${s.kind}`,
          postedAt: now - s.windowMs - 2 * 86_400_000,
          text: s3OldText,
        },
        { knownDomains: new Map() },
        surfIndex,
        new Map(),
        new Set(),
        now,
      );

      let s3Checked = 0;
      let releaseAllChecked!: () => void;
      const allThreeChecked = new Promise<void>(resolve => {
        releaseAllChecked = resolve;
      });
      let releaseAReserved!: () => void;
      const aReserved = new Promise<void>(resolve => {
        releaseAReserved = resolve;
      });
      let releaseCReserved!: () => void;
      const cReserved = new Promise<void>(resolve => {
        releaseCReserved = resolve;
      });
      let releaseBReserved!: () => void;
      const bReserved = new Promise<void>(resolve => {
        releaseBReserved = resolve;
      });

      const makeThreeWayDb = (role: 'A' | 'B' | 'C'): D1Database => {
        let checkedOnce = false;
        let reservedGateDone = false;
        let clusterInsertHeld = false;
        return {
          ...db,
          prepare(sql: string) {
            const stmt = db.prepare(sql);
            if (
              /SELECT id, project, first_seen, last_seen FROM clusters WHERE id = \?1/i.test(sql) ||
              /SELECT id, project, ticker, first_seen, last_seen FROM clusters WHERE id = \?1/i.test(sql)
            ) {
              return {
                bind(...args: unknown[]) {
                  const bound = stmt.bind(...args);
                  return {
                    ...bound,
                    async first<T>() {
                      const row = await bound.first<T>();
                      if (!checkedOnce && args[0] === s3OldBase.clusterId) {
                        checkedOnce = true;
                        s3Checked += 1;
                        if (s3Checked === 3) {
                          releaseAllChecked();
                        } else if (s3Checked < 3) {
                          await allThreeChecked;
                        }
                      }
                      return row;
                    },
                  };
                },
              };
            }
            if (/INSERT(?:\s+OR\s+IGNORE)?\s+INTO\s+fallback_windows/i.test(sql)) {
              return {
                bind(...args: unknown[]) {
                  const bound = stmt.bind(...args);
                  const execInsert = async <T>(call: () => Promise<T>) => {
                    if (!reservedGateDone) {
                      reservedGateDone = true;
                      if (role === 'C') await aReserved;
                      if (role === 'B') await cReserved;
                      const res = await call();
                      if (role === 'A') releaseAReserved();
                      if (role === 'C') releaseCReserved();
                      return res;
                    }
                    return call();
                  };
                  return {
                    ...bound,
                    first: <T>() => execInsert(() => bound.first<T>()),
                    run: () => execInsert(() => bound.run()),
                  };
                },
              };
            }
            if (role === 'B' && /UPDATE\s+fallback_windows/i.test(sql)) {
              return {
                bind(...args: unknown[]) {
                  const bound = stmt.bind(...args);
                  return {
                    ...bound,
                    async first<T>() {
                      const res = await bound.first<T>();
                      releaseBReserved();
                      return res;
                    },
                  };
                },
              };
            }
            if (/^\s*INSERT INTO clusters/i.test(sql)) {
              return {
                bind(...args: unknown[]) {
                  const bound = stmt.bind(...args);
                  return {
                    ...bound,
                    async run() {
                      if (!clusterInsertHeld) {
                        clusterInsertHeld = true;
                        await bReserved;
                      }
                      return bound.run();
                    },
                  };
                },
              };
            }
            return stmt;
          },
        } as unknown as D1Database;
      };

      const [resA, resB, resC] = await Promise.all([
        ingestPostIntoCluster(
          makeThreeWayDb('A'),
          {
            postId: `telegram:ch1:s3_a_${s.kind}`,
            sourceId: 'telegram:ch1',
            sourceTrust: 0.8,
            postUrl: `https://t.me/ch1/s3_a_${s.kind}`,
            postedAt: now - 7_200_000,
            text: s3AText,
          },
          { knownDomains: new Map() },
          surfIndex,
          new Map(),
          new Set(),
          now,
        ),
        ingestPostIntoCluster(
          makeThreeWayDb('B'),
          {
            postId: `x:ch2:s3_b_${s.kind}`,
            sourceId: 'x:ch2',
            sourceTrust: 0.8,
            postUrl: `https://x.com/ch2/status/s3_b_${s.kind}`,
            postedAt: now,
            text: s3BText,
          },
          { knownDomains: new Map() },
          surfIndex,
          new Map(),
          new Set(),
          now,
        ),
        ingestPostIntoCluster(
          makeThreeWayDb('C'),
          {
            postId: `telegram:ch1:s3_c_${s.kind}`,
            sourceId: 'telegram:ch1',
            sourceTrust: 0.8,
            postUrl: `https://t.me/ch1/s3_c_${s.kind}`,
            postedAt: now + s.windowMs + 2 * 86_400_000,
            text: s3CText,
          },
          { knownDomains: new Map() },
          surfIndex,
          new Map(),
          new Set(),
          now,
        ),
      ]);

      expect(s3Checked).toBeGreaterThanOrEqual(3);
      expect(resA.clusterId).toBe(resB.clusterId);
      expect(resA.clusterId).not.toBe(s3OldBase.clusterId);
      expect(resC.clusterId).not.toBe(resA.clusterId);
      expect(resC.clusterId).not.toBe(s3OldBase.clusterId);
      const s3Count = sqlite
        .query(`SELECT COUNT(*) AS n FROM clusters WHERE project = ?1`)
        .get(s3Proj) as { n: number };
      expect(s3Count.n).toBe(3);
      const abRow = await db
        .prepare('SELECT source_count FROM clusters WHERE id = ?1')
        .bind(resA.clusterId)
        .first<{ source_count: number }>();
      expect(abRow?.source_count).toBe(2);
      const cRow = await db
        .prepare('SELECT source_count FROM clusters WHERE id = ?1')
        .bind(resC.clusterId)
        .first<{ source_count: number }>();
      expect(cRow?.source_count).toBe(1);

      // Schedule 4: Posts A (day 0), B (mid-window bridging), and C (past direct window from A)
      // reserve in A -> B -> C order, then C writes `clusters` first while A and B wait.
      // A (reading C's cluster) MUST still merge into C's cluster via fallback_windows bridge,
      // and A, B, C MUST all land on the same cluster.
      const s4Proj = `BridgeWrite${s.kind === 'ticker' ? 'Tick' : 'Proj'}`;
      const s4Ticker = s.kind === 'ticker' ? 'BRWT' : undefined;
      const midOffset = s.kind === 'ticker' ? 5 * 86_400_000 : 2 * 86_400_000;
      const farOffset = 2 * midOffset;
      const tA = now;
      const tB = now + midOffset;
      const tC = now + farOffset;
      const s4AText = s4Ticker ? `${s4Proj} $${s4Ticker} Phase 1 testnet live` : `${s4Proj} Phase 1 testnet live`;
      const s4BText = s4Ticker ? `${s4Proj} $${s4Ticker} Phase 2 claim live` : `${s4Proj} Phase 2 claim live`;
      const s4CText = s4Ticker ? `${s4Proj} $${s4Ticker} Phase 3 waitlist live` : `${s4Proj} Phase 3 waitlist live`;

      const s4BaseId = await computeClusterId(undefined, s4Ticker, s4Proj, 's4_probe', tA);
      let s4Checked = 0;
      let releaseS4AllChecked!: () => void;
      const s4AllChecked = new Promise<void>(resolve => {
        releaseS4AllChecked = resolve;
      });
      let releaseS4AReserved!: () => void;
      const s4AReserved = new Promise<void>(resolve => {
        releaseS4AReserved = resolve;
      });
      let releaseS4BReserved!: () => void;
      const s4BReserved = new Promise<void>(resolve => {
        releaseS4BReserved = resolve;
      });
      let releaseS4CWrote!: () => void;
      const s4CWrote = new Promise<void>(resolve => {
        releaseS4CWrote = resolve;
      });
      let releaseS4ADone!: () => void;
      const s4ADone = new Promise<void>(resolve => {
        releaseS4ADone = resolve;
      });

      const makeBridgeWriteDb = (role: 'A' | 'B' | 'C'): D1Database => {
        let checkedOnce = false;
        let reservedGateDone = false;
        let existingGateDone = false;
        let wroteGateDone = false;
        return {
          ...db,
          prepare(sql: string) {
            const stmt = db.prepare(sql);
            if (
              /SELECT id, project, first_seen, last_seen FROM clusters WHERE id = \?1/i.test(sql) ||
              /SELECT id, project, ticker, first_seen, last_seen FROM clusters WHERE id = \?1/i.test(sql)
            ) {
              return {
                bind(...args: unknown[]) {
                  const bound = stmt.bind(...args);
                  return {
                    ...bound,
                    async first<T>() {
                      const row = await bound.first<T>();
                      if (!checkedOnce && args[0] === s4BaseId) {
                        checkedOnce = true;
                        s4Checked += 1;
                        if (s4Checked === 3) {
                          releaseS4AllChecked();
                        } else if (s4Checked < 3) {
                          await s4AllChecked;
                        }
                      }
                      return row;
                    },
                  };
                },
              };
            }
            if (/INSERT(?:\s+OR\s+IGNORE)?\s+INTO\s+fallback_windows/i.test(sql)) {
              return {
                bind(...args: unknown[]) {
                  const bound = stmt.bind(...args);
                  return {
                    ...bound,
                    async first<T>() {
                      if (!reservedGateDone) {
                        reservedGateDone = true;
                        if (role === 'B') await s4AReserved;
                        if (role === 'C') await s4BReserved;
                        const row = await bound.first<T>();
                        if (role === 'A') releaseS4AReserved();
                        return row;
                      }
                      return bound.first<T>();
                    },
                  };
                },
              };
            }
            if ((role === 'B' || role === 'C') && /UPDATE\s+fallback_windows/i.test(sql)) {
              return {
                bind(...args: unknown[]) {
                  const bound = stmt.bind(...args);
                  return {
                    ...bound,
                    async first<T>() {
                      const row = await bound.first<T>();
                      if (role === 'B') releaseS4BReserved();
                      return row;
                    },
                  };
                },
              };
            }
            if ((role === 'A' || role === 'B') && /SELECT id, project, ticker, domain, chains.*FROM clusters WHERE id = \?1/is.test(sql)) {
              return {
                bind(...args: unknown[]) {
                  const bound = stmt.bind(...args);
                  return {
                    ...bound,
                    async first<T>() {
                      if (!existingGateDone) {
                        existingGateDone = true;
                        if (role === 'A') await s4CWrote;
                        if (role === 'B') await s4ADone;
                      }
                      return bound.first<T>();
                    },
                  };
                },
              };
            }
            if (role === 'C' && /^\s*INSERT INTO clusters/i.test(sql)) {
              return {
                bind(...args: unknown[]) {
                  const bound = stmt.bind(...args);
                  return {
                    ...bound,
                    async run() {
                      const out = await bound.run();
                      if (!wroteGateDone) {
                        wroteGateDone = true;
                        releaseS4CWrote();
                      }
                      return out;
                    },
                  };
                },
              };
            }
            if (role === 'A' && /^\s*UPDATE\s+clusters/i.test(sql)) {
              return {
                bind(...args: unknown[]) {
                  const bound = stmt.bind(...args);
                  return {
                    ...bound,
                    async run() {
                      const out = await bound.run();
                      if (!wroteGateDone) {
                        wroteGateDone = true;
                        releaseS4ADone();
                      }
                      return out;
                    },
                  };
                },
              };
            }
            return stmt;
          },
        } as unknown as D1Database;
      };

      const [s4ResA, s4ResB, s4ResC] = await Promise.all([
        ingestPostIntoCluster(
          makeBridgeWriteDb('A'),
          {
            postId: `telegram:ch1:s4_a_${s.kind}`,
            sourceId: 'telegram:ch1',
            sourceTrust: 0.8,
            postUrl: `https://t.me/ch1/s4_a_${s.kind}`,
            postedAt: tA,
            text: s4AText,
          },
          { knownDomains: new Map() },
          surfIndex,
          new Map(),
          new Set(),
          tC,
        ),
        ingestPostIntoCluster(
          makeBridgeWriteDb('B'),
          {
            postId: `x:ch2:s4_b_${s.kind}`,
            sourceId: 'x:ch2',
            sourceTrust: 0.8,
            postUrl: `https://x.com/ch2/status/s4_b_${s.kind}`,
            postedAt: tB,
            text: s4BText,
          },
          { knownDomains: new Map() },
          surfIndex,
          new Map(),
          new Set(),
          tC,
        ),
        ingestPostIntoCluster(
          makeBridgeWriteDb('C'),
          {
            postId: `telegram:ch3:s4_c_${s.kind}`,
            sourceId: 'telegram:ch3',
            sourceTrust: 0.8,
            postUrl: `https://t.me/ch3/s4_c_${s.kind}`,
            postedAt: tC,
            text: s4CText,
          },
          { knownDomains: new Map() },
          surfIndex,
          new Map(),
          new Set(),
          tC,
        ),
      ]);

      expect(s4ResC.clusterId).toBe(s4BaseId);
      expect(s4ResA.clusterId).toBe(s4BaseId);
      expect(s4ResB.clusterId).toBe(s4BaseId);
      const s4ClusterCount = sqlite
        .query(`SELECT COUNT(*) AS n FROM clusters WHERE project = ?1`)
        .get(s4Proj) as { n: number };
      expect(s4ClusterCount.n).toBe(1);
      const s4Row = await db
        .prepare('SELECT first_seen, last_seen, source_count FROM clusters WHERE id = ?1')
        .bind(s4BaseId)
        .first<{ first_seen: number; last_seen: number; source_count: number }>();
      expect(s4Row).toEqual({ first_seen: tA, last_seen: tC, source_count: 3 });

      // Negative control: without bridging B, A (day 0) and C (farOffset) still remain separate.
      const s4NoBridgeProj = `NoBridge${s.kind === 'ticker' ? 'Tick' : 'Proj'}`;
      const s4NoBridgeTick = s.kind === 'ticker' ? 'NBRT' : undefined;
      const nb1 = await ingestPostIntoCluster(
        db,
        {
          postId: `telegram:ch1:s4_nb1_${s.kind}`,
          sourceId: 'telegram:ch1',
          sourceTrust: 0.8,
          postUrl: `https://t.me/ch1/s4_nb1_${s.kind}`,
          postedAt: tA,
          text: s4NoBridgeTick ? `${s4NoBridgeProj} $${s4NoBridgeTick} testnet live` : `${s4NoBridgeProj} testnet live`,
        },
        { knownDomains: new Map() },
        surfIndex,
        new Map(),
        new Set(),
        tC,
      );
      const nb2 = await ingestPostIntoCluster(
        db,
        {
          postId: `x:ch2:s4_nb2_${s.kind}`,
          sourceId: 'x:ch2',
          sourceTrust: 0.8,
          postUrl: `https://x.com/ch2/status/s4_nb2_${s.kind}`,
          postedAt: tC,
          text: s4NoBridgeTick ? `${s4NoBridgeProj} $${s4NoBridgeTick} claim live` : `${s4NoBridgeProj} claim live`,
        },
        { knownDomains: new Map() },
        surfIndex,
        new Map(),
        new Set(),
        tC,
      );
      expect(nb1.clusterId).not.toBe(nb2.clusterId);
    }
  });

  test('reuses stored posts.cluster_id on retry and completes missing cluster row without touching competing cluster', async () => {
    const { db } = createTestD1();
    const now = 1_795_364_909_000;
    await db
      .prepare(
        `INSERT INTO sources (id, platform, handle, lang, trust, enabled)
         VALUES ('telegram:ch1', 'telegram', 'ch1', 'en', 0.8, 1),
                ('x:ch2', 'x', 'ch2', 'en', 0.8, 1),
                ('telegram:ch3', 'telegram', 'ch3', 'en', 0.8, 1)`,
      )
      .run();
    const surfIndex = { byDomain: new Map(), byTicker: new Map() };

    const originalClusterId = 'retry_unwritten_cluster_id';
    await db
      .prepare(
        `INSERT INTO posts (id, source_id, post_url, posted_at, text, urls, cluster_id, created_at)
         VALUES ('telegram:ch1:retry1', 'telegram:ch1', 'https://t.me/ch1/retry1', ?1, 'ReplayProto testnet airdrop live', '[]', ?2, ?1)`,
      )
      .bind(now - 600_000, originalClusterId)
      .run();

    // Another source creates a nearby cluster while originalClusterId has no cluster row yet.
    const competing = await ingestPostIntoCluster(
      db,
      {
        postId: 'x:ch2:competing1',
        sourceId: 'x:ch2',
        sourceTrust: 0.8,
        postUrl: 'https://x.com/ch2/status/competing1',
        postedAt: now,
        text: 'ReplayProto testnet quest live',
      },
      { knownDomains: new Map() },
      surfIndex,
      new Map(),
      new Set(),
      now,
    );
    expect(competing.clusterId).not.toBe(originalClusterId);

    const retryRes = await ingestPostIntoCluster(
      db,
      {
        postId: 'telegram:ch1:retry1',
        sourceId: 'telegram:ch1',
        sourceTrust: 0.8,
        postUrl: 'https://t.me/ch1/retry1',
        postedAt: now - 600_000,
        text: 'ReplayProto testnet airdrop live',
      },
      { knownDomains: new Map() },
      surfIndex,
      new Map(),
      new Set(),
      now,
    );
    expect(retryRes.clusterId).toBe(originalClusterId);

    const createdRow = await db
      .prepare('SELECT id, source_count FROM clusters WHERE id = ?1')
      .bind(originalClusterId)
      .first<{ id: string; source_count: number }>();
    expect(createdRow?.id).toBe(originalClusterId);
    expect(createdRow?.source_count).toBe(1);

    const competingRow = await db
      .prepare('SELECT source_count FROM clusters WHERE id = ?1')
      .bind(competing.clusterId)
      .first<{ source_count: number }>();
    expect(competingRow?.source_count).toBe(1);
  });

  test('returns continuation cursor when 500 legacy noise rows exhaust scan budget and reaches drops past 500th row', async () => {
    const { db } = createTestD1();
    const now = 1_795_364_909_000;
    await db
      .prepare(`INSERT INTO sources (id, platform, handle, lang, trust, enabled) VALUES ('telegram:ch1', 'telegram', 'ch1', 'en', 0.8, 1)`)
      .run();

    // Seed 500 high-score legacy noise rows (5 full batches of 100).
    for (let i = 0; i < 500; i++) {
      const cid = `scan_noise_${String(i).padStart(3, '0')}`;
      const ts = now - i * 1_000;
      await db
        .prepare(
          `INSERT INTO clusters (id, project, ticker, domain, chains, task_types, summary, summary_source, risk_level, risk_reasons, score, source_count, first_seen, last_seen, is_drop)
           VALUES (?1, 'Noise', NULL, NULL, '[]', '["other"]', 'Bitcoin Drops Below $60,000', 'rule', 'ok', '[]', 0.99, 3, ?2, ?2, NULL)`,
        )
        .bind(cid, ts)
        .run();
      await db
        .prepare(
          `INSERT INTO posts (id, source_id, post_url, posted_at, text, urls, cluster_id, created_at)
           VALUES (?1, 'telegram:ch1', ?2, ?3, 'Bitcoin Drops Below $60,000', '[]', ?4, ?3)`,
        )
        .bind(`p_${cid}`, `https://t.me/ch1/sn_${i}`, ts, cid)
        .run();
    }

    // Seed 5 real drops ranked after the 500th row.
    const expectedIds: string[] = [];
    for (let j = 0; j < 5; j++) {
      const cid = `beyond_budget_${j}`;
      expectedIds.push(cid);
      const ts = now - 900_000 - j * 1_000;
      await db
        .prepare(
          `INSERT INTO clusters (id, project, ticker, domain, chains, task_types, summary, summary_source, risk_level, risk_reasons, score, source_count, first_seen, last_seen, is_drop)
           VALUES (?1, ?2, NULL, ?3, '["Base"]', '["testnet"]', 'Testnet airdrop live on Base', 'rule', 'ok', '[]', 0.45, 1, ?4, ?4, 1)`,
        )
        .bind(cid, `BeyondProto${j}`, `beyond${j}.xyz`, ts)
        .run();
      await db
        .prepare(
          `INSERT INTO posts (id, source_id, post_url, posted_at, text, urls, cluster_id, created_at)
           VALUES (?1, 'telegram:ch1', ?2, ?3, 'Testnet airdrop live on Base', ?4, ?5, ?3)`,
        )
        .bind(`p_${cid}`, `https://t.me/ch1/by_${j}`, ts, JSON.stringify([`https://beyond${j}.xyz/testnet`]), cid)
        .run();
    }

    const page1 = await queryFeed(db, new Set(), { sort: 'score', limit: 20 });
    expect(page1.items).toEqual([]);
    expect(page1.cursor).toBeTruthy();

    const page2 = await queryFeed(db, new Set(), { sort: 'score', limit: 20, cursor: page1.cursor });
    expect(page2.items.map(i => i.id)).toEqual(expectedIds);
    expect(page2.cursor).toBeUndefined();

    const newPage1 = await queryFeed(db, new Set(), { sort: 'new', limit: 20 });
    expect(newPage1.items).toEqual([]);
    expect(newPage1.cursor).toBeTruthy();

    const newPage2 = await queryFeed(db, new Set(), { sort: 'new', limit: 20, cursor: newPage1.cursor });
    expect(newPage2.items.map(i => i.id)).toEqual(expectedIds);
    expect(newPage2.cursor).toBeUndefined();

    // Verify /feed.json?cursor=... worker handler accepts cursor cleanly.
    const g = globalThis as unknown as { caches?: CacheStorage };
    const hadCaches = 'caches' in g;
    const prevCaches = g.caches;
    const store = new Map<string, Response>();
    g.caches = {
      default: {
        async match(req: RequestInfo | URL) {
          const key = typeof req === 'string' ? req : req instanceof URL ? req.toString() : req.url;
          return store.get(key)?.clone();
        },
        async put(req: RequestInfo | URL, res: Response) {
          const key = typeof req === 'string' ? req : req instanceof URL ? req.toString() : req.url;
          store.set(key, res.clone());
        },
      },
    } as unknown as CacheStorage;
    try {
      const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
      const r1 = await worker.fetch(new Request('https://radar.test/feed.json'), { DB: db }, ctx);
      const b1 = (await r1.json()) as { items: unknown[]; cursor?: string };
      expect(b1.items).toEqual([]);
      expect(b1.cursor).toBeTruthy();

      const r2 = await worker.fetch(
        new Request(`https://radar.test/feed.json?cursor=${encodeURIComponent(b1.cursor!)}`),
        { DB: db },
        ctx,
      );
      const b2 = (await r2.json()) as { items: { id: string }[]; cursor?: string };
      expect(b2.items.map(i => i.id)).toEqual(expectedIds);
      expect(b2.cursor).toBeUndefined();
    } finally {
      if (hadCaches) g.caches = prevCaches;
      else delete g.caches;
    }
  });

  test('classifies legacy null-verdict rows using complete post text beyond 1200 chars and beyond 3 posts while trusting persisted is_drop = 1', async () => {
    const { db, queries } = createTestD1();
    const now = 1_795_364_909_000;
    await db
      .prepare(`INSERT INTO sources (id, platform, handle, lang, trust, enabled) VALUES ('telegram:ch1', 'telegram', 'ch1', 'en', 0.8, 1)`)
      .run();

    // 1. Legacy row whose only drop signal ("airdrop") appears after char 1,300 (no actionable URL).
    const longIntro = 'Protocol architecture overview and community update. '.repeat(30); // > 1,500 chars
    await db
      .prepare(
        `INSERT INTO clusters (id, project, ticker, domain, chains, task_types, summary, summary_source, risk_level, risk_reasons, score, source_count, first_seen, last_seen, is_drop)
         VALUES ('legacy_tail_kw', 'LongTailProto', NULL, NULL, '[]', '["other"]', 'LongTailProto: other', 'rule', 'ok', '[]', 0.8, 1, ?1, ?1, NULL)`,
      )
      .bind(now - 1_000)
      .run();
    await db
      .prepare(
        `INSERT INTO posts (id, source_id, post_url, posted_at, text, urls, cluster_id, created_at)
         VALUES ('p_tail', 'telegram:ch1', 'https://t.me/ch1/tail', ?1, ?2, '[]', 'legacy_tail_kw', ?1)`,
      )
      .bind(now - 1_000, `${longIntro} Airdrop claim opens next week.`)
      .run();

    // 2. Legacy row with 4 posts where only the 4th (oldest) post contains the drop keyword.
    await db
      .prepare(
        `INSERT INTO clusters (id, project, ticker, domain, chains, task_types, summary, summary_source, risk_level, risk_reasons, score, source_count, first_seen, last_seen, is_drop)
         VALUES ('legacy_4th_post', 'FourthPostProto', NULL, NULL, '[]', '["other"]', 'FourthPostProto: other', 'rule', 'ok', '[]', 0.75, 1, ?1, ?2, NULL)`,
      )
      .bind(now - 5_000, now - 2_000)
      .run();
    for (let k = 0; k < 4; k++) {
      const isOldestWithSignal = k === 3;
      await db
        .prepare(
          `INSERT INTO posts (id, source_id, post_url, posted_at, text, urls, cluster_id, created_at)
           VALUES (?1, 'telegram:ch1', ?2, ?3, ?4, '[]', 'legacy_4th_post', ?3)`,
        )
        .bind(
          `p_4th_${k}`,
          `https://t.me/ch1/4th_${k}`,
          now - (k + 2) * 1_000,
          isOldestWithSignal ? 'FourthPostProto testnet faucet live now' : 'FourthPostProto community update',
        )
        .run();
    }

    // 3. Persisted is_drop = 1 cluster with no legacy rows should NOT query p.text.
    await db
      .prepare(
        `INSERT INTO clusters (id, project, ticker, domain, chains, task_types, summary, summary_source, risk_level, risk_reasons, score, source_count, first_seen, last_seen, is_drop)
         VALUES ('persisted_only', 'PersistedProto', NULL, 'persisted.xyz', '[]', '["testnet"]', 'PersistedProto: testnet', 'rule', 'ok', '[]', 0.7, 1, ?1, ?1, 1)`,
      )
      .bind(now)
      .run();
    await db
      .prepare(
        `INSERT INTO posts (id, source_id, post_url, posted_at, text, urls, cluster_id, created_at)
         VALUES ('p_persisted', 'telegram:ch1', 'https://t.me/ch1/persisted', ?1, 'Non-drop reminder', '["https://persisted.xyz/"]', 'persisted_only', ?1)`,
      )
      .bind(now)
      .run();

    const feed = await queryFeed(db, new Set(), { risk: 'include' });
    const ids = feed.items.map(i => i.id);
    expect(ids).toContain('legacy_tail_kw');
    expect(ids).toContain('legacy_4th_post');
    expect(ids).toContain('persisted_only');

    // Verify ordinary reads with zero legacy rows do not select p.text.
    await db.prepare(`UPDATE clusters SET is_drop = 1 WHERE is_drop IS NULL`).run();
    const beforeNormal = queries.length;
    await queryFeed(db, new Set(), { risk: 'include' });
    const normalQueries = queries.slice(beforeNormal);
    expect(normalQueries.some(q => /\bp\.text\b/i.test(q))).toBe(false);
  });
});

describe('Surf airdrops external URL normalization', () => {
  test('normalizes scheme-less t.me/DoodlesUP_bot links to https:// and rejects unsafe schemes', () => {
    const feed = normalizeSurf(
      {
        active: [
          {
            project_id: 'doodles',
            project_name: 'Doodles',
            best_task: { title: 'Play bot', type: 'social', external_link: 't.me/DoodlesUP_bot' },
            tasks: [
              { title: 'Play bot', type: 'social', external_link: 't.me/DoodlesUP_bot' },
              { title: 'Bad link', type: 'social', external_link: 'javascript:alert(1)' },
            ],
          },
        ],
        tge: [],
      },
      1_700_000_000_000,
    );
    expect(feed.cards[0].url).toBe('https://t.me/DoodlesUP_bot');
    expect(feed.cards[0].tasks?.[0].url).toBe('https://t.me/DoodlesUP_bot');
    expect(feed.cards[0].tasks?.[1].url).toBeNull();
  });
});
