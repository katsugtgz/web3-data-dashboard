import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
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
  const sqlite = new Database(':memory:');
  for (const file of [
    '../migrations/0001_init.sql',
    '../migrations/0002_feed.sql',
    '../migrations/0003_p4.sql',
    '../migrations/0004_tags.sql',
    '../migrations/0005_drop_verdict.sql',
  ]) {
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
  test('M1: flags crypto doubling / advance-fee scams as risk', () => {
    const res = evaluateSafety({
      urls: ['https://promo-claim.xyz/'],
      text: 'Send 100 USDT to receive 1000 back, airdrop guaranteed',
      knownProjectDomains: new Map(),
      trustMax: 0.8,
      sourceCount: 2,
    });
    expect(res.level).toBe('risk');
    expect(res.reasons).toContain('Crypto doubling / advance-fee scam phrasing');
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
