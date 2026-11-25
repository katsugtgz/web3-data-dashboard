import { describe, expect, test } from 'bun:test';
import { createTestD1, FORBIDDEN_CJK_RE } from './helpers';
import { queryFeed } from '../src/normalize/cluster';
import {
  fetchDropFeedPosts,
  fetchMerklOpportunities,
  fetchPendlePoints,
  fetchWpCalendarAirdrops,
  parseGalxeCampaigns,
  parseMerklOpportunities,
  parsePendlePoints,
  parseRssOrAtomXml,
  parseSubstackArchive,
  parseWpCalendarToAirdropFeed,
  parseWpCalendarToFeedPosts,
  pollFeedBatch,
} from '../src/sources/feeds';
import { parseDropPost } from '../src/normalize/parse';
import { evaluateSafety } from '../src/safety';

const NOW = Date.parse('2026-11-24T12:00:00Z');

describe('feeds parsers (RSS/Atom, WP Calendar, Substack, Galxe, Pendle, Merkl)', () => {
  test('parses RSS 2.0 and Atom XML, rejects undated entries, and strips HTML', () => {
    const rss = `<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0"><channel><title>AirdropTracker</title>
        <item>
          <title><![CDATA[MegaETH Testnet Airdrop Guide]]></title>
          <link>https://www.airdroptracker.io/megaeth-guide?utm_source=rss</link>
          <guid>megaeth-2026-11</guid>
          <pubDate>Fri, 21 Nov 2026 10:00:00 GMT</pubDate>
          <description><![CDATA[<p>Claim faucet at <a href="https://testnet.megaeth.com/faucet?ref=abc">MegaETH</a> now.</p>]]></description>
        </item>
        <item>
          <title>Undated item should drop</title>
          <link>https://www.airdroptracker.io/undated</link>
          <description>No pubDate here</description>
        </item>
      </channel></rss>`;

    const rssPosts = parseRssOrAtomXml(rss);
    expect(rssPosts.length).toBe(1);
    expect(rssPosts[0].id).toBe('megaeth-2026-11');
    expect(rssPosts[0].postUrl).toBe('https://www.airdroptracker.io/megaeth-guide');
    expect(rssPosts[0].urls).toContain('https://testnet.megaeth.com/faucet');
    expect(rssPosts[0].text).toContain('MegaETH Testnet Airdrop Guide');

    const atom = `<?xml version="1.0" encoding="utf-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <id>tag:airdrops.io,2026:101</id>
          <title>Nado Points Season 2</title>
          <link rel="alternate" href="https://airdrops.io/nado/" />
          <updated>2026-11-20T08:00:00Z</updated>
          <summary>Bridge and earn Nado points at https://nado.xyz/points</summary>
        </entry>
      </feed>`;
    const atomPosts = parseRssOrAtomXml(atom);
    expect(atomPosts.length).toBe(1);
    expect(atomPosts[0].postUrl).toBe('https://airdrops.io/nado');
    expect(atomPosts[0].postedAt).toBe(Date.parse('2026-11-20T08:00:00Z'));
  });

  test('parses AirdropAlert WP Calendar into both chronological feed posts and TGE rail items', () => {
    const wpPayload = [
      {
        id: 8821,
        date_gmt: '2026-11-22T14:00:00',
        slug: 'treehouse-s2-claim',
        title: { rendered: 'Treehouse $TREE Season 2 Airdrop Claim' },
        content: { rendered: '<p>Claim live at <a href="https://claim.treehouse.finance/">portal</a>.</p>' },
        link: 'https://airdropalert.com/calendar/treehouse-s2-claim/',
      },
    ];

    const feedPosts = parseWpCalendarToFeedPosts(wpPayload);
    expect(feedPosts.length).toBe(1);
    expect(feedPosts[0].id).toBe('8821');
    expect(feedPosts[0].urls).toContain('https://claim.treehouse.finance/');

    const airdropFeed = parseWpCalendarToAirdropFeed(wpPayload, NOW);
    expect(airdropFeed.cards).toEqual([]);
    expect(airdropFeed.tge.length).toBe(1);
    expect(airdropFeed.tge[0].source).toBe('AirdropAlert');
    expect(airdropFeed.tge[0].s).toBe('Claimable');
    expect(airdropFeed.tge[0].t).toBe('TREE');
    expect(airdropFeed.tge[0].d).toBe('2026-11-22');
  });

  test('parses Substack archive JSON: skips paywalled posts and filters to airdrop/points topics', () => {
    const archive = {
      posts: [
        {
          id: 1001,
          title: 'The Biggest Airdrops of Q4 2026 & Points Watchlist',
          subtitle: 'Top pre-token DeFi protocols to farm on Monad and HyperEVM',
          post_date: '2026-11-19T12:00:00.000Z',
          audience: 'everyone',
          canonical_url: 'https://www.thedefinvestor.com/p/the-biggest-airdrops-2026',
        },
        {
          id: 1002,
          title: 'Secret Airdrop Alpha',
          subtitle: 'Paid subscribers only',
          post_date: '2026-11-20T12:00:00.000Z',
          audience: 'only_paid',
          canonical_url: 'https://www.thedefinvestor.com/p/secret',
        },
        {
          id: 1003,
          title: 'Macro Fed Rate Commentary',
          subtitle: 'Interest rate outlook for next year',
          post_date: '2026-11-21T12:00:00.000Z',
          audience: 'everyone',
          canonical_url: 'https://www.thedefinvestor.com/p/macro-fed',
        },
      ],
    };

    const posts = parseSubstackArchive(archive);
    expect(posts.map(p => p.id)).toEqual(['1001']);
    expect(posts[0].postUrl).toBe('https://www.thedefinvestor.com/p/the-biggest-airdrops-2026');
  });

  test('parses Galxe GraphQL campaigns and strictly filters space.followersCount >= 10000', () => {
    const payload = {
      data: {
        campaigns: {
          list: [
            {
              id: 'GC12345',
              name: 'Monad Testnet Voyage Quest',
              status: 'Active',
              startTime: Math.floor((NOW - 3_600_000) / 1000),
              chain: 'MONAD',
              space: { id: '1', name: 'Monad', alias: 'monad', followersCount: 45000, isVerified: true },
            },
            {
              id: 'GC99999',
              name: 'Spam Giveaway Quest',
              status: 'Active',
              startTime: Math.floor((NOW - 3_600_000) / 1000),
              chain: 'MATIC',
              space: { id: '2', name: 'SpamSpace', alias: 'spamspace', followersCount: 1500, isVerified: true },
            },
          ],
        },
      },
    };

    const posts = parseGalxeCampaigns(payload, NOW);
    expect(posts.map(p => p.id)).toEqual(['GC12345']);
    expect(posts[0].postUrl).toBe('https://app.galxe.com/quest/monad/GC12345');
    expect(posts[0].text).toContain('Monad');
  });

  test('parses Pendle V2 points markets and Merkl v4 live opportunities into clean English cards', () => {
    const pendleRaw = {
      markets: [
        {
          name: 'sUSDe',
          address: '0xabc123',
          protocol: 'Ethena',
          chainId: 1,
          expiry: '2027-03-25T00:00:00.000Z',
          categoryIds: ['points', 'stables'],
          details: { liquidity: 25_000_000, impliedApy: 0.145 },
          isNew: true,
        },
        {
          name: 'PlainPool',
          address: '0xdef456',
          protocol: 'NoPoints',
          chainId: 1,
          expiry: '2027-03-25T00:00:00.000Z',
          categoryIds: ['stables'],
          details: { liquidity: 10_000_000, impliedApy: 0.05 },
          isNew: false,
        },
      ],
    };
    const pendleFeed = parsePendlePoints(pendleRaw, NOW);
    expect(FORBIDDEN_CJK_RE.test(JSON.stringify(pendleFeed))).toBe(false);
    expect(pendleFeed.cards.length).toBe(1);
    expect(pendleFeed.cards[0].n).toBe('Ethena');
    expect(pendleFeed.cards[0].source).toBe('Pendle');
    expect(pendleFeed.cards[0].chain).toBe('Ethereum');
    expect(pendleFeed.cards[0].b).toContain('early');

    const merklRaw = [
      {
        id: 'm1',
        name: 'Supply USDC on Morpho Base',
        chain: { name: 'Base' },
        protocol: { name: 'Morpho', icon: 'https://icons.merkl.xyz/morpho.png' },
        action: 'LEND',
        status: 'LIVE',
        tvl: 18_500_000,
        apr: 12.4,
        dailyRewards: 5000,
        depositUrl: 'https://app.morpho.org/vault?ref=merkl',
      },
      {
        id: 'm2',
        name: 'Tiny pool',
        chain: { name: 'Base' },
        protocol: { name: 'DustProto' },
        action: 'LEND',
        status: 'LIVE',
        tvl: 1_000,
        apr: 5,
        depositUrl: 'https://dust.xyz',
      },
    ];
    const merklFeed = parseMerklOpportunities(merklRaw, NOW);
    expect(FORBIDDEN_CJK_RE.test(JSON.stringify(merklFeed))).toBe(false);
    expect(merklFeed.cards.length).toBe(1);
    expect(merklFeed.cards[0].n).toBe('Morpho');
    expect(merklFeed.cards[0].source).toBe('Merkl');
    expect(merklFeed.cards[0].url).toBe('https://app.morpho.org/vault');
  });
});

