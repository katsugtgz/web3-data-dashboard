import { describe, expect, test } from 'bun:test';
import type { FeedItem, SourceHealth } from '../../shared/types';
import {
  dedupeFeedSources,
  formatFeedSummary,
  formatProjectTitle,
  formatRiskReasons,
  formatSourceHandle,
  formatSourcesSummary,
  prepareFeedLinks,
} from './feedDisplay';

function makeItem(over: Partial<FeedItem> = {}): FeedItem {
  const now = 1_795_364_909_000;
  return {
    id: 'test-id',
    project: 'Sample',
    chains: [],
    taskTypes: ['quest'],
    summary: 'Complete testnet tasks to qualify.',
    links: [],
    sources: [],
    sourceCount: 1,
    score: 0.5,
    risk: { level: 'ok', reasons: [] },
    firstSeen: now,
    lastSeen: now,
    ...over,
  };
}

describe('formatProjectTitle', () => {
  test('strips leading wire prefixes and stray punctuation while preserving brand casing', () => {
    expect(formatProjectTitle('*HUANG')).toBe('HUANG');
    expect(formatProjectTitle('  ### Opensea  ')).toBe('Opensea');
    expect(formatProjectTitle('• MagicBlock')).toBe('MagicBlock');
    expect(formatProjectTitle('— ZXOXO:')).toBe('ZXOXO');
    expect(formatProjectTitle('   ')).toBe('Web3 Project');
  });
});

describe('dedupeFeedSources', () => {
  test('deduplicates repeated postUrl entries keeping first occurrence and trims whitespace', () => {
    const sources: FeedItem['sources'] = [
      { platform: 'telegram', handle: 'alpha_ch', postUrl: 'https://t.me/alpha_ch/101', postedAt: 1000 },
      { platform: 'telegram', handle: 'alpha_ch', postUrl: 'https://t.me/alpha_ch/101', postedAt: 2000 },
      { platform: 'telegram', handle: 'alpha_ch', postUrl: '  https://t.me/alpha_ch/101  ', postedAt: 3000 },
      { platform: 'telegram', handle: 'empty_ch', postUrl: '   ', postedAt: 3500 },
      { platform: 'x', handle: 'project_x', postUrl: ' https://x.com/project_x/status/42 ', postedAt: 4000 },
    ];

    expect(dedupeFeedSources(sources)).toEqual([
      { platform: 'telegram', handle: 'alpha_ch', postUrl: 'https://t.me/alpha_ch/101', postedAt: 1000 },
      { platform: 'x', handle: 'project_x', postUrl: 'https://x.com/project_x/status/42', postedAt: 4000 },
    ]);
  });

  test('rejects unsafe, credentialed, and whitespace/newline postUrl entries cleanly', () => {
    const sources: FeedItem['sources'] = [
      { platform: 'feed', handle: 'xss', postUrl: 'javascript:alert(1)', postedAt: 1000 },
      { platform: 'feed', handle: 'data', postUrl: 'data:text/html,<h1>hi</h1>', postedAt: 1100 },
      { platform: 'x', handle: 'cred', postUrl: 'https://user:pass@x.com/status/1', postedAt: 1200 },
      { platform: 'telegram', handle: 'nl', postUrl: 'https://t.me/alpha_ch/1\n## Override', postedAt: 1300 },
      { platform: 'sheet', handle: 'space', postUrl: 'https://docs.google.com/spreadsheets/d/1 bad', postedAt: 1400 },
      { platform: 'feed', handle: 'substack', postUrl: 'https://threadingontheedge.substack.com/p/alpha', postedAt: 1500 },
      { platform: 'feed', handle: 'substack', postUrl: '  https://threadingontheedge.substack.com/p/alpha  ', postedAt: 1600 },
    ];

    expect(dedupeFeedSources(sources)).toEqual([
      {
        platform: 'feed',
        handle: 'substack',
        postUrl: 'https://threadingontheedge.substack.com/p/alpha',
        postedAt: 1500,
      },
    ]);
  });
});

