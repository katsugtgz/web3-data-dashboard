import { describe, expect, test } from 'bun:test';
import { fmtIsoDate } from '../src/lib/format';
import { createTestD1, FORBIDDEN_CJK_RE } from './helpers';
import { queryFeed } from '../src/normalize/cluster';
import {
  fetchAirdropAlertAirdrops,
  fetchDropFeedPosts,
  fetchGalxeCampaignsToAirdropFeed,
  fetchMerklOpportunities,
  fetchPendlePoints,
  fetchWpCalendarAirdrops,
  isCleanProjectDomain,
  parseAirdropAlertEvents,
  parseGalxeCampaigns,
  parseGalxeCampaignsToAirdropFeed,
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

  test('extracts Merkl token icon fallback & protocol ticker, AirdropAlert https media/img & parenthesized ticker, and Pendle icon', () => {
    const merklRaw = [
      {
        id: 'm-tok-1',
        name: 'Supply USDC on Euler',
        chain: { name: 'Ethereum' },
        protocol: { name: 'Euler' },
        tokens: [
          { symbol: 'USDC', icon: 'https://icons.merkl.xyz/usdc.png' },
          { symbol: 'EUL', icon: 'https://icons.merkl.xyz/eul.png' },
        ],
        rewardsRecord: {
          breakdowns: [{ token: { symbol: 'EUL', icon: 'https://icons.merkl.xyz/eul-reward.png' } }],
        },
        status: 'LIVE',
        tvl: 5_000_000,
        depositUrl: 'https://app.euler.finance/',
      },
      {
        id: 'm-tok-2',
        name: 'Supply WETH on Euler',
        chain: { name: 'Base' },
        protocol: { name: 'Euler', icon: 'https://icons.merkl.xyz/euler-proto.png' },
        status: 'LIVE',
        tvl: 3_000_000,
        depositUrl: 'https://app.euler.finance/base',
      },
      {
        id: 'm-only-token',
        name: 'LP on Velodrome',
        chain: { name: 'Optimism' },
        protocol: { name: 'Velodrome' },
        tokens: [{ symbol: 'VELO', icon: 'https://icons.merkl.xyz/velo.png' }],
        rewardsRecord: {
          breakdowns: [{ token: { symbol: 'OP', icon: 'https://icons.merkl.xyz/op.png' } }],
        },
        status: 'LIVE',
        tvl: 2_000_000,
        depositUrl: 'https://velodrome.finance/',
      },
    ];
    const mf = parseMerklOpportunities(merklRaw, NOW);
    const euler = mf.cards.find(c => c.n === 'Euler')!;
    // Later opportunity's authoritative protocol.icon upgrades earlier token fallback.
    expect(euler.img).toBe('https://icons.merkl.xyz/euler-proto.png');
    expect(euler.t).toBe('EUL');
    const velo = mf.cards.find(c => c.n === 'Velodrome')!;
    // Token icon fallback used when protocol.icon is absent; unrelated OP reward does not hijack ticker.
    expect(velo.img).toBe('https://icons.merkl.xyz/velo.png');
    expect(velo.t).toBe('VELO');

    const wpPayload = [
      {
        id: 701,
        date_gmt: '2026-11-23T12:00:00',
        title: { rendered: 'HyperGrid (HGRD) TGE Event' },
        jetpack_featured_media_url: 'https://cdn.airdropalert.com/wp-content/uploads/hypergrid.png',
        content: { rendered: '<p>TGE schedule announced.</p>' },
        link: 'https://airdropalert.com/calendar/hypergrid/',
      },
      {
        id: 702,
        date_gmt: '2026-11-23T13:00:00',
        title: { rendered: 'InlineImgProto $IIP Claim' },
        content: {
          rendered:
            '<p><img src="http://insecure.example/a.png" /><img src="https://cdn.airdropalert.com/img/iip-logo.webp" /></p>',
        },
        link: 'https://airdropalert.com/calendar/iip/',
      },
    ];
    const wpFeed = parseWpCalendarToAirdropFeed(wpPayload, NOW);
    expect(wpFeed.tge[0].t).toBe('HGRD');
    expect(wpFeed.tge[0].logo).toBe('https://cdn.airdropalert.com/wp-content/uploads/hypergrid.png');
    expect(wpFeed.tge[1].t).toBe('IIP');
    expect(wpFeed.tge[1].logo).toBe('https://cdn.airdropalert.com/img/iip-logo.webp');

    const pendleFeed = parsePendlePoints(
      {
        markets: [
          {
            name: 'sUSDe',
            address: '0x123',
            protocol: 'Ethena',
            proIcon: 'https://storage.googleapis.com/prod-pendle-bucket-a/images/assets/pro/ethena.svg',
            chainId: 1,
            expiry: '2027-03-25T00:00:00.000Z',
            categoryIds: ['points'],
            details: { liquidity: 20_000_000 },
          },
        ],
      },
      NOW,
    );
    expect(pendleFeed.cards[0].img).toBe(
      'https://storage.googleapis.com/prod-pendle-bucket-a/images/assets/pro/ethena.svg',
    );
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

describe('structured curated enrichment (Pendle, Merkl, AirdropAlert active airdrops, Galxe trending)', () => {
  test('Pendle cards carry structured apy, tvlUsd, deadline and description from upstream market data', () => {
    const feed = parsePendlePoints(
      {
        markets: [
          {
            name: 'sUSDe',
            address: '0xa',
            protocol: 'Ethena',
            chainId: 1,
            expiry: '2027-03-25T00:00:00.000Z',
            categoryIds: ['points'],
            details: { liquidity: 25_000_000, impliedApy: 0.145 },
          },
          {
            name: 'USDe',
            address: '0xb',
            protocol: 'Ethena',
            chainId: 8453,
            expiry: '2027-06-24T00:00:00.000Z',
            categoryIds: ['points'],
            details: { liquidity: 5_000_000, impliedApy: 0.08 },
          },
          {
            name: 'NoApyPool',
            address: '0xc',
            protocol: 'NoApyProto',
            chainId: 1,
            expiry: '2027-03-25T00:00:00.000Z',
            categoryIds: ['points'],
            details: { liquidity: 9_000_000, impliedApy: Number.NaN },
          },
        ],
      },
      NOW,
    );

    const ethena = feed.cards.find(c => c.n === 'Ethena')!;
    expect(ethena.tvlUsd).toBe(30_000_000);
    expect(ethena.apy).toBe('14.50%');
    // Earliest expiry across the card's pools.
    expect(ethena.deadline).toBe('2027-03-25');
    expect(ethena.description).toContain('Ethena');
    // Pendle market links are aggregator URLs, so no project domain can be verified.
    expect(ethena.verifiedDomain).toBeUndefined();
    expect(ethena.rewardPool).toBeUndefined();

    const noApy = feed.cards.find(c => c.n === 'NoApyProto')!;
    expect(noApy.tvlUsd).toBe(9_000_000);
    expect(noApy.apy).toBeUndefined();
    expect(noApy.deadline).toBe('2027-03-25');
    expect(FORBIDDEN_CJK_RE.test(JSON.stringify(feed))).toBe(false);
  });

  test('Merkl cards carry structured apy, tvlUsd, daily reward pool, description and verifiedDomain for clean deposit URLs', () => {
    const feed = parseMerklOpportunities(
      [
        // Live Merkl data shape: the top Morpho vault is a Robinhood-only deep link, not Morpho's own site.
        {
          id: 'm0',
          name: '[Robinhood Users Only] Supply to Steakhouse USDG V2 vault on Morpho',
          chain: { name: 'Robinhood Chain' },
          protocol: { id: 'morpho', name: 'Morpho' },
          action: 'SUPPLY',
          status: 'LIVE',
          tvl: 541_980_000,
          apr: 3.5,
          depositUrl: 'https://applink.robinhood.com/u/home',
        },
        {
          id: 'm1',
          name: 'Supply USDC on Morpho Base',
          chain: { name: 'Base' },
          protocol: { id: 'morpho', name: 'Morpho' },
          action: 'LEND',
          status: 'LIVE',
          tvl: 18_500_000,
          apr: 12.4,
          dailyRewards: 5000,
          depositUrl: 'https://app.morpho.org/vault?ref=merkl',
        },
        {
          id: 'm2',
          name: 'Supply USDC on Morpho Ethereum',
          chain: { name: 'Ethereum' },
          protocol: { id: 'morpho', name: 'Morpho' },
          action: 'LEND',
          status: 'LIVE',
          tvl: 11_500_000,
          apr: 8.042,
          dailyRewards: 2500.5,
          depositUrl: 'https://app.morpho.org/eth',
        },
        {
          id: 'm3',
          name: 'Aggregator wrapped pool',
          chain: { name: 'Base' },
          protocol: { id: 'agg', name: 'AggregatorWrapped' },
          status: 'LIVE',
          tvl: 5_000_000,
          depositUrl: 'https://app.merkl.xyz/opportunities/x',
        },
        {
          id: 'm4',
          name: 'Quest platform pool',
          chain: { name: 'Base' },
          protocol: { id: 'quest', name: 'QuestPlatformProto' },
          status: 'LIVE',
          tvl: 3_000_000,
          dailyRewards: -5,
          depositUrl: 'https://galxe.com/quest/x',
        },
        // A third-party app with no protocol-matching deposit link never verifies.
        {
          id: 'm5',
          name: 'Supply to Steakhouse USDG V2 vault',
          chain: { name: 'Ethereum' },
          protocol: { id: 'steakhouse', name: 'Steakhouse' },
          status: 'LIVE',
          tvl: 541_980_000,
          depositUrl: 'https://applink.robinhood.com/u/home',
        },
      ],
      NOW,
    );

    const morpho = feed.cards.find(c => c.n === 'Morpho')!;
    expect(morpho.tvlUsd).toBe(571_980_000);
    expect(morpho.apy).toBe('12.4% APR');
    expect(morpho.rewardPool).toBe('$8K/day');
    expect(morpho.description).toBe('[Robinhood Users Only] Supply to Steakhouse USDG V2 vault on Morpho (Robinhood Chain)');
    // Deposit links are action links: only a host matching the protocol name counts as its verified domain.
    expect(morpho.verifiedDomain).toBe(true);
    expect(feed.cards.find(c => c.n === 'Steakhouse')?.verifiedDomain).toBeUndefined();
    expect(morpho.deadline).toBeUndefined();

    // Merkl's own app and quest platforms are aggregators, never a verified project domain.
    const aggregator = feed.cards.find(c => c.n === 'AggregatorWrapped')!;
    expect(aggregator.verifiedDomain).toBeUndefined();
    const quest = feed.cards.find(c => c.n === 'QuestPlatformProto')!;
    expect(quest.verifiedDomain).toBeUndefined();
    expect(quest.apy).toBeUndefined();
    expect(quest.rewardPool).toBeUndefined();
    expect(FORBIDDEN_CJK_RE.test(JSON.stringify(feed))).toBe(false);
  });

  test('isCleanProjectDomain accepts only https project sites, rejecting platforms, aggregators, shorteners and raw IPs', () => {
    expect(isCleanProjectDomain('https://app.morpho.org/vault', 'Morpho')).toBe(true);
    expect(isCleanProjectDomain('https://variational.io', 'Variational')).toBe(true);
    expect(isCleanProjectDomain('https://x.com/variational', 'Variational')).toBe(false);
    expect(isCleanProjectDomain('https://defillama.com/protocol/x', 'X')).toBe(false);
    expect(isCleanProjectDomain('https://galxe.com/quest/x', 'X')).toBe(false);
    expect(isCleanProjectDomain('https://app.pendle.finance/trade/markets/0x1', 'Ethena')).toBe(false);
    // Pendle itself is a real protocol on its own card.
    expect(isCleanProjectDomain('https://app.pendle.finance/', 'Pendle')).toBe(true);
    expect(isCleanProjectDomain('https://bit.ly/abc', 'X')).toBe(false);
    expect(isCleanProjectDomain('http://insecure.xyz', 'X')).toBe(false);
    expect(isCleanProjectDomain('https://127.0.0.1/x', 'X')).toBe(false);
    expect(isCleanProjectDomain(null, 'X')).toBe(false);
    expect(isCleanProjectDomain('', 'X')).toBe(false);
  });

  test('AirdropAlert active airdrops: listing-backed calendar events become cards with real deadlines, skipping free-form, stale, undated and foreign-URL rows', () => {
    // Field names mirror the live /aa-cal/v1/events payload.
    const events = {
      y: 2026,
      m: 11,
      radius: 2,
      events: [
        {
          id: 'guide-327526',
          source: 'guide',
          d: '2026-10-02',
          precision: 'exact',
          type: 'guide',
          title: 'TastyCo airdrop guide live',
          p: 'TastyCo',
          url: 'https://airdropalert.com/airdrops/tastyco/',
          cats: ['defi', 'earn-crypto', 'featured', 'new', 'verified'],
          status: 'confirmed',
          time: '',
          html: '',
          listing: 327526,
        },
        {
          id: 'manual-330146',
          source: 'manual',
          precision: 'quarter',
          type: 'tge',
          title: 'TastyCo TGE expected',
          p: 'TastyCo',
          url: 'https://airdropalert.com/airdrops/tastyco/',
          cats: [],
          status: 'estimated',
          time: '',
          html: 'Targeted.',
          listing: 327526,
          q: { y: 2026, q: 4, label: 'Q4 2026', months: ['2026-10', '2026-11', '2026-12'] },
        },
        {
          id: 'manual-330158',
          source: 'manual',
          precision: 'exact',
          type: 'claimstart',
          title: 'StandX claim opens',
          p: 'StandX',
          url: '',
          cats: [],
          status: 'confirmed',
          time: '',
          html: '<!-- wp:paragraph -->\n<p>Claims run to 2026-12-31.</p>\n<!-- /wp:paragraph -->',
          listing: 326000,
          hasGuide: true,
          d: '2026-11-01',
        },
        {
          id: 'manual-330163',
          source: 'manual',
          precision: 'exact',
          type: 'claimend',
          title: 'StandX claim ends',
          p: 'StandX',
          url: 'https://airdropalert.com/airdrops/standx/',
          cats: [],
          status: 'confirmed',
          time: '',
          html: 'End of claim window.',
          listing: 326000,
          hasGuide: true,
          d: '2026-12-31',
        },
        // Free-form milestone without a listing identity (listing = 0, url empty).
        { id: 'manual-330161', source: 'manual', precision: 'exact', type: 'claimend', title: 'Aster claim ends', p: 'Aster claim ends', url: '', cats: [], status: 'confirmed', time: '', html: 'Stage 6 claim window ends.', listing: 0, d: '2026-11-28' },
        // Month precision without any resolvable date.
        { id: 'manual-330139', source: 'manual', precision: 'month', type: 'tge', title: 'Ducat TGE expected', p: 'Ducat', url: 'https://airdropalert.com/airdrops/ducat/', cats: [], status: 'estimated', time: '', html: '', listing: 320957, hasGuide: true, q: null },
        // Older than the active window.
        { id: 'manual-330142', source: 'manual', precision: 'exact', type: 'distribution', title: 'Kinetiq distribution', p: 'Kinetiq', url: 'https://airdropalert.com/airdrops/kinetiq/', cats: [], status: 'confirmed', time: '', html: 'Last distribution.', listing: 311316, hasGuide: true, d: '2026-08-01' },
        // Listing URL must stay on airdropalert.com.
        { id: 'manual-bad-1', source: 'manual', precision: 'exact', type: 'claimstart', title: 'Phish claim opens', p: 'Phish', url: 'https://evil.example/airdrops/phish/', cats: [], status: 'confirmed', time: '', html: '', listing: 999001, d: '2026-12-05' },
        // Malformed rows.
        { id: 'manual-bad-2', source: 'manual', precision: 'exact', type: 'claimstart', title: 'Bad', p: { nested: true }, url: 'https://airdropalert.com/airdrops/bad/', cats: [], status: 'confirmed', time: '', html: '', listing: 'abc', d: '2026-12-05' },
        { id: 'manual-bad-3', source: 'manual', precision: 'exact', type: 'claimstart', title: 'Bad date', p: 'BadDate', url: 'https://airdropalert.com/airdrops/baddate/', cats: [], status: 'confirmed', time: '', html: '', listing: 999002, d: 'next tuesday' },
        null,
        42,
        'not-an-event',
      ],
    };

    const feed = parseAirdropAlertEvents(events, NOW);
    expect(feed.cards.map(c => c.n)).toEqual(['TastyCo', 'StandX']);
    expect(feed.counts).toEqual({ active: 2, preToken: 2 });
    expect(feed.tge).toEqual([]);

    const tasty = feed.cards[0];
    expect(tasty.id).toBe('airdropalert:327526');
    expect(tasty.source).toBe('AirdropAlert');
    // Listing pages live on airdropalert.com, which is a platform, not the project site.
    expect(tasty.url).toBeNull();
    expect(tasty.verifiedDomain).toBeUndefined();
    expect(tasty.deadline).toBe('Q4 2026');
    expect(tasty.description).toBe('Targeted.');
    expect(tasty.b).toEqual(['live', 'early']);
    // A verified listing ranks above an unverified one.
    expect(tasty.g).toBe('A');
    expect(tasty.tasks?.map(t => t.title)).toEqual(['TastyCo TGE expected · Q4 2026']);
    // Links go through cleanUrl, which drops the trailing slash.
    expect(tasty.tasks?.[0].url).toBe('https://airdropalert.com/airdrops/tastyco');
    expect(tasty.tk).toBe('1/1');

    const standx = feed.cards[1];
    expect(standx.id).toBe('airdropalert:326000');
    // The next upcoming milestone is the deadline; the past "claim opens" event only feeds the description.
    expect(standx.deadline).toBe('2026-12-31');
    expect(standx.description).toBe('Claims run to 2026-12-31. End of claim window.');
    expect(standx.tasks?.map(t => t.title)).toEqual(['StandX claim ends · 2026-12-31']);
    expect(standx.g).toBe('B');
    expect(FORBIDDEN_CJK_RE.test(JSON.stringify(feed))).toBe(false);

    for (const malformed of [null, undefined, 42, 'events', [], {}, { events: null }, { events: 'nope' }, { events: [[]] }]) {
      const empty = parseAirdropAlertEvents(malformed, NOW);
      expect(empty.cards).toEqual([]);
      expect(empty.counts).toEqual({ active: 0, preToken: 0 });
    }
  });

  test('fetchAirdropAlertAirdrops merges the calendar rail with active airdrop cards, fixes TGE dates via event ids, and treats the events endpoint as best-effort', async () => {
    const prevFetch = globalThis.fetch;
    const calendarPayload = [
      {
        id: 330163,
        date_gmt: '2026-11-09T12:42:48',
        title: { rendered: 'StandX claim ends' },
        content: { rendered: '<p>End of claim window.</p>' },
        link: 'https://airdropalert.com/?aa_calendar_event=standx-claim-ends',
      },
      {
        id: 330576,
        date_gmt: '2026-11-16T15:28:13',
        title: { rendered: 'Treehouse S2 Claim' },
        content: { rendered: '<p>Season 2 claim window closes.</p>' },
        link: 'https://airdropalert.com/?aa_calendar_event=treehouse-s2-claim',
      },
    ];
    const eventsPayload = {
      events: [
        // Same WP post id as the calendar entry (event id = `manual-<postId>`), real date 2027-03-31.
        {
          id: 'manual-330163',
          source: 'manual',
          precision: 'exact',
          type: 'claimend',
          title: 'StandX claim ends',
          p: 'StandX',
          url: 'https://airdropalert.com/airdrops/standx/',
          cats: [],
          status: 'confirmed',
          time: '',
          html: 'End of claim window.',
          listing: 326000,
          hasGuide: true,
          d: '2027-03-31',
        },
      ],
    };
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

    try {
      const requested: string[] = [];
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        requested.push(url);
        return json(url.startsWith('https://aa.test/events') ? eventsPayload : calendarPayload);
      }) as unknown as typeof fetch;

      const feed = await fetchAirdropAlertAirdrops('https://aa.test/calendar', NOW, 'https://aa.test/events?y=2026&m=11&radius=2');
      expect(requested).toEqual(['https://aa.test/calendar', 'https://aa.test/events?y=2026&m=11&radius=2']);
      expect(feed.cards.map(c => c.n)).toEqual(['StandX']);
      expect(feed.counts).toEqual({ active: 1, preToken: 1 });
      // Calendar `date_gmt` is the publish time; the joined event supplies the real event date.
      expect(feed.tge.map(t => [t.n, t.d])).toEqual([
        ['StandX claim ends', '2027-03-31'],
        ['Treehouse S2 Claim', '2026-11-16'],
      ]);

      // Events endpoint down or malformed: the calendar rail still ships with zero cards.
      for (const broken of [() => json({ code: 'rest_forbidden' }, 503), () => new Response('<html>blocked</html>', { status: 200 }), () => json({ events: 'garbage' })]) {
        requested.length = 0;
        globalThis.fetch = (async (input: RequestInfo | URL) =>
          String(input).startsWith('https://aa.test/events') ? broken() : json(calendarPayload)) as unknown as typeof fetch;
        const calendarOnly = await fetchAirdropAlertAirdrops('https://aa.test/calendar', NOW, 'https://aa.test/events');
        expect(calendarOnly.cards).toEqual([]);
        expect(calendarOnly.tge.map(t => t.d)).toEqual(['2026-11-09', '2026-11-16']);
      }

      // Calendar endpoint down: the source still fails even when events work, so prior cards are preserved.
      globalThis.fetch = (async (input: RequestInfo | URL) =>
        String(input).startsWith('https://aa.test/events') ? json(eventsPayload) : json({ code: 'rest_forbidden' }, 503)) as unknown as typeof fetch;
      await expect(fetchAirdropAlertAirdrops('https://aa.test/calendar', NOW, 'https://aa.test/events')).rejects.toThrow(/HTTP 503/);
    } finally {
      globalThis.fetch = prevFetch;
    }
  });

  test('Galxe curated cards keep only high-signal verified campaigns and surface description, reward, deadline and verified project domain', () => {
    const hour = 3_600_000;
    const space = (overrides: Record<string, unknown>) => ({
      id: '85886',
      name: 'Asterium',
      alias: 'Asterium',
      isVerified: true,
      followersCount: 178_831,
      thumbnail: 'https://appeco.galxe.com/space/logo/a.jpeg',
      info: 'Fintech ecosystem powering the HUMO bond token.',
      links: '{"Discord":"https://discord.gg/uQZ","HomePage":"https://asterium.uz/en","Telegram":"@asterium"}',
      ...overrides,
    });
    const campaign = (overrides: Record<string, unknown>) => ({
      id: 'GCdaHtZYGx',
      name: 'Hop in the DeLorean. Win $50 USDT with Asterium',
      status: 'Active',
      startTime: Math.floor((NOW - 3 * hour) / 1000),
      endTime: Math.floor((NOW + 5 * hour) / 1000),
      chain: 'BSC',
      type: 'Token',
      description: '![IMG_5744.jpg](https://appeco.galxe.com/mdresource/img.jpeg)\n\nFollow Asterium, join community, and enter 50 USDT raffle.',
      participants: { participantsCount: 2153 },
      rewardName: '',
      tokenReward: { tokenSymbol: 'USDT' },
      space: space({}),
      ...overrides,
    });

    const feed = parseGalxeCampaignsToAirdropFeed(
      {
        data: {
          campaigns: {
            list: [
              campaign({}),
              campaign({ id: 'GCuPbtZ1Z3', name: 'Think Gold. Win $50 USDT' }),
              // Third campaign of the same space is dropped by the per-space cap.
              campaign({ id: 'GCthird', name: 'Third Asterium campaign' }),
              campaign({
                id: 'GCinfinit',
                name: 'Season 2 points',
                type: 'Points',
                endTime: null,
                rewardName: '',
                tokenReward: null,
                description:
                  '# Season 2\n\n**Join INFINIT** points on [Galxe](https://app.galxe.com/x).\n\n![banner](https://appeco.galxe.com/b.png)',
                participants: { participantsCount: 6233 },
                space: space({
                  id: '1',
                  name: 'INFINIT',
                  alias: 'Infinit_Labs',
                  followersCount: 159_401,
                  info: 'Leverage yield protocol.',
                  links: '{"HomePage":"https://infinit.tech/","Twitter":"https://twitter.com/Infinit_Labs"}',
                }),
              }),
              // Low-follower and low-participation spaces are spam risk.
              campaign({ id: 'GCendo', participants: { participantsCount: 50_000 }, space: space({ followersCount: 196 }) }),
              campaign({ id: 'GCfew', participants: { participantsCount: 12 }, space: space({ followersCount: 159_401 }) }),
              campaign({ id: 'GCnopart', participants: null, space: space({ followersCount: 159_401 }) }),
              campaign({ id: 'GCunverified', space: space({ isVerified: false, followersCount: 900_000 }) }),
              campaign({ id: 'GCexpired', status: 'Expired' }),
              campaign({ id: 'GCended', endTime: Math.floor((NOW - hour) / 1000) }),
              campaign({ id: 'GCfuture', startTime: Math.floor((NOW + 48 * hour) / 1000) }),
              campaign({ id: 'GCparent', type: 'Parent' }),
              campaign({ id: 'GCrole', type: 'DiscordRole' }),
              campaign({ id: 'GCbadname', name: '' }),
              // Platform / broken HomePage falls back to the quest link with no verified domain.
              campaign({
                id: 'GCplat',
                participants: { participantsCount: 4000 },
                description: '',
                space: space({
                  id: '77',
                  name: 'Plat Space',
                  alias: 'plat',
                  info: 'Plat protocol on BNB Chain.',
                  links: '{"HomePage":"https://galxe.com/plat"}',
                  thumbnail: 'http://insecure.example/a.png',
                }),
              }),
              campaign({
                id: 'GCbrokenlinks',
                participants: { participantsCount: 3500 },
                description: null,
                space: space({ id: '78', name: 'Broken Links', alias: 'brokenlinks', links: 'not json', info: null }),
              }),
              null,
              'not-a-campaign',
            ],
          },
        },
      },
      NOW,
    );

    // Sorted by participation: INFINIT (6233), Plat Space (4000), Broken Links (3500), Asterium (2153, best two of three).
    expect(feed.cards.map(c => c.n)).toEqual(['INFINIT', 'Plat Space', 'Broken Links', 'Asterium', 'Asterium']);
    expect(feed.counts).toEqual({ active: 5, preToken: 5 });
    expect(feed.cards.some(c => ['Endorphina', 'Parent', 'DiscordRole'].includes(c.n))).toBe(false);

    const infinit = feed.cards[0];
    expect(infinit.id).toBe('galxe:1');
    expect(infinit.source).toBe('Galxe');
    expect(infinit.url).toBe('https://infinit.tech/');
    expect(infinit.verifiedDomain).toBe(true);
    expect(infinit.deadline).toBeUndefined();
    expect(infinit.apy).toBeUndefined();
    expect(infinit.rewardPool).toBe('Points');
    // Markdown heading, bold, link and image reduced to plain prose.
    expect(infinit.description).toBe('Season 2 Join INFINIT points on Galxe.');
    expect(infinit.best.ty).toBe('points');
    expect(infinit.tasks?.[0]).toMatchObject({ type: 'points', status: 'OPEN', cost: 0, url: 'https://app.galxe.com/quest/Infinit_Labs/GCinfinit' });
    expect(infinit.g).toBe('A');

    const plat = feed.cards[1];
    expect(plat.url).toBe('https://app.galxe.com/quest/plat/GCplat');
    expect(plat.verifiedDomain).toBeUndefined();
    expect(plat.img).toBe('');
    // Empty campaign description falls back to the space blurb.
    expect(plat.description).toBe('Plat protocol on BNB Chain.');

    const broken = feed.cards[2];
    expect(broken.url).toBe('https://app.galxe.com/quest/brokenlinks/GCbrokenlinks');
    expect(broken.verifiedDomain).toBeUndefined();
    expect(broken.description).toBeUndefined();

    const asterium = feed.cards[3];
    // Two cards of one space share one stable id so the merge step folds them into a single project card.
    expect(asterium.id).toBe('galxe:85886');
    expect(feed.cards[4].id).toBe('galxe:85886');
    expect(asterium.url).toBe('https://asterium.uz/en');
    expect(asterium.verifiedDomain).toBe(true);
    expect(asterium.img).toBe('https://appeco.galxe.com/space/logo/a.jpeg');
    // Markdown image stripped, prose kept.
    expect(asterium.description).toBe('Follow Asterium, join community, and enter 50 USDT raffle.');
    expect(asterium.rewardPool).toBe('USDT rewards');
    expect(asterium.deadline).toBe(fmtIsoDate(NOW + 5 * hour));
    expect(asterium.chain).toBe('BNB');
    expect(asterium.tasks?.[0]).toMatchObject({ type: 'quest', url: 'https://app.galxe.com/quest/Asterium/GCdaHtZYGx' });
    expect(asterium.g).toBe('B');
    expect(FORBIDDEN_CJK_RE.test(JSON.stringify(feed))).toBe(false);

    // Malformed GraphQL envelopes never throw.
    for (const malformed of [null, undefined, 42, 'x', {}, { data: null }, { data: { campaigns: null } }, { data: { campaigns: { list: 'x' } } }]) {
      expect(parseGalxeCampaignsToAirdropFeed(malformed, NOW).cards).toEqual([]);
    }
  });

  test('fetchGalxeCampaignsToAirdropFeed resolves with zero cards when nothing passes the gate but throws on GraphQL errors', async () => {
    const prevFetch = globalThis.fetch;
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    try {
      globalThis.fetch = (async () => json({ data: { campaigns: { list: [{ id: 'GCx', name: 'Quiet', space: { isVerified: true, followersCount: 12 } }] } } })) as unknown as typeof fetch;
      const quiet = await fetchGalxeCampaignsToAirdropFeed('https://galxe.test/query', NOW);
      expect(quiet.cards).toEqual([]);

      globalThis.fetch = (async () => json({ errors: [{ message: 'rate limited' }], data: null })) as unknown as typeof fetch;
      await expect(fetchGalxeCampaignsToAirdropFeed('https://galxe.test/query', NOW)).rejects.toThrow(/Galxe GraphQL/i);

      globalThis.fetch = (async () => json({ errors: [{ message: 'Invalid request.' }] })) as unknown as typeof fetch;
      await expect(fetchGalxeCampaignsToAirdropFeed('https://galxe.test/query', NOW)).rejects.toThrow(/Invalid request/);
    } finally {
      globalThis.fetch = prevFetch;
    }
  });
});