describe('pollFeedBatch D1 ingestion, TTL, backoff, and sources_poll index', () => {
  test('uses sources_poll index, ingests feed posts with feed:<handle>:<id>, sets 30m TTL, and backs off on error', async () => {
    const { db, queries, explain } = createTestD1();
    await db
      .prepare(
        `INSERT INTO sources (id, platform, handle, lang, trust, enabled, tags)
         VALUES ('feed:airdroptracker_rss', 'feed', 'airdroptracker_rss', 'en', 0.8, 1, '["airdrop","rss","drops"]'),
                ('feed:airdrops_io_rss', 'feed', 'airdrops_io_rss', 'en', 0.8, 1, '["airdrop","rss","drops"]'),
                ('feed:pendle_points', 'feed', 'pendle_points', 'en', 0.85, 1, '["airdrop","defi","points","curated"]')`,
      )
      .run();

    const beforePoll = queries.length;
    const summary = await pollFeedBatch(db, 3, NOW, null, async src => {
      if (src.handle === 'airdroptracker_rss') {
        return [
          {
            id: 'item-42',
            postUrl: 'https://www.airdroptracker.io/nova-testnet',
            postedAt: NOW - 60_000,
            text: 'NovaChain testnet & faucet airdrop live on Monad https://novachain.xyz/testnet',
            urls: ['https://novachain.xyz/testnet'],
          },
        ];
      }
      throw new Error('upstream 503');
    });

    // Verify query plan of the actual production source-selection SQL executed by pollFeedBatch
    const pollSql = queries
      .slice(beforePoll)
      .find(q => /FROM\s+sources/i.test(q) && /ORDER\s+BY\s+last_polled_at/i.test(q));
    expect(pollSql).toBeDefined();
    const plan = explain(pollSql!, [NOW, 3])
      .map(s => s.detail)
      .join('\n');
    expect(plan).toContain('sources_poll');
    expect(plan).not.toMatch(/TEMP B-TREE/i);

    // pendle_points (curated, not drops) must not be polled here
    expect(summary.polled).toBe(2);
    expect(summary.insertedPosts).toBe(1);
    expect(summary.degraded).toBe(1);

    const post = await db
      .prepare(`SELECT id, source_id FROM posts WHERE id = 'feed:airdroptracker_rss:item-42'`)
      .first<{ id: string; source_id: string }>();
    expect(post).toEqual({ id: 'feed:airdroptracker_rss:item-42', source_id: 'feed:airdroptracker_rss' });

    const okSrc = await db
      .prepare(`SELECT status, last_ok_at, next_poll_at, last_seen_id FROM sources WHERE id = 'feed:airdroptracker_rss'`)
      .first<{ status: string; last_ok_at: number; next_poll_at: number; last_seen_id: string }>();
    expect(okSrc?.status).toBe('ok');
    expect(okSrc?.last_ok_at).toBe(NOW);
    expect(okSrc?.next_poll_at).toBe(NOW + 30 * 60_000);
    expect(okSrc?.last_seen_id).toBe('item-42');

    const failSrc = await db
      .prepare(`SELECT status, fail_count, next_poll_at FROM sources WHERE id = 'feed:airdrops_io_rss'`)
      .first<{ status: string; fail_count: number; next_poll_at: number }>();
    expect(failSrc?.status).toBe('degraded');
    expect(failSrc?.fail_count).toBe(1);
    expect(failSrc?.next_poll_at).toBeGreaterThan(NOW);

    // Next tick 5m later: both sources are throttled via next_poll_at -> 0 polled!
    const summary2 = await pollFeedBatch(db, 3, NOW + 5 * 60_000, null, async () => {
      throw new Error('should not fetch while throttled');
    });
    expect(summary2.polled).toBe(0);
  });

  test('multi-item RSS and calendar feeds produce distinct project clusters instead of collapsing onto aggregator domain', async () => {
    const { db } = createTestD1();
    await db
      .prepare(
        `INSERT INTO sources (id, platform, handle, lang, trust, enabled, tags)
         VALUES ('feed:airdroptracker_rss', 'feed', 'airdroptracker_rss', 'en', 0.8, 1, '["airdrop","rss","drops"]'),
                ('feed:airdropalert_calendar', 'feed', 'airdropalert_calendar', 'en', 0.85, 1, '["airdrop","calendar","tge","drops"]')`,
      )
      .run();

    const rssXml = `<?xml version="1.0"?><rss version="2.0"><channel>
      <item>
        <title>Perpl Testnet Airdrop Guide</title>
        <link>https://www.airdroptracker.io/perpl-testnet</link>
        <guid>perpl-1</guid>
        <pubDate>Mon, 23 Nov 2026 10:00:00 GMT</pubDate>
        <description>Complete Perpl testnet quests and faucet tasks.</description>
      </item>
      <item>
        <title>KiteAI Points Campaign Live</title>
        <link>https://www.airdroptracker.io/kiteai-points</link>
        <guid>kiteai-2</guid>
        <pubDate>Mon, 23 Nov 2026 11:00:00 GMT</pubDate>
        <description><![CDATA[Earn points at <a href="https://kiteai.xyz/quest">KiteAI</a>.]]></description>
      </item>
    </channel></rss>`;

    const wpJson = [
      {
        id: 501,
        date_gmt: '2026-11-23T12:00:00',
        title: { rendered: 'Treehouse $TREE Airdrop Claim' },
        content: { rendered: '<p>Claim at <a href="https://claim.treehouse.finance/">Treehouse</a>.</p>' },
        link: 'https://airdropalert.com/calendar/treehouse/',
      },
      {
        id: 502,
        date_gmt: '2026-11-23T13:00:00',
        title: { rendered: 'Nado $NADO Points Snapshot' },
        content: { rendered: '<p>Nado points campaign snapshot confirmed.</p>' },
        link: 'https://airdropalert.com/calendar/nado/',
      },
    ];

    const summary = await pollFeedBatch(db, 3, NOW, null, async cfg => {
      if (cfg.handle === 'airdroptracker_rss') return parseRssOrAtomXml(rssXml);
      return parseWpCalendarToFeedPosts(wpJson);
    });

    expect(summary.insertedPosts).toBe(4);
    const feed = await queryFeed(db, new Set<string>());
    expect(feed.items.length).toBe(4);
    expect(feed.items.some(it => it.domain === 'airdroptracker.io' || it.domain === 'airdropalert.com')).toBe(false);
    expect(feed.items.some(it => /airdroptracker|airdropalert/i.test(it.project))).toBe(false);
  });

  test('RSS/Atom parses href-before-rel, extracts content:encoded hrefs, decodes WP entities without stripping literal <...>, and preserves non-DNS raw-IP hrefs for safety', () => {
    const atom = `<?xml version="1.0" encoding="utf-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <id>atom-reordered-1</id>
          <title>Atom &ldquo;Alpha&rdquo; &mdash; Early&rsquo;s Drop &hellip;</title>
          <link rel="enclosure" href="https://cdn.example.com/banner.png" />
          <link href="https://airdrops.io/reordered-alpha/" rel="alternate" />
          <updated>2026-11-22T08:00:00Z</updated>
          <summary><![CDATA[<p>Hold &lt;100 USDC&gt; &ndash; &lsquo;bonus&rsquo; via <a href="http://185.220.101.7/claim">Portal</a> and <a href="http://1.1.1.1/">DNS</a></p>]]></summary>
        </entry>
      </feed>`;
    const atomPosts = parseRssOrAtomXml(atom);
    expect(atomPosts.length).toBe(1);
    expect(atomPosts[0].postUrl).toBe('https://airdrops.io/reordered-alpha');
    expect(atomPosts[0].text).toContain('“Alpha”');
    expect(atomPosts[0].text).toContain('—');
    expect(atomPosts[0].text).toContain('Early’s');
    expect(atomPosts[0].text).toContain('…');
    expect(atomPosts[0].text).toContain('<100 USDC>');
    expect(atomPosts[0].text).toContain('–');
    expect(atomPosts[0].text).toContain('‘bonus’');
    // Non-DNS raw IP preserved for safety evaluation, benign 1.1.1.1 stripped
    expect(atomPosts[0].urls).toContain('http://185.220.101.7/claim');
    expect(atomPosts[0].urls.some(u => u.includes('1.1.1.1'))).toBe(false);
    const parsed = parseDropPost(atomPosts[0].text, atomPosts[0].urls);
    const safety = evaluateSafety({
      domain: parsed.projectDomain,
      urls: parsed.urls,
      rawIpUrls: parsed.rawIpUrls,
      text: atomPosts[0].text,
      knownProjectDomains: new Map(),
      trustMax: 0.8,
      sourceCount: 1,
    });
    expect(safety.level).toBe('risk');

    // RSS with short plain <description> and project link inside <content:encoded>
    const rssWithContent = `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>
      <item>
        <title>AlphaDex Airdrop</title>
        <link>https://airdrops.io/alphadex</link>
        <guid>alphadex-1</guid>
        <pubDate>Sun, 22 Nov 2026 10:00:00 GMT</pubDate>
        <description>Short teaser without links.</description>
        <content:encoded><![CDATA[<p>Farm at <a href="https://app.alphadex.xyz/points?ref=123">AlphaDex</a></p>]]></content:encoded>
      </item>
    </channel></rss>`;
    const rssPosts = parseRssOrAtomXml(rssWithContent);
    expect(rssPosts.length).toBe(1);
    expect(rssPosts[0].urls).toContain('https://app.alphadex.xyz/points');

    // WP calendar also preserves non-DNS raw-IP hrefs in feed posts, and uses registrable domain for TGE external link
    const wpRaw = [
      {
        id: 9001,
        date_gmt: '2026-11-23T12:00:00',
        title: { rendered: 'SketchyDrop $SKD Claim' },
        content: {
          rendered:
            '<p><a href="https://sub.airdropalert.com/share">Share</a> <a href="https://realproj.xyz/?via=airdropalert.com">Real</a> <a href="http://198.51.100.42/claim">IP</a></p>',
        },
        link: 'https://airdropalert.com/calendar/sketchy/',
      },
    ];
    const wpPosts = parseWpCalendarToFeedPosts(wpRaw);
    expect(wpPosts[0].urls).toContain('http://198.51.100.42/claim');
    const wpTge = parseWpCalendarToAirdropFeed(wpRaw, NOW);
    expect(wpTge.tge[0].url).toBe('https://realproj.xyz/');
  });

  test('Galxe enforces isVerified, Active status, endTime >= nowMs, CJK-free alias, non-empty id, and throws on GraphQL errors', async () => {
    const payload = {
      data: {
        campaigns: {
          list: [
            {
              id: 'GC_OK',
              name: 'Valid Campaign',
              status: 'Active',
              startTime: Math.floor((NOW - 3_600_000) / 1000),
              endTime: Math.floor((NOW + 3_600_000) / 1000),
              chain: 'BASE',
              space: { id: '1', name: 'ValidSpace', alias: 'validspace', followersCount: 25000, isVerified: true },
            },
            {
              id: 'GC_UNVERIFIED',
              name: 'Unverified Space',
              status: 'Active',
              startTime: Math.floor((NOW - 3_600_000) / 1000),
              space: { id: '2', name: 'Fake', alias: 'fake', followersCount: 50000, isVerified: false },
            },
            {
              id: 'GC_ENDED_STATUS',
              name: 'Closed Status',
              status: 'Expired',
              startTime: Math.floor((NOW - 3_600_000) / 1000),
              space: { id: '3', name: 'Closed', alias: 'closed', followersCount: 50000, isVerified: true },
            },
            {
              id: 'GC_PAST_ENDTIME',
              name: 'Expired By Time',
              status: 'Active',
              startTime: Math.floor((NOW - 7_200_000) / 1000),
              endTime: Math.floor((NOW - 60_000) / 1000),
              space: { id: '4', name: 'Past', alias: 'past', followersCount: 50000, isVerified: true },
            },
            {
              id: '!!!',
              name: 'Empty Normalized ID',
              status: 'Active',
              startTime: Math.floor((NOW - 3_600_000) / 1000),
              space: { id: '5', name: 'NoId', alias: 'noid', followersCount: 50000, isVerified: true },
            },
            {
              id: 'GC_CJK_ALIAS',
              name: 'Mixed Space',
              status: 'Active',
              startTime: Math.floor((NOW - 3_600_000) / 1000),
              space: { id: '6', name: '', alias: 'alpha-\u7A7A\u6295', followersCount: 50000, isVerified: true },
            },
          ],
        },
      },
    };
    const parsed = parseGalxeCampaigns(payload, NOW);
    expect(parsed.map(p => p.id)).toEqual(['GC_OK', 'GC_CJK_ALIAS']);
    expect(FORBIDDEN_CJK_RE.test(JSON.stringify(parsed))).toBe(false);

    const prevFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ errors: [{ message: 'rate limited' }], data: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch;
    try {
      await expect(
        fetchDropFeedPosts(
          {
            platform: 'feed',
            handle: 'galxe_trending',
            lang: 'en',
            trust: 0.75,
            tags: ['drops'],
            enabled: true,
            url: 'https://graphigo.prd.galaxy.eco/query',
            parser: 'galxe',
          },
          NOW,
        ),
      ).rejects.toThrow(/Galxe GraphQL/i);
    } finally {
      globalThis.fetch = prevFetch;
    }
  });

  test('Pendle unknown chainId uses Multi-Chain + /points, sorts per-protocol markets by liquidity desc, dedupes slug IDs, validates Merkl icon, and throws on empty curated fetches', async () => {
    const pendleRaw = {
      markets: [
        {
          name: 'DustPool',
          address: '0xdust',
          protocol: 'MultiPool',
          chainId: 1,
          expiry: '2027-03-25T00:00:00.000Z',
          categoryIds: ['points'],
          details: { liquidity: 100_000, impliedApy: 0.05 },
        },
        {
          name: 'WhalePool',
          address: '0xwhale',
          protocol: 'MultiPool',
          chainId: 42161,
          expiry: '2027-03-25T00:00:00.000Z',
          categoryIds: ['points'],
          details: { liquidity: 40_000_000, impliedApy: 0.12 },
        },
        {
          name: 'UnknownChainPool',
          address: '0xunk',
          protocol: 'MysteryProto',
          chainId: 777777,
          expiry: '2027-03-25T00:00:00.000Z',
          categoryIds: ['points'],
          details: { liquidity: 5_000_000, impliedApy: 0.08 },
        },
        // Distinct bucket names colliding on slugify
        { name: 'M1', address: '0xa', protocol: 'A+B', chainId: 1, expiry: '2027-03-25T00:00:00.000Z', categoryIds: ['points'], details: { liquidity: 2_000_000 } },
        { name: 'M2', address: '0xb', protocol: 'A-B', chainId: 1, expiry: '2027-03-25T00:00:00.000Z', categoryIds: ['points'], details: { liquidity: 1_500_000 } },
      ],
    };
    const pf = parsePendlePoints(pendleRaw, NOW);
    const mp = pf.cards.find(c => c.n === 'MultiPool')!;
    expect(mp.url).toContain('0xwhale');
    expect(mp.tasks?.[0].title).toContain('WhalePool');
    const unk = pf.cards.find(c => c.n === 'MysteryProto')!;
    expect(unk.chain).toBe('Multi-Chain');
    expect(unk.url).toBe('https://app.pendle.finance/points');
    const slugIds = pf.cards.filter(c => c.n === 'A+B' || c.n === 'A-B').map(c => c.id);
    expect(new Set(slugIds).size).toBe(2);

    const merklRaw = [
      {
        id: 'bad-icon',
        name: 'Pool 1',
        chain: { name: 'Base' },
        protocol: { name: 'A+B', icon: 'https://not a valid icon url' },
        status: 'LIVE',
        tvl: 500_000,
        depositUrl: 'https://ab1.xyz',
      },
      {
        id: 'collision',
        name: 'Pool 2',
        chain: { name: 'Base' },
        protocol: { name: 'A-B', icon: 'https://127.0.0.1/icon.png' },
        status: 'LIVE',
        tvl: 400_000,
        depositUrl: 'https://ab2.xyz',
      },
    ];
    const mf = parseMerklOpportunities(merklRaw, NOW);
    expect(mf.cards[0].img).toBe('');
    expect(mf.cards[1].img).toBe('');
    expect(new Set(mf.cards.map(c => c.id)).size).toBe(2);

    const prevFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;
    try {
      await expect(fetchPendlePoints('https://pendle.test/all', NOW)).rejects.toThrow();
      await expect(fetchMerklOpportunities('https://merkl.test/all', NOW)).rejects.toThrow();
      await expect(fetchWpCalendarAirdrops('https://wp.test/all', NOW)).rejects.toThrow();
    } finally {
      globalThis.fetch = prevFetch;
    }
  });

  test('pollFeedBatch deduplicates non-monotonic feeds via D1 posts table, caps at 10 per poll, and looks up seed config case-insensitively', async () => {
    const { db } = createTestD1();
    await db
      .prepare(
        `INSERT INTO sources (id, platform, handle, lang, trust, enabled, tags, last_seen_id)
         VALUES ('feed:Galxe_Trending', 'feed', 'Galxe_Trending', 'en', 0.75, 1, '["airdrop","quests","drops"]', 'newest-seen')`,
      )
      .run();
    // Seed 'newest-seen' in posts table so D1 dedup skips it, while older newly-trending 'older-unseen' MUST still be ingested!
    await db
      .prepare(
        `INSERT INTO posts (id, source_id, post_url, posted_at, text, urls, created_at)
         VALUES ('feed:Galxe_Trending:newest-seen', 'feed:Galxe_Trending', 'https://app.galxe.com/quest/a/newest-seen', ?1, 'Existing post', '[]', ?1)`,
      )
      .bind(NOW - 10_000)
      .run();

    let receivedCfgUrl: string | undefined;
    const batch = Array.from({ length: 14 }, (_, i) => ({
      id: i === 0 ? 'newest-seen' : `older-unseen-${i}`,
      postUrl: `https://app.galxe.com/quest/space${i}/older-unseen-${i}`,
      postedAt: NOW - (i + 1) * 60_000,
      text: `Proto${i} testnet airdrop quest live at https://proto${i}.xyz/quest`,
      urls: [`https://proto${i}.xyz/quest`],
    }));

    const summary = await pollFeedBatch(db, 3, NOW, null, async cfg => {
      receivedCfgUrl = cfg.url;
      return batch;
    });

    // Case-insensitive lookup via getSeedSourceById must find galxe_trending URL
    expect(receivedCfgUrl).toBe('https://graphigo.prd.galaxy.eco/query');
    // 13 unseen relevant posts -> capped to MAX_POSTS_PER_POLL = 10 (and older-unseen-1 was NOT blocked by newest-seen!)
    expect(summary.insertedPosts).toBe(10);
    const insertedOlder = await db
      .prepare(`SELECT id FROM posts WHERE id = 'feed:Galxe_Trending:older-unseen-1'`)
      .first<{ id: string }>();
    expect(insertedOlder?.id).toBe('feed:Galxe_Trending:older-unseen-1');

    // Second poll with identical feed (after TTL): remaining 3 unseen posts ingested, 0 duplicates re-ingested!
    const summary2 = await pollFeedBatch(db, 3, NOW + 35 * 60_000, null, async () => batch);
    expect(summary2.insertedPosts).toBe(3);
  });

  test('deduplicates repeated IDs within a single poll response before MAX_POSTS_PER_POLL, resolves relative Atom links with xml:base, prioritizes ended calendar claims, and rejects malformed wp_calendar payloads', async () => {
    // 1. Ended claim precedence over generic claim keyword
    const endedCal = parseWpCalendarToAirdropFeed(
      [
        {
          id: 1,
          date_gmt: '2026-11-22T12:00:00',
          title: { rendered: 'Example Airdrop Claim Ended' },
          content: { rendered: '<p>The claim window has closed.</p>' },
          link: 'https://airdropalert.com/calendar/ended-claim/',
        },
        {
          id: 2,
          date_gmt: '2026-11-22T13:00:00',
          title: { rendered: 'OpenProto Airdrop Claim Live' },
          content: { rendered: '<p>Check eligibility now.</p>' },
          link: 'https://airdropalert.com/calendar/open-claim/',
        },
      ],
      NOW,
    );
    expect(endedCal.tge.find(t => t.n === 'Example Airdrop Claim Ended')?.s).toBe('Ended');
    expect(endedCal.tge.find(t => t.n === 'OpenProto Airdrop Claim Live')?.s).toBe('Claimable');

    // 2. Relative Atom links resolved via xml:base and response URL
    const relAtom = `<?xml version="1.0" encoding="utf-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom" xml:base="https://publisher.example/updates/">
        <entry>
          <id>rel-1</id>
          <title>Relative Launch Guide</title>
          <link rel="alternate" href="launch?utm_source=atom" />
          <updated>2026-11-23T08:00:00Z</updated>
          <summary>Testnet guide live.</summary>
        </entry>
        <entry xml:base="sub/">
          <id>rel-2</id>
          <title>Nested Entry Guide</title>
          <link href="nested-post" />
          <updated>2026-11-23T09:00:00Z</updated>
          <summary>Nested testnet guide.</summary>
        </entry>
        <entry>
          <id>abs-1</id>
          <title>Absolute Link Guide</title>
          <link href="https://other.example/airdrop?utm_medium=rss" />
          <updated>2026-11-23T10:00:00Z</updated>
          <summary>Absolute link stays intact.</summary>
        </entry>
      </feed>`;
    const relPosts = parseRssOrAtomXml(relAtom);
    expect(relPosts.find(p => p.id === 'rel-1')?.postUrl).toBe('https://publisher.example/updates/launch');
    expect(relPosts.find(p => p.id === 'rel-2')?.postUrl).toBe('https://publisher.example/updates/sub/nested-post');
    expect(relPosts.find(p => p.id === 'abs-1')?.postUrl).toBe('https://other.example/airdrop');

    // Without xml:base, resolve against feed response URL
    const noBaseAtom = `<?xml version="1.0" encoding="utf-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <id>resp-base-1</id>
          <title>Response Base Post</title>
          <link href="post-99" />
          <updated>2026-11-23T08:00:00Z</updated>
          <summary>Uses response URL as base.</summary>
        </entry>
      </feed>`;
    const respBasePosts = parseRssOrAtomXml(noBaseAtom, 'https://publisher.example/blog/atom.xml');
    expect(respBasePosts[0]?.postUrl).toBe('https://publisher.example/blog/post-99');

    // 3. Repeated event ID inside one response must not consume a MAX_POSTS_PER_POLL slot
    const { db } = createTestD1();
    await db
      .prepare(
        `INSERT INTO sources (id, platform, handle, lang, trust, enabled, tags)
         VALUES ('feed:airdropalert_calendar', 'feed', 'airdropalert_calendar', 'en', 0.85, 1, '["airdrop","calendar","tge","drops"]')`,
      )
      .run();
    const dupBatch = [
      {
        id: 'evt-dup',
        postUrl: 'https://airdropalert.com/calendar/dup',
        postedAt: NOW - 10_000,
        text: 'DupProto testnet airdrop quest live at https://dupproto.xyz/quest',
        urls: ['https://dupproto.xyz/quest'],
      },
      {
        id: 'evt-dup',
        postUrl: 'https://airdropalert.com/calendar/dup',
        postedAt: NOW - 10_000,
        text: 'DupProto testnet airdrop quest live at https://dupproto.xyz/quest',
        urls: ['https://dupproto.xyz/quest'],
      },
      ...Array.from({ length: 9 }, (_, i) => ({
        id: `evt-${i + 1}`,
        postUrl: `https://airdropalert.com/calendar/evt-${i + 1}`,
        postedAt: NOW - (i + 2) * 60_000,
        text: `CalProto${i + 1} testnet airdrop quest live at https://calproto${i + 1}.xyz/quest`,
        urls: [`https://calproto${i + 1}.xyz/quest`],
      })),
    ];
    const dupSummary = await pollFeedBatch(db, 3, NOW, null, async () => dupBatch);
    expect(dupSummary.insertedPosts).toBe(10);
    const ninth = await db
      .prepare(`SELECT id FROM posts WHERE id = 'feed:airdropalert_calendar:evt-9'`)
      .first<{ id: string }>();
    expect(ninth?.id).toBe('feed:airdropalert_calendar:evt-9');

    // 4. Malformed wp_calendar JSON object throws in fetchDropFeedPosts; valid empty [] succeeds
    const prevFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ code: 'rest_forbidden', message: 'denied' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })) as unknown as typeof fetch;
      await expect(
        fetchDropFeedPosts(
          {
            platform: 'feed',
            handle: 'airdropalert_calendar',
            lang: 'en',
            trust: 0.85,
            tags: ['drops'],
            enabled: true,
            url: 'https://airdropalert.com/wp-json/wp/v2/aa_calendar_event',
            parser: 'wp_calendar',
          },
          NOW,
        ),
      ).rejects.toThrow();

      globalThis.fetch = (async () =>
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })) as unknown as typeof fetch;
      const emptyOk = await fetchDropFeedPosts(
        {
          platform: 'feed',
          handle: 'airdropalert_calendar',
          lang: 'en',
          trust: 0.85,
          tags: ['drops'],
          enabled: true,
          url: 'https://airdropalert.com/wp-json/wp/v2/aa_calendar_event',
          parser: 'wp_calendar',
        },
        NOW,
      );
      expect(emptyOk).toEqual([]);
    } finally {
      globalThis.fetch = prevFetch;
    }
  });

  test('normalizePostId keeps clean GUIDs verbatim and prevents distinct upstream GUIDs from colliding', () => {
    const longSuffix = 'x'.repeat(80);
    const rss = `<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0"><channel><title>GuidCollisions</title>
        <item>
          <title>Campaign Dash A</title>
          <link>https://example.com/1</link>
          <guid>campaign-a</guid>
          <pubDate>Mon, 23 Nov 2026 10:00:00 GMT</pubDate>
          <description>Dash variant</description>
        </item>
        <item>
          <title>Campaign Slash A</title>
          <link>https://example.com/2</link>
          <guid>campaign/a</guid>
          <pubDate>Mon, 23 Nov 2026 10:01:00 GMT</pubDate>
          <description>Slash variant</description>
        </item>
        <item>
          <title>Https Scheme Guid</title>
          <link>https://example.com/3</link>
          <guid>https://feed.example/post/42</guid>
          <pubDate>Mon, 23 Nov 2026 10:02:00 GMT</pubDate>
          <description>HTTPS guid</description>
        </item>
        <item>
          <title>Http Scheme Guid</title>
          <link>https://example.com/4</link>
          <guid>http://feed.example/post/42</guid>
          <pubDate>Mon, 23 Nov 2026 10:03:00 GMT</pubDate>
          <description>HTTP guid</description>
        </item>
        <item>
          <title>Long Guid 1</title>
          <link>https://example.com/5</link>
          <guid>prefix-1-${longSuffix}</guid>
          <pubDate>Mon, 23 Nov 2026 10:04:00 GMT</pubDate>
          <description>Long guid 1</description>
        </item>
        <item>
          <title>Long Guid 2</title>
          <link>https://example.com/6</link>
          <guid>prefix-2-${longSuffix}</guid>
          <pubDate>Mon, 23 Nov 2026 10:05:00 GMT</pubDate>
          <description>Long guid 2</description>
        </item>
        <item>
          <title>Tilde Guid</title>
          <link>https://example.com/7</link>
          <guid>campaign-a~0123456789abcdef</guid>
          <pubDate>Mon, 23 Nov 2026 10:06:00 GMT</pubDate>
          <description>Contains tilde</description>
        </item>
      </channel></rss>`;

    const first = parseRssOrAtomXml(rss);
    const second = parseRssOrAtomXml(rss);

    expect(first.length).toBe(7);
    expect(new Set(first.map(p => p.id)).size).toBe(7);
    expect(first.map(p => p.id)).toEqual(second.map(p => p.id));

    const dashPost = first.find(p => p.postUrl === 'https://example.com/1')!;
    const slashPost = first.find(p => p.postUrl === 'https://example.com/2')!;
    expect(dashPost.id).toBe('campaign-a');
    expect(slashPost.id).toMatch(/^campaign-a~[0-9a-f]{16}$/);
    expect(slashPost.id).not.toBe(dashPost.id);
  });

  test('parsePendlePoints keeps deterministic card IDs stable when liquidity order flips', () => {
    const highAPlusB = parsePendlePoints(
      {
        markets: [
          {
            name: 'M1',
            address: '0xa',
            protocol: 'A+B',
            chainId: 1,
            expiry: '2027-03-25T00:00:00.000Z',
            categoryIds: ['points'],
            details: { liquidity: 5_000_000 },
          },
          {
            name: 'M2',
            address: '0xb',
            protocol: 'A-B',
            chainId: 1,
            expiry: '2027-03-25T00:00:00.000Z',
            categoryIds: ['points'],
            details: { liquidity: 1_500_000 },
          },
          {
            name: 'sUSDe',
            address: '0xc',
            protocol: 'Ethena',
            chainId: 1,
            expiry: '2027-03-25T00:00:00.000Z',
            categoryIds: ['points'],
            details: { liquidity: 2_000_000 },
          },
        ],
      },
      NOW,
    );

    const highADashB = parsePendlePoints(
      {
        markets: [
          {
            name: 'M2',
            address: '0xb',
            protocol: 'A-B',
            chainId: 1,
            expiry: '2027-03-25T00:00:00.000Z',
            categoryIds: ['points'],
            details: { liquidity: 8_000_000 },
          },
          {
            name: 'M1',
            address: '0xa',
            protocol: 'A+B',
            chainId: 1,
            expiry: '2027-03-25T00:00:00.000Z',
            categoryIds: ['points'],
            details: { liquidity: 1_000_000 },
          },
          {
            name: 'sUSDe',
            address: '0xc',
            protocol: 'Ethena',
            chainId: 1,
            expiry: '2027-03-25T00:00:00.000Z',
            categoryIds: ['points'],
            details: { liquidity: 2_000_000 },
          },
        ],
      },
      NOW,
    );

    const id1 = (name: string) => highAPlusB.cards.find(c => c.n === name)!.id;
    const id2 = (name: string) => highADashB.cards.find(c => c.n === name)!.id;

    expect(id1('Ethena')).toBe('pendle:ethena');
    expect(id2('Ethena')).toBe('pendle:ethena');
    expect(id1('A-B')).toBe('pendle:a-b');
    expect(id2('A-B')).toBe('pendle:a-b');
    expect(id1('A+B')).toMatch(/^pendle:a-b~[0-9a-f]{8}$/);
    expect(id1('A+B')).toBe(id2('A+B'));
    expect(id1('A+B')).not.toBe(id1('A-B'));

    // Canonical protocol name matching `<slug>-<hash>` must never collide with hashed `A+B` regardless of liquidity order
    const aPlusHash = id1('A+B')!.split('~')[1];
    const canonicalName = `a-b-${aPlusHash}`;
    const clashFwd = parsePendlePoints(
      {
        markets: [
          {
            name: 'M1',
            address: '0xa',
            protocol: 'A+B',
            chainId: 1,
            expiry: '2027-03-25T00:00:00.000Z',
            categoryIds: ['points'],
            details: { liquidity: 9_000_000 },
          },
          {
            name: 'M2',
            address: '0xb',
            protocol: canonicalName,
            chainId: 1,
            expiry: '2027-03-25T00:00:00.000Z',
            categoryIds: ['points'],
            details: { liquidity: 1_000_000 },
          },
        ],
      },
      NOW,
    );
    const clashRev = parsePendlePoints(
      {
        markets: [
          {
            name: 'M2',
            address: '0xb',
            protocol: canonicalName,
            chainId: 1,
            expiry: '2027-03-25T00:00:00.000Z',
            categoryIds: ['points'],
            details: { liquidity: 9_000_000 },
          },
          {
            name: 'M1',
            address: '0xa',
            protocol: 'A+B',
            chainId: 1,
            expiry: '2027-03-25T00:00:00.000Z',
            categoryIds: ['points'],
            details: { liquidity: 1_000_000 },
          },
        ],
      },
      NOW,
    );
    expect(clashFwd.cards.find(c => c.n === canonicalName)!.id).toBe(`pendle:${canonicalName}`);
    expect(clashRev.cards.find(c => c.n === canonicalName)!.id).toBe(`pendle:${canonicalName}`);
    expect(clashFwd.cards.find(c => c.n === 'A+B')!.id).toBe(`pendle:a-b~${aPlusHash}`);
    expect(clashRev.cards.find(c => c.n === 'A+B')!.id).toBe(`pendle:a-b~${aPlusHash}`);
  });

  test('parseMerklOpportunities keeps deterministic card IDs stable across TVL swaps and protocol.id values', () => {
    const highAPlusB = parseMerklOpportunities(
      [
        {
          id: 'opp-1',
          name: 'Pool 1',
          chain: { name: 'Base' },
          protocol: { name: 'A+B' },
          status: 'LIVE',
          tvl: 5_000_000,
          depositUrl: 'https://ab1.xyz',
        },
        {
          id: 'opp-2',
          name: 'Pool 2',
          chain: { name: 'Base' },
          protocol: { name: 'A-B' },
          status: 'LIVE',
          tvl: 1_000_000,
          depositUrl: 'https://ab2.xyz',
        },
        {
          id: 'opp-3',
          name: 'Morpho Vault',
          chain: { name: 'Base' },
          protocol: { id: 'morpho', name: 'Morpho' },
          status: 'LIVE',
          tvl: 2_000_000,
          depositUrl: 'https://app.morpho.org/vault',
        },
        {
          id: 'opp-4',
          name: 'Alpha V1 Pool',
          chain: { name: 'Arbitrum' },
          protocol: { id: 'alpha-v1', name: 'Alpha' },
          status: 'LIVE',
          tvl: 4_000_000,
          depositUrl: 'https://alpha-v1.xyz',
        },
        {
          id: 'opp-5',
          name: 'Alpha V2 Pool',
          chain: { name: 'Base' },
          protocol: { id: 'alpha_v2', name: 'Alpha' },
          status: 'LIVE',
          tvl: 1_200_000,
          depositUrl: 'https://alpha-v2.xyz',
        },
      ],
      NOW,
    );

    const swappedTvl = parseMerklOpportunities(
      [
        {
          id: 'opp-2',
          name: 'Pool 2',
          chain: { name: 'Base' },
          protocol: { name: 'A-B' },
          status: 'LIVE',
          tvl: 6_000_000,
          depositUrl: 'https://ab2.xyz',
        },
        {
          id: 'opp-1',
          name: 'Pool 1',
          chain: { name: 'Base' },
          protocol: { name: 'A+B' },
          status: 'LIVE',
          tvl: 900_000,
          depositUrl: 'https://ab1.xyz',
        },
        {
          id: 'opp-3',
          name: 'Morpho Vault',
          chain: { name: 'Base' },
          protocol: { id: 'morpho', name: 'Morpho' },
          status: 'LIVE',
          tvl: 2_000_000,
          depositUrl: 'https://app.morpho.org/vault',
        },
        {
          id: 'opp-5',
          name: 'Alpha V2 Pool',
          chain: { name: 'Base' },
          protocol: { id: 'alpha_v2', name: 'Alpha' },
          status: 'LIVE',
          tvl: 7_000_000,
          depositUrl: 'https://alpha-v2.xyz',
        },
        {
          id: 'opp-4',
          name: 'Alpha V1 Pool',
          chain: { name: 'Arbitrum' },
          protocol: { id: 'alpha-v1', name: 'Alpha' },
          status: 'LIVE',
          tvl: 800_000,
          depositUrl: 'https://alpha-v1.xyz',
        },
      ],
      NOW,
    );

    const byUrl1 = (url: string) => highAPlusB.cards.find(c => c.url === url)!.id;
    const byUrl2 = (url: string) => swappedTvl.cards.find(c => c.url === url)!.id;

    expect(byUrl1('https://app.morpho.org/vault')).toBe('merkl:morpho');
    expect(byUrl2('https://app.morpho.org/vault')).toBe('merkl:morpho');
    expect(byUrl1('https://ab2.xyz/')).toBe('merkl:a-b');
    expect(byUrl2('https://ab2.xyz/')).toBe('merkl:a-b');
    expect(byUrl1('https://ab1.xyz/')).toMatch(/^merkl:a-b~[0-9a-f]{8}$/);
    expect(byUrl1('https://ab1.xyz/')).toBe(byUrl2('https://ab1.xyz/'));
    expect(byUrl1('https://ab1.xyz/')).not.toBe(byUrl1('https://ab2.xyz/'));

    // Distinct protocol.id values with the same display name stay distinct and TVL-order-independent
    expect(byUrl1('https://alpha-v1.xyz/')).toBe('merkl:alpha-v1');
    expect(byUrl2('https://alpha-v1.xyz/')).toBe('merkl:alpha-v1');
    expect(byUrl1('https://alpha-v2.xyz/')).toMatch(/^merkl:alpha-v2~[0-9a-f]{8}$/);
    expect(byUrl1('https://alpha-v2.xyz/')).toBe(byUrl2('https://alpha-v2.xyz/'));
    expect(byUrl1('https://alpha-v1.xyz/')).not.toBe(byUrl1('https://alpha-v2.xyz/'));

    // Canonical protocol.id matching `<slug>-<hash>` never collides with hashed `A+B` across TVL swaps
    const merklHash = byUrl1('https://ab1.xyz/')!.split('~')[1];
    const canonicalProto = `a-b-${merklHash}`;
    const mFwd = parseMerklOpportunities(
      [
        { id: '1', name: 'P1', chain: { name: 'Base' }, protocol: { name: 'A+B' }, status: 'LIVE', tvl: 9_000_000, depositUrl: 'https://aplus.xyz' },
        { id: '2', name: 'P2', chain: { name: 'Base' }, protocol: { id: canonicalProto, name: canonicalProto }, status: 'LIVE', tvl: 1_000_000, depositUrl: 'https://canon.xyz' },
      ],
      NOW,
    );
    const mRev = parseMerklOpportunities(
      [
        { id: '2', name: 'P2', chain: { name: 'Base' }, protocol: { id: canonicalProto, name: canonicalProto }, status: 'LIVE', tvl: 9_000_000, depositUrl: 'https://canon.xyz' },
        { id: '1', name: 'P1', chain: { name: 'Base' }, protocol: { name: 'A+B' }, status: 'LIVE', tvl: 1_000_000, depositUrl: 'https://aplus.xyz' },
      ],
      NOW,
    );
    expect(mFwd.cards.find(c => c.url === 'https://canon.xyz/')!.id).toBe(`merkl:${canonicalProto}`);
    expect(mRev.cards.find(c => c.url === 'https://canon.xyz/')!.id).toBe(`merkl:${canonicalProto}`);
    expect(mFwd.cards.find(c => c.url === 'https://aplus.xyz/')!.id).toBe(`merkl:a-b~${merklHash}`);
    expect(mRev.cards.find(c => c.url === 'https://aplus.xyz/')!.id).toBe(`merkl:a-b~${merklHash}`);
  });

  test('pollFeedBatch deduplicates already-stored legacy-ID posts while still ingesting distinct posts sharing an old truncated tail', async () => {
    const { db } = createTestD1();
    await db
      .prepare(
        `INSERT INTO sources (id, platform, handle, lang, trust, tags, enabled)
         VALUES ('feed:legacy_rss', 'feed', 'legacy_rss', 'en', 0.8, '["drops"]', 1)`,
      )
      .run();

    // Seed an existing post stored under the pre-hash legacy normalizePostId format
    const sharedTail = 'a'.repeat(70);
    const oldGuid = 'https://feed.example/post/42';
    const legacyId = 'feed:legacy_rss:feed.example-post-42';
    const collidingOldUrl = `https://a.example/prefix/${sharedTail}`;
    const collidingNewUrl = `https://b.example/prefix/${sharedTail}`;
    const collidingLegacyTail = `prefix-${sharedTail}`.slice(-80);
    await db
      .prepare(
        `INSERT INTO clusters (id, project, chains, task_types, summary, summary_source, risk_level, risk_reasons, score, source_count, first_seen, last_seen, is_drop)
         VALUES ('c_legacy', 'LegacyProto', '[]', '["testnet"]', 'Legacy', 'rule', 'ok', '[]', 0.8, 1, ?1, ?1, 1),
                ('c_tail', 'TailProtoA', '[]', '["testnet"]', 'TailA', 'rule', 'ok', '[]', 0.8, 1, ?1, ?1, 1)`,
      )
      .bind(NOW - 3_600_000)
      .run();
    await db
      .prepare(
        `INSERT INTO posts (id, source_id, post_url, posted_at, text, urls, cluster_id, created_at)
         VALUES (?1, 'feed:legacy_rss', ?2, ?3, 'LegacyProto testnet airdrop live', '[]', 'c_legacy', ?3),
                (?4, 'feed:legacy_rss', ?5, ?3, 'TailProtoA testnet airdrop live', '[]', 'c_tail', ?3)`,
      )
      .bind(legacyId, oldGuid, NOW - 3_600_000, `feed:legacy_rss:${collidingLegacyTail}`, collidingOldUrl)
      .run();

    const rss = `<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0"><channel><title>LegacyFeed</title>
        <item>
          <title>LegacyProto testnet airdrop live</title>
          <link>${oldGuid}</link>
          <guid>${oldGuid}</guid>
          <pubDate>Mon, 23 Nov 2026 10:00:00 GMT</pubDate>
          <description>Claim testnet faucet at https://legacyproto.xyz/faucet</description>
        </item>
        <item>
          <title>BrandNewProto testnet airdrop live</title>
          <link>https://feed.example/post/43</link>
          <guid>https://feed.example/post/43</guid>
          <pubDate>Mon, 23 Nov 2026 11:00:00 GMT</pubDate>
          <description>Claim testnet faucet at https://brandnewproto.xyz/faucet</description>
        </item>
        <item>
          <title>TailProtoB testnet airdrop live</title>
          <link>${collidingNewUrl}</link>
          <guid>${collidingNewUrl}</guid>
          <pubDate>Mon, 23 Nov 2026 11:30:00 GMT</pubDate>
          <description>Claim testnet faucet at https://tailprotob.xyz/faucet</description>
        </item>
      </channel></rss>`;

    const parsed = parseRssOrAtomXml(rss);
    const res = await pollFeedBatch(db, 5, NOW, null, async () => parsed);
    expect(res.degraded).toBe(0);
    // Post 42 must NOT be re-inserted; Post 43 and TailProtoB (different post_url) MUST be inserted.
    expect(res.insertedPosts).toBe(2);

    const post42Rows = await db
      .prepare(`SELECT id FROM posts WHERE source_id = 'feed:legacy_rss' AND post_url = ?1`)
      .bind(oldGuid)
      .all<{ id: string }>();
    expect(post42Rows.results).toHaveLength(1);
    expect(post42Rows.results[0].id).toBe(legacyId);
  });
});