describe('prepareFeedLinks', () => {
  test('collapses referral params, http/https twins, and x.com share params on Getclocked', () => {
    const item = makeItem({
      domain: 'getclocked.com',
      links: [
        { url: 'https://getclocked.com/', known: false },
        { url: 'https://x.com/getclocked/status/2120575879177032073', known: false },
        { url: 'https://getclocked.com/?ref=RDJ9H8', known: false },
        { url: 'http://getclocked.com/?ref=HQAKP9', known: false },
        { url: 'https://x.com/getclocked/status/2120575879177032073?a=GAOm2kwYKWBENZwiNNc&s=20', known: false },
        { url: 'http://getclocked.com/?ref=75372W', known: false },
      ],
    });

    const links = prepareFeedLinks(item);
    expect(links).toHaveLength(2);
    expect(links[0]).toEqual({
      url: 'https://getclocked.com/',
      label: 'getclocked.com',
      known: false,
    });
    expect(links[1]).toEqual({
      url: 'https://x.com/getclocked/status/2120575879177032073',
      label: 'x.com/@getclocked',
      known: false,
    });
  });

  test('disambiguates multiple Coindesk article URLs and avoids duplicate pill labels', () => {
    const item = makeItem({
      domain: 'coindesk.com',
      links: [
        { url: 'https://www.coindesk.com/markets/2026/11/20/here-s-what-s-crashing-gold-and-likely-weighing-on-bitcoin-too', known: false },
        { url: 'https://www.coindesk.com/policy/2026/11/20/ecb-s-largarde-warns-europe-could-lose-control-of-growing-tokenized-asset-market', known: false },
        { url: 'https://www.coindesk.com/business/2026/11/19/north-korean-hackers-used-sky-s-stablecoin-system-putting-billions-at-freeze-risk', known: false },
        { url: 'https://cointelegraph.com/markets/blackrock-bitcoin-etf-ibit-outflows-nine-day-streak', known: false },
      ],
    });

    const links = prepareFeedLinks(item);
    expect(links).toHaveLength(3);
    const labels = links.map(l => l.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.some(l => l.startsWith('coindesk.com/'))).toBe(true);
    expect(labels.some(l => l.startsWith('cointelegraph.com'))).toBe(true);
  });

  test('disambiguates actionable same-host paths, collection slugs, and hash sections', () => {
    const pixelora = prepareFeedLinks(
      makeItem({
        domain: 'pixelora.fun',
        links: [
          { url: 'https://pixelora.fun/checker', known: false },
          { url: 'https://pixelora.fun/whitelist', known: false },
          { url: 'https://x.com/playpixelora/status/2119097135811735623', known: false },
        ],
      }),
    );
    expect(pixelora.map(l => l.label)).toEqual([
      'pixelora.fun/checker',
      'pixelora.fun/whitelist',
      'x.com/@playpixelora',
    ]);

    const opensea = prepareFeedLinks(
      makeItem({
        domain: 'opensea.io',
        links: [
          { url: 'https://opensea.io/collection/enter-elysium/overview', known: true },
          { url: 'https://opensea.io/collection/official-rebelkin/overview', known: true },
        ],
      }),
    );
    expect(new Set(opensea.map(l => l.label)).size).toBe(2);

    const trippi = prepareFeedLinks(
      makeItem({
        domain: 'trippi.fun',
        links: [
          { url: 'https://trippi.fun/#walletchecker', known: false },
          { url: 'https://trippi.fun/#quest', known: false },
        ],
      }),
    );
    expect(trippi.map(l => l.label)).toEqual([
      'trippi.fun/#walletchecker',
      'trippi.fun/#quest',
    ]);
  });

  test('drops referral-path dupes when canonical host link exists (Make.fun)', () => {
    const links = prepareFeedLinks(
      makeItem({
        domain: 'make.fun',
        links: [
          { url: 'https://make.fun/r/yx3n09hc', known: false },
          { url: 'http://make.fun/', known: false },
          { url: 'https://make.fun/r/djg390yy', known: false },
          { url: 'https://make.fun/guide/make-money-with-ai-agents', known: false },
          { url: 'https://make.fun/', known: false },
        ],
      }),
    );
    expect(links.map(l => l.url)).toEqual([
      'https://make.fun/',
      'https://make.fun/guide/make-money-with-ai-agents',
    ]);
    expect(new Set(links.map(l => l.label)).size).toBe(2);
  });

  test('filters self-source t.me, bare t.me, private t.me/c, linktr.ee bio, raw IP, x.com/search, and truncated URLs', () => {
    const tokenops = prepareFeedLinks(
      makeItem({
        domain: 'tokenops.xyz',
        sources: [{ platform: 'telegram', handle: 'atoms_research', postUrl: 'https://t.me/atoms_research/12212', postedAt: 1 }],
        links: [
          { url: 'https://t.me/atoms_research/12171', known: false },
          { url: 'https://claim.tokenops.xyz/p/lab', known: false },
          { url: 'https://t.me/atoms_research/12173', known: false },
          { url: 'https://airdrop.intuition.systems/', known: false },
          { url: 'https://points.zkverify.io/proofpoints2', known: false },
        ],
      }),
    );
    expect(tokenops.map(l => l.label)).toEqual([
      'claim.tokenops.xyz',
      'airdrop.intuition.systems',
      'points.zkverify.io',
    ]);

    const noisy = prepareFeedLinks(
      makeItem({
        domain: 'galxe.com',
        sources: [{ platform: 'telegram', handle: 'atoms_research', postUrl: 'https://t.me/atoms_research/12204', postedAt: 1 }],
        links: [
          { url: 'https://t.me/', known: false },
          { url: 'https://t.me/c/2082220326/430628', known: false },
          { url: 'https://t.me/atoms_research?boost', known: false },
          { url: 'http://t.me/atoms_chat', known: false },
          { url: 'http://1.1.1.1/', known: false },
          { url: 'https://linktr.ee/some_channel', known: false },
          { url: 'https://x.com/search?q=%24ZXO&amp;src=cashtag_click', known: false },
          { url: 'https://x.com/T%E2%80%A6lumayan', known: false },
          { url: 'https://discord.gg/acepyr%E2%80%A6Musang:', known: false },
          { url: 'https://x.com/voicecc/s%E2%80%A6Introducing', known: false },
          { url: 'https://app.galxe.com/sunset', known: true },
          { url: 'https://x.com/Galxe/status/2123644689928659380', known: false },
        ],
      }),
    );
    expect(noisy).toEqual([
      { url: 'https://app.galxe.com/sunset', label: 'app.galxe.com', known: true },
      { url: 'https://x.com/Galxe/status/2123644689928659380', label: 'x.com/@Galxe', known: false },
    ]);
  });

  test('decodes html entities, cleans trailing glued X share params, and collapses remaining t.me channels', () => {
    const decalabs = prepareFeedLinks(
      makeItem({
        domain: 'decalabs.ai',
        links: [
          { url: 'https://app.decalabs.ai/join?next=/rewards&amp;ref=rw7RV9nik3fiHfl2USqzkZpQ', known: false },
          { url: 'https://app.decalabs.ai/join?next=/rewards', known: false },
          { url: 'https://app.decalabs.ai/join/creator', known: false },
        ],
      }),
    );
    expect(decalabs.map(l => l.url)).toEqual([
      'https://app.decalabs.ai/join?next=%2Frewards',
      'https://app.decalabs.ai/join/creator',
    ]);

    const xGlued = prepareFeedLinks(
      makeItem({
        links: [
          { url: 'https://x.com/jaspervault/status/2121688834337542229?a=tc1HyU-9ZcTGFEIg2YA&s=19%F0%9F%8F%82', known: false },
          { url: 'https://x.com/ZeroGuysNFT/status/2120845780219232332?a=fdzivEwoj2FyTZecG7M&s=19Wallet', known: false },
          { url: 'https://x.com/RGB_Stone/status/2124855273265459430?s=19%F0%9F%94%88Update', known: false },
        ],
      }),
    );
    expect(xGlued.map(l => l.url)).toEqual([
      'https://x.com/jaspervault/status/2121688834337542229',
      'https://x.com/ZeroGuysNFT/status/2120845780219232332',
      'https://x.com/RGB_Stone/status/2124855273265459430',
    ]);
    expect(xGlued.map(l => l.label)).toEqual([
      'x.com/@jaspervault',
      'x.com/@ZeroGuysNFT',
      'x.com/@RGB_Stone',
    ]);

    const tgOnly = prepareFeedLinks(
      makeItem({
        links: [
          { url: 'https://t.me/ZoomerfiedNews/1631', known: false },
          { url: 'https://t.me/ZoomerfiedNews/1630', known: false },
          { url: 'https://t.me/ZoomerfiedNews/1629', known: false },
        ],
      }),
    );
    expect(tgOnly).toEqual([
      { url: 'https://t.me/ZoomerfiedNews/1631', label: 't.me/ZoomerfiedNews', known: false },
    ]);
  });

  test('never fabricates https or escalates known=false when deduplicating', () => {
    const httpOnly = prepareFeedLinks(
      makeItem({
        links: [{ url: 'http://example.com/task', known: true }],
      }),
    );
    expect(httpOnly).toEqual([
      { url: 'http://example.com/task', label: 'example.com', known: true },
    ]);

    const mixedKnown = prepareFeedLinks(
      makeItem({
        links: [
          { url: 'https://example.com/task', known: false },
          { url: 'http://example.com/task', known: true },
        ],
      }),
    );
    expect(mixedKnown).toEqual([
      { url: 'https://example.com/task', label: 'example.com', known: false },
    ]);
  });

  test('keeps separate campaign links and distinct labels for the same Telegram bot while grouping channel posts', () => {
    const botCampaigns = prepareFeedLinks(
      makeItem({
        links: [
          { url: 'https://t.me/ExampleBot?start=spring', known: false },
          { url: 'https://t.me/ExampleBot?start=summer', known: false },
          { url: 'https://t.me/SuperLongCampaignExampleBot?start=alpha', known: false },
          { url: 'https://t.me/SuperLongCampaignExampleBot?start=beta', known: false },
        ],
      }),
      { max: 6 },
    );
    expect(botCampaigns.map(l => l.url)).toEqual([
      'https://t.me/ExampleBot?start=spring',
      'https://t.me/ExampleBot?start=summer',
      'https://t.me/SuperLongCampaignExampleBot?start=alpha',
      'https://t.me/SuperLongCampaignExampleBot?start=beta',
    ]);
    expect(botCampaigns[0].label).toBe('t.me/ExampleBot?start=spring');
    expect(botCampaigns[1].label).toBe('t.me/ExampleBot?start=summer');
    expect(botCampaigns[2].label).toContain('?start=alpha');
    expect(botCampaigns[3].label).toContain('?start=beta');
    expect(new Set(botCampaigns.map(l => l.label)).size).toBe(4);
    for (const l of botCampaigns) {
      expect(l.label.length).toBeLessThanOrEqual(34);
    }

    const channelPosts = prepareFeedLinks(
      makeItem({
        links: [
          { url: 'https://t.me/AlphaChannel/101', known: false },
          { url: 'https://t.me/AlphaChannel/102', known: false },
        ],
      }),
    );
    expect(channelPosts).toEqual([
      { url: 'https://t.me/AlphaChannel/101', label: 't.me/AlphaChannel', known: false },
    ]);
  });

  test('drops referral path only when a clean equivalent action link exists on the same host', () => {
    const withDocs = prepareFeedLinks(
      makeItem({
        domain: 'example.com',
        links: [
          { url: 'https://example.com/join/AB12', known: false },
          { url: 'https://example.com/docs', known: false },
        ],
      }),
    );
    expect(withDocs.map(l => l.url)).toEqual([
      'https://example.com/join/AB12',
      'https://example.com/docs',
    ]);

    const withCleanJoin = prepareFeedLinks(
      makeItem({
        domain: 'example.com',
        links: [
          { url: 'https://example.com/join/AB12', known: false },
          { url: 'https://example.com/join', known: false },
        ],
      }),
    );
    expect(withCleanJoin.map(l => l.url)).toEqual(['https://example.com/join']);

    const refWithDocs = prepareFeedLinks(
      makeItem({
        domain: 'make.fun',
        links: [
          { url: 'https://make.fun/r/yx3n09hc', known: false },
          { url: 'https://make.fun/docs', known: false },
        ],
      }),
    );
    expect(refWithDocs.map(l => l.url)).toEqual([
      'https://make.fun/r/yx3n09hc',
      'https://make.fun/docs',
    ]);
  });

  test('strips extended referral/tracking params and Substack r param while keeping non-Substack r', () => {
    const links = prepareFeedLinks(
      makeItem({
        links: [
          {
            url: 'https://app.galxe.com/quest/abc?referralcode=A1&referral_code=A2&refcode=B1&ref_code=B2&inviter=u1&aff_id=9&via=partner&igshid=ig1&si=yt1',
            known: true,
          },
          { url: 'https://definvestor.substack.com/p/airdrop-alpha?r=2x9abc&utm_medium=email', known: false },
          { url: 'https://airdropalert.com/airdrops/monad?r=keepme&via=rss', known: false },
        ],
      }),
      { max: 4 },
    );
    expect(links.map(l => l.url)).toEqual([
      'https://app.galxe.com/quest/abc',
      'https://definvestor.substack.com/p/airdrop-alpha',
      'https://airdropalert.com/airdrops/monad?r=keepme',
    ]);
  });

  test('disambiguates multiple long-host Substack /p/<slug> links without dropping the second link', () => {
    const shortSlugs = prepareFeedLinks(
      makeItem({
        domain: 'threadingontheedge.substack.com',
        links: [
          { url: 'https://threadingontheedge.substack.com/p/solana-airdrop-guide?r=abc123', known: false },
          { url: 'https://threadingontheedge.substack.com/p/monad-testnet-tasks?r=def456', known: false },
        ],
      }),
      { max: 4 },
    );
    expect(shortSlugs.map(l => l.url)).toEqual([
      'https://threadingontheedge.substack.com/p/solana-airdrop-guide',
      'https://threadingontheedge.substack.com/p/monad-testnet-tasks',
    ]);
    expect(new Set(shortSlugs.map(l => l.label)).size).toBe(2);
    for (const l of shortSlugs) {
      expect(l.label.length).toBeLessThanOrEqual(34);
    }

    const sharedPrefixSlugs = prepareFeedLinks(
      makeItem({
        domain: 'threadingontheedge.substack.com',
        links: [
          { url: 'https://threadingontheedge.substack.com/p/weekly-airdrop-roundup-issue-41', known: false },
          { url: 'https://threadingontheedge.substack.com/p/weekly-airdrop-roundup-issue-42', known: false },
        ],
      }),
      { max: 4 },
    );
    expect(sharedPrefixSlugs.map(l => l.url)).toEqual([
      'https://threadingontheedge.substack.com/p/weekly-airdrop-roundup-issue-41',
      'https://threadingontheedge.substack.com/p/weekly-airdrop-roundup-issue-42',
    ]);
    expect(sharedPrefixSlugs[0].label).toContain('41');
    expect(sharedPrefixSlugs[1].label).toContain('42');
    expect(new Set(sharedPrefixSlugs.map(l => l.label)).size).toBe(2);
    for (const l of sharedPrefixSlugs) {
      expect(l.label.length).toBeLessThanOrEqual(34);
    }
  });

  test('keeps all distinct selected same-host links with unique labels under max length when long paths differ in multiple positions', () => {
    const a40 = 'a'.repeat(40);
    const z40 = 'z'.repeat(40);
    const sixUrls = [
      `https://example.com/p/alpha-${a40}x${z40}`,
      `https://example.com/p/alpha-${a40}y${z40}`,
      `https://example.com/p/bravo-${a40}x${z40}`,
      `https://example.com/p/bravo-${a40}y${z40}`,
      `https://example.com/p/delta-${a40}x${z40}`,
      `https://example.com/p/delta-${a40}y${z40}`,
    ];
    const links = prepareFeedLinks(
      makeItem({
        domain: 'example.com',
        links: sixUrls.map(url => ({ url, known: false })),
      }),
      { max: 8 },
    );
    expect(links.map(l => l.url)).toEqual(sixUrls);
    expect(new Set(links.map(l => l.label.toLowerCase())).size).toBe(6);
    for (const l of links) {
      expect(l.label.length).toBeLessThanOrEqual(34);
    }

    // Secondary query-parameter differences on identical paths also stay distinct without dropping links.
    const queryUrls = [
      'https://example.com/app/campaign?tab=quests&step=1',
      'https://example.com/app/campaign?tab=quests&step=2',
      'https://example.com/app/campaign?tab=quests&step=3',
    ];
    const qLinks = prepareFeedLinks(
      makeItem({
        domain: 'example.com',
        links: queryUrls.map(url => ({ url, known: false })),
      }),
      { max: 6 },
    );
    expect(qLinks.map(l => l.url)).toEqual(queryUrls);
    expect(new Set(qLinks.map(l => l.label.toLowerCase())).size).toBe(3);
    for (const l of qLinks) {
      expect(l.label.length).toBeLessThanOrEqual(34);
    }
  });
});

describe('formatRiskReasons', () => {
  test('groups repeated plain-http warnings on single and multiple hosts into one concise note', () => {
    const pump = formatRiskReasons(
      makeItem({
        domain: 'pump.fun',
        risk: {
          level: 'warn',
          reasons: [
            'Domain not in verified registry: pump.fun',
            'Insecure transport (plain http): http://pump.fun/',
            'Insecure transport (plain http): http://pump.fun/join/Miftaiky',
            'Insecure transport (plain http): http://pump.fun/join/Miftaikyif',
          ],
        },
      }),
    );
    expect(pump.map(n => n.text)).toEqual([
      'Domain not in verified registry: pump.fun',
      'Plain HTTP links detected: pump.fun (3 links)',
    ]);

    const theblock = formatRiskReasons(
      makeItem({
        domain: 'theblock.co',
        risk: {
          level: 'warn',
          reasons: [
            'Domain not in verified registry: theblock.co',
            'Insecure transport (plain http): http://delpho.xyz/',
            'Insecure transport (plain http): http://elysium.kinetiq.xyz/',
            'Insecure transport (plain http): http://gravityblocks.xyz/',
            'Insecure transport (plain http): http://intrinsictech.com/',
            'Insecure transport (plain http): http://ledger.com/',
            'Insecure transport (plain http): http://mezz.finance/',
            'Insecure transport (plain http): http://mori.finance/',
            'Insecure transport (plain http): http://variational.io/',
          ],
        },
      }),
    );
    expect(theblock.map(n => n.text)).toEqual([
      'Domain not in verified registry: theblock.co',
      'Plain HTTP links detected: delpho.xyz, elysium.kinetiq.xyz (+6 more domains)',
    ]);
  });

  test('suppresses stale unverified-domain warning and benign DNS raw IP on WARN, but keeps non-DNS raw IP warnings visible', () => {
    const cookie = formatRiskReasons(
      makeItem({
        domain: 'cookie.fun',
        links: [{ url: 'https://pro.cookie.fun/infofi-early-access', known: true }],
        risk: {
          level: 'warn',
          reasons: ['Domain not in verified registry: cookie.fun'],
        },
      }),
    );
    expect(cookie).toEqual([]);

    const acepyr = formatRiskReasons(
      makeItem({
        risk: {
          level: 'warn',
          reasons: [
            'Insecure transport (plain http): http://1.1.1.1/',
            'Insecure transport (plain http): http://8.8.8.8/',
          ],
        },
      }),
    );
    expect(acepyr).toEqual([]);

    const phishingWarn = formatRiskReasons(
      makeItem({
        risk: {
          level: 'warn',
          reasons: [
            'Insecure transport (plain http): http://45.33.12.9/claim',
            'Raw IP link: 45.33.12.9',
          ],
        },
      }),
    );
    expect(phishingWarn.map(n => n.text)).toEqual([
      'Insecure transport (plain http): http://45.33.12.9/claim',
      'Raw IP link: 45.33.12.9',
    ]);

    const mixedWarn = formatRiskReasons(
      makeItem({
        risk: {
          level: 'warn',
          reasons: [
            'Insecure transport (plain http): http://alpha.xyz/',
            'Insecure transport (plain http): http://beta.xyz/',
            'Insecure transport (plain http): http://gamma.xyz/',
            'Insecure transport (plain http): http://45.33.12.9/claim',
          ],
        },
      }),
    );
    expect(mixedWarn.map(n => n.text)).toEqual([
      'Insecure transport (plain http): http://45.33.12.9/claim',
      'Plain HTTP links detected: alpha.xyz, beta.xyz (+1 more domains)',
    ]);
  });

  test('keeps all safety notes intact (deduped) for RISK items', () => {
    const notes = formatRiskReasons(
      makeItem({
        domain: 'evil.io',
        links: [{ url: 'https://evil.io/claim', known: true }],
        risk: {
          level: 'risk',
          reasons: [
            'Drainer phrasing detected',
            'Domain not in verified registry: evil.io',
            'Raw IP link: 45.33.12.9',
            'Drainer phrasing detected',
          ],
        },
      }),
    );
    expect(notes.map(n => n.text)).toEqual([
      'Drainer phrasing detected',
      'Domain not in verified registry: evil.io',
      'Raw IP link: 45.33.12.9',
    ]);
  });
});

describe('formatFeedSummary', () => {
  test('cleans wire tails, channel footers, dangling labels, and mid-word truncation', () => {
    const ct = formatFeedSummary(
      'REGULATION: The ECB is recruiting groups of banks and financial firms to test tokenized deposits under Appia. News | Markets | YouTube',
    );
    expect(ct.lead).toBe(
      'REGULATION: The ECB is recruiting groups of banks and financial firms to test tokenized deposits under Appia.',
    );

    const coindesk = formatFeedSummary(
      'Binance Futures adds JNJ, AMDL and NIO perpetuals with up to 20x leverage – Link Binance is launching three new USDT-margined TradFi perpetuals today: JNJUSDT at 17:30, AMDLUSDT at 17:35 and NIOUSD…',
    );
    expect(coindesk.lead).not.toContain('– Link');
    expect(coindesk.lead).not.toContain('NIOUSD…');
    expect(coindesk.lead).toBe(
      'Binance Futures adds JNJ, AMDL and NIO perpetuals with up to 20x leverage. Binance is launching three new USDT-margined TradFi perpetuals today: JNJUSDT at 17:30, AMDLUSDT at 17:35…',
    );

    const wg = formatFeedSummary(
      "JUST IN: Top Democrat threatens to cut funding for SpaceX $SPCX. 📰 @WatcherGuru",
    );
    expect(wg.lead).toBe("JUST IN: Top Democrat threatens to cut funding for SpaceX $SPCX.");

    const voice = formatFeedSummary('Voice Seat FCFS, submit address sol voice 💬 ➡️ New Vote 👋 ➡️');
    expect(voice.lead).not.toMatch(/➡️\s*$/);
  });

  test('deduplicates exact doubled summaries and fixes double-truncated ellipses', () => {
    expect(formatFeedSummary('Check Reward Make FunCheck Reward Make Fun').lead).toBe(
      'Check Reward Make Fun',
    );
    const shortCut = formatFeedSummary('Alpha project launches testnet campaign for early testers Hol...');
    expect(shortCut.lead).toBe('Alpha project launches testnet campaign for early testers…');

    const doubleCut = formatFeedSummary('TopNod Free Daily Spin Disclaimer: Gue blm…C…');
    expect(doubleCut.lead).not.toContain('…C…');
    expect(doubleCut.lead).toBe('TopNod Free Daily Spin Disclaimer: Gue…');
  });

  test('extracts squashed inline bullets into structured steps, fixes Done#Update, and drops Done/Source noise', () => {
    const cookie = formatFeedSummary(
      'New Waitlist : Cookie Pro Early Access 🪂 Register : ➖ Connect Your X Account ➖ Complete All Task ➖ Submit Your Email ➖ Done 📖 Source:',
    );
    expect(cookie.lead).toBe('New Waitlist: Cookie Pro Early Access 🪂');
    expect(cookie.bullets).toEqual([
      'Connect Your X Account',
      'Complete All Task',
      'Submit Your Email',
    ]);

    const clocked = formatFeedSummary(
      'Clocked Waitlist ✨LFG: getclocked.com/?ref=HQAKP9 • Login with x/email • Claim Username • Done Rewards Pool $100k Trading Competition on Testnet',
    );
    expect(clocked.lead).not.toContain('ref=HQAKP9');
    expect(clocked.bullets).toEqual([
      'Login with x/email',
      'Claim Username',
      'Rewards Pool $100k Trading Competition on Testnet',
    ]);

    const pudgy = formatFeedSummary(
      'Free Pudgy Penguin SBT on Revoke.cash ☕️ Open Revoke.cash ☕️ Complete All Task ☕️ Claim Soulbound ☕️ Done#Update The Pudgy Penguin migration is live.',
    );
    expect(pudgy.bullets).toEqual([
      'Open Revoke.cash',
      'Complete All Task',
      'Claim Soulbound',
      '#Update The Pudgy Penguin migration is live.',
    ]);
  });

  test('splits backend middle-dot bullet summaries into structured steps while preserving single middle-dot prose', () => {
    const clockedBackend = formatFeedSummary(
      'Clocked Waitlist · Login with x/email · Claim Username · Done',
    );
    expect(clockedBackend).toEqual({
      lead: 'Clocked Waitlist',
      bullets: ['Login with x/email', 'Claim Username'],
      text: 'Clocked Waitlist · Login with x/email · Claim Username',
    });

    const singleDot = formatFeedSummary('Clocked Waitlist · Early access open now');
    expect(singleDot).toEqual({
      lead: 'Clocked Waitlist · Early access open now',
      bullets: [],
      text: 'Clocked Waitlist · Early access open now',
    });

    const tightDots = formatFeedSummary('Tokenomics v1·2·3 live on Base testnet.');
    expect(tightDots).toEqual({
      lead: 'Tokenomics v1·2·3 live on Base testnet.',
      bullets: [],
      text: 'Tokenomics v1·2·3 live on Base testnet.',
    });
  });

  test('strips bilingual Turkish duplicate segments (newline and wire formats) only when marked or identical duplicate', () => {
    const huangExplicit = formatFeedSummary(
      "*HUANG: NVIDIA CEO TELLS FT AI DEMAND REMAINS UNPRECEDENTED\n\nTR: Nvidia CEO Huang, FT'ye yapt\u0131\u011f\u0131 a\u00e7\u0131klamada yapay zeka talebinin g\u00fc\u00e7l\u00fc kald\u0131\u011f\u0131n\u0131 s\u00f6yledi.",
    );
    expect(huangExplicit.lead).toBe('HUANG: NVIDIA CEO TELLS FT AI DEMAND REMAINS UNPRECEDENTED');

    const wireExplicitMarker = formatFeedSummary(
      "*CLAIM OPENS ON NOVEMBER 30 *TR: Talep 30 Kas\u0131m'da a\u00e7\u0131l\u0131yor.",
    );
    expect(wireExplicitMarker.lead).toBe('CLAIM OPENS ON NOVEMBER 30');

    const explicitMarker = formatFeedSummary(
      'Claim opens on May 15.\nTR: Talep 15 May\u0131s tarihinde a\u00e7\u0131l\u0131yor.',
    );
    expect(explicitMarker.lead).toBe('Claim opens on May 15.');
  });

  test('preserves unique Turkish eligibility restrictions alongside English claim dates', () => {
    const multilineMixed = formatFeedSummary(
      'Claim opens on November 30.\nSadece KYC do\u011frulamas\u0131 yapan c\u00fczdanlar hak kazan\u0131r.',
    );
    expect(multilineMixed.lead).toContain('Claim opens on November 30.');
    expect(multilineMixed.lead).toContain('Sadece KYC');

    const sentenceMixed = formatFeedSummary(
      'Claim opens on November 30. Kat\u0131l\u0131m i\u00e7in en az 200 puan gerekiyor.',
    );
    expect(sentenceMixed.lead).toContain('Claim opens on November 30.');
    expect(sentenceMixed.lead).toContain('200 puan');

    const wireMixed = formatFeedSummary(
      '*CLAIM OPENS ON NOVEMBER 30 *Sadece KYC do\u011frulamas\u0131 yapan c\u00fczdanlar hak kazan\u0131r.',
    );
    expect(wireMixed.lead).toContain('CLAIM OPENS ON NOVEMBER 30');
    expect(wireMixed.lead).toContain('Sadece KYC');

    const wireWithUniqueEntity = formatFeedSummary(
      "*NVIDIA BOARD IS NOT CONSIDERING A SPLIT *Bir kaynak CNBC'ye bunun g\u00fcndemde olmad\u0131\u011f\u0131n\u0131 s\u00f6yledi.",
    );
    expect(wireWithUniqueEntity.lead).toContain('NVIDIA BOARD IS NOT CONSIDERING A SPLIT');
    expect(wireWithUniqueEntity.lead).toContain('CNBC');

    const wireSharedTokensRestriction = formatFeedSummary(
      "*BASE KYC CLAIM OPENS ON NOVEMBER 30 *Base KYC claim 30 Kas\u0131m'da sadece do\u011frulanm\u0131\u015f c\u00fczdanlara a\u00e7\u0131kt\u0131r.",
    );
    expect(wireSharedTokensRestriction.lead).toContain('BASE KYC CLAIM OPENS ON NOVEMBER 30');
    expect(wireSharedTokensRestriction.lead).toContain('sadece do\u011frulanm\u0131\u015f c\u00fczdanlara');
  });

  test('collapses excessive repeated alert emojis and keeps clean prose untouched', () => {
    const whale = formatFeedSummary(
      '🚨 🚨 🚨 🚨 🚨 🚨 127,745,921 $USDC transferred from Coinbase Institutional to Coinbase',
    );
    expect(whale.lead).toBe('🚨 127,745,921 $USDC transferred from Coinbase Institutional to Coinbase');

    const clean = formatFeedSummary('Run testnet interactions on Base and claim faucet tokens.');
    expect(clean.lead).toBe('Run testnet interactions on Base and claim faucet tokens.');
    expect(clean.bullets).toEqual([]);

    // Plain prose ending in "source", "link", or "register" without a colon stays intact.
    expect(formatFeedSummary('Verify the official source').lead).toBe('Verify the official source');
    expect(formatFeedSummary('Complete testnet tasks to register').lead).toBe('Complete testnet tasks to register');
    expect(formatFeedSummary('Open the verified link').lead).toBe('Open the verified link');
  });
});

describe('formatSourceHandle', () => {
  test('prefixes @ only for social platforms (telegram, x) and omits @ for sheet, feed, surf', () => {
    expect(formatSourceHandle('telegram', 'alpha_ch')).toBe('@alpha_ch');
    expect(formatSourceHandle('telegram', '@alpha_ch')).toBe('@alpha_ch');
    expect(formatSourceHandle('x', 'DefiIgnas')).toBe('@DefiIgnas');
    expect(formatSourceHandle('x', ' @OlimpioCrypto ')).toBe('@OlimpioCrypto');
    expect(formatSourceHandle('sheet', 'ASSO7878')).toBe('ASSO7878');
    expect(formatSourceHandle('feed', 'airdroptracker')).toBe('airdroptracker');
    expect(formatSourceHandle('surf', 'surf.computer')).toBe('surf.computer');
    expect(formatSourceHandle('feed', '  pendle-points  ')).toBe('pendle-points');
    expect(formatSourceHandle('telegram', '   ')).toBe('');
    expect(formatSourceHandle('telegram', '@@@')).toBe('');
    expect(formatSourceHandle(' x ', '  @@@  ')).toBe('');
    expect(formatSourceHandle(' telegram ', 'alpha_ch')).toBe('@alpha_ch');
    expect(formatSourceHandle(' X ', 'DefiIgnas')).toBe('@DefiIgnas');
    expect(formatSourceHandle(' Sheet ', 'ASSO7878')).toBe('ASSO7878');
    expect(formatSourceHandle('   ', 'custom')).toBe('custom');
  });
});

describe('formatSourcesSummary', () => {
  function makeSource(platform: string, status: SourceHealth['status'], id = `${platform}-1`): SourceHealth {
    return { id, platform, handle: id, status, lastOkAt: status === 'ok' ? 1_795_364_909_000 : null };
  }

  test('dynamically summarizes all present platforms in canonical order with status counts', () => {
    const sources: SourceHealth[] = [
      makeSource('telegram', 'ok', 'tg1'),
      makeSource('telegram', 'ok', 'tg2'),
      makeSource('x', 'degraded', 'x1'),
      makeSource('sheet', 'ok', 's1'),
      makeSource('sheet', 'ok', 's2'),
      makeSource('feed', 'ok', 'f1'),
      makeSource('feed', 'down', 'f2'),
      makeSource('surf', 'down', 'sf1'),
    ];
    expect(formatSourcesSummary(sources)).toBe(
      'TG 2 · X 1 · Sheets 2 · Feeds 2 · Surf 1 — 5 ok · 1 degraded · 2 down',
    );
  });

  test('omits absent platforms and handles empty and custom platforms cleanly', () => {
    expect(
      formatSourcesSummary([
        makeSource('telegram', 'ok', 'tg1'),
        makeSource('feed', 'ok', 'f1'),
      ]),
    ).toBe('TG 1 · Feeds 1 — 2 ok · 0 degraded · 0 down');

    expect(formatSourcesSummary([])).toBe('0 sources — 0 ok · 0 degraded · 0 down');

    expect(
      formatSourcesSummary([
        makeSource('x', 'down', 'x1'),
        makeSource('api', 'ok', 'a1'),
        makeSource(' Curated ', 'ok', 'c1'),
      ]),
    ).toBe('X 1 · Api 1 · Curated 1 — 2 ok · 0 degraded · 1 down');
  });
});
