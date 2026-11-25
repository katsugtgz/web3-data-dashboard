import { describe, expect, test } from 'bun:test';
import type { AirdropFeed, Card } from '../../shared/types';
import { FORBIDDEN_CJK_RE } from './helpers';
import { collectKnownDomainEntries } from '../src/safety';
import {
  backfillLegacyAirdropSources,
  buildCuratedAirdropFeed,
  extractDefiLlamaTokenlessAirdrops,
  filterAirdropFeedByDisabledSources,
  mergeCuratedAirdropFeeds,
} from '../src/sources/curated';

const NOW = Date.parse('2026-11-24T12:00:00Z');

function makeCard(overrides: Partial<Card> & { n: string }): Card {
  return {
    r: 1,
    t: null,
    g: 'A',
    b: ['live'],
    x: null,
    img: '',
    f: '—',
    raiseNum: 0,
    tk: '1/1',
    h: 100,
    u: 'today',
    fit: ['zero'],
    best: { n: 'Complete task', ty: 'testnet', c: 'Free', m: '5 min' },
    costNum: 0,
    taskTypes: ['testnet'],
    tasks: [{ title: 'Complete task', type: 'testnet', status: 'OPEN', cost: 0, timeMinutes: 5, url: null }],
    sc: 75,
    sub: [7, 8, null],
    url: null,
    ...overrides,
  };
}

describe('curated multi-source airdrop aggregator', () => {
  test('dedupes by canonical domain and normalized project name, preferring Surf tasks when Surf is online', () => {
    const surfFeed: AirdropFeed = {
      cards: [
        makeCard({
          n: 'HyperNova',
          id: 'surf-1',
          source: 'Surf',
          url: 'https://app.hypernova.xyz/quest',
          sc: 88,
          tasks: [
            { title: 'Surf rich task 1', type: 'testnet', status: 'OPEN', cost: 0, timeMinutes: 10, url: 'https://app.hypernova.xyz/quest' },
            { title: 'Surf rich task 2', type: 'social', status: 'OPEN', cost: 0, timeMinutes: 2, url: 'https://app.hypernova.xyz/social' },
          ],
          tk: '2/2',
        }),
      ],
      tge: [{ n: 'TokenX', t: 'TKX', s: 'Claimable', d: '2026-11-25', source: 'Surf' }],
      counts: { active: 1, preToken: 1 },
      fetchedAt: NOW,
    };

    const assoFeed: AirdropFeed = {
      cards: [
        // Same canonical domain as Surf's HyperNova -> must merge into Surf card and enrich missing raise!
        makeCard({
          n: 'HyperNova Protocol',
          id: 'asso7878:hypernova-protocol',
          source: 'ASSO7878',
          url: 'https://hypernova.xyz/',
          f: '$25.00M',
          raiseNum: 25_000_000,
          sc: 70,
        }),
        makeCard({
          n: 'UniqueSheetProj',
          id: 'asso7878:uniquesheetproj',
          source: 'ASSO7878',
          url: 'https://uniquesheet.io/',
          sc: 65,
        }),
      ],
      tge: [
        { n: 'TokenX', t: '', s: 'Token live', d: '2026-11-01', source: 'ASSO7878' },
        { n: 'LaunchedY', t: '', s: 'Token live', d: '2026-10-01', source: 'ASSO7878' },
      ],
      counts: { active: 2, preToken: 2 },
      fetchedAt: NOW,
    };

    const defiLlamaFeed: AirdropFeed = {
      cards: [
        makeCard({
          n: 'LlamaDeFi',
          id: 'defillama:llamadefi',
          source: 'DefiLlama',
          url: 'https://llamadefi.xyz/',
          sc: 60,
        }),
      ],
      tge: [],
      counts: { active: 1, preToken: 1 },
      fetchedAt: NOW,
    };

    const merged = mergeCuratedAirdropFeeds([surfFeed, assoFeed, defiLlamaFeed], NOW);
    expect(merged.cards.length).toBe(3);
    expect(merged.cards[0].r).toBe(1);
    expect(merged.cards[1].r).toBe(2);
    expect(merged.cards[2].r).toBe(3);

    const hn = merged.cards.find(c => c.n === 'HyperNova')!;
    expect(hn.source).toBe('Surf');
    expect(hn.tasks?.length).toBe(2);
    expect(hn.raiseNum).toBe(25_000_000);
    expect(hn.f).toBe('$25.00M');

    expect(merged.tge.length).toBe(2);
    expect(merged.tge.find(t => t.n === 'TokenX')?.source).toBe('Surf');

    // Known domain seeding covers Surf and non-sheet curated sources (DefiLlama),
    // while excluding editable third-party spreadsheets (ASSO7878 / arndxt).
    const known = collectKnownDomainEntries(merged, null);
    expect(known.some(k => k.domain === 'hypernova.xyz' && k.origin === 'surf')).toBe(true);
    expect(known.some(k => k.domain === 'llamadefi.xyz' && k.origin === 'curated')).toBe(true);
    expect(known.some(k => k.domain === 'uniquesheet.io')).toBe(false);
  });

  test('stays resilient via Promise.allSettled when Surf times out and still returns other sources', async () => {
    const result = await buildCuratedAirdropFeed({
      nowMs: NOW,
      fetchers: {
        surf: async () => {
          throw new Error('Surf timeout 15000ms');
        },
        asso7878: async () => ({
          cards: [makeCard({ n: 'SheetAlpha', source: 'ASSO7878', url: 'https://sheetalpha.xyz' })],
          tge: [],
          counts: { active: 1, preToken: 1 },
          fetchedAt: NOW,
        }),
        arndxt: async () => {
          throw new Error('temporary error');
        },
        pendle: async () => ({
          cards: [makeCard({ n: 'PendleProto', source: 'Pendle', url: 'https://app.pendle.finance/trade/markets/0x1' })],
          tge: [],
          counts: { active: 1, preToken: 1 },
          fetchedAt: NOW,
        }),
        merkl: async () => ({ cards: [], tge: [], counts: { active: 0, preToken: 0 }, fetchedAt: NOW }),
        airdropalert: async () => ({
          cards: [],
          tge: [{ n: 'Treehouse', t: 'TREE', s: 'Claimable', d: '2026-11-22', source: 'AirdropAlert' }],
          counts: { active: 0, preToken: 0 },
          fetchedAt: NOW,
        }),
      },
    });

    expect(result.feed.cards.length).toBe(2);
    expect(result.feed.tge.length).toBe(1);
    expect(result.outcomes.find(o => o.name === 'Surf')?.ok).toBe(false);
    expect(result.outcomes.find(o => o.name === 'ASSO7878')?.ok).toBe(true);
  });

  test('throws when every single curated source fails and still reports failure outcomes via onOutcomes', async () => {
    const fail = async () => {
      throw new Error('offline');
    };
    const recorded: { name: string; ok: boolean; sourceId?: string }[] = [];
    await expect(
      buildCuratedAirdropFeed({
        nowMs: NOW,
        onOutcomes: outcomes => {
          for (const o of outcomes) recorded.push({ name: o.name, ok: o.ok, sourceId: o.sourceId });
        },
        fetchers: { surf: fail, asso7878: fail, arndxt: fail, pendle: fail, merkl: fail, airdropalert: fail },
      }),
    ).rejects.toThrow();

    expect(recorded.length).toBe(6);
    expect(recorded.every(r => r.ok === false)).toBe(true);
    expect(recorded.some(r => r.sourceId === 'sheet:asso7878_sheet')).toBe(true);
    expect(recorded.some(r => r.sourceId === 'feed:pendle_points')).toBe(true);
  });

  test('extracts tokenless DefiLlama protocols (symbol === "-", TVL >= $5M, non-CEX) with zero CJK', () => {
    const raw = [
      { name: 'Variational', slug: 'variational', symbol: '-', category: 'Derivatives', chains: ['Arbitrum'], tvl: 120_000_000, listedAt: 1770000000, url: 'https://variational.io' },
      { name: 'HasToken', slug: 'hastoken', symbol: 'HTK', category: 'Dexes', chains: ['Ethereum'], tvl: 500_000_000, url: 'https://hastoken.io' },
      { name: 'TooSmall', slug: 'toosmall', symbol: '-', category: 'Lending', chains: ['Base'], tvl: 1_000_000, url: 'https://toosmall.io' },
      { name: 'SomeCEX', slug: 'somecex', symbol: '-', category: 'CEX', chains: ['Ethereum'], tvl: 900_000_000, url: 'https://cex.io' },
    ];
    const feed = extractDefiLlamaTokenlessAirdrops(raw, NOW);
    expect(FORBIDDEN_CJK_RE.test(JSON.stringify(feed))).toBe(false);
    expect(feed.cards.length).toBe(1);
    expect(feed.cards[0].n).toBe('Variational');
    expect(feed.cards[0].t).toBeNull();
    expect(feed.cards[0].source).toBe('DefiLlama');
    expect(feed.cards[0].g).toBe('S');
  });

  test('does not collapse multiple Pendle or Merkl cards sharing aggregator domains into one card', () => {
    const pendleFeed: AirdropFeed = {
      cards: [
        makeCard({ n: 'Ethena', id: 'pendle:ethena', source: 'Pendle', url: 'https://app.pendle.finance/trade/markets/0x1/swap?view=yt&chain=ethereum', sc: 84 }),
        makeCard({ n: 'Resolv', id: 'pendle:resolv', source: 'Pendle', url: 'https://app.pendle.finance/trade/markets/0x2/swap?view=yt&chain=ethereum', sc: 74 }),
        makeCard({ n: 'Level', id: 'pendle:level', source: 'Pendle', url: 'https://app.pendle.finance/trade/markets/0x3/swap?view=yt&chain=ethereum', sc: 60 }),
      ],
      tge: [],
      counts: { active: 3, preToken: 3 },
      fetchedAt: NOW,
    };
    const merklFeed: AirdropFeed = {
      cards: [
        makeCard({ n: 'Morpho', id: 'merkl:morpho', source: 'Merkl', url: 'https://app.merkl.xyz/opportunities/base/1', sc: 82 }),
        makeCard({ n: 'Euler', id: 'merkl:euler', source: 'Merkl', url: 'https://app.merkl.xyz/opportunities/ethereum/2', sc: 72 }),
      ],
      tge: [],
      counts: { active: 2, preToken: 2 },
      fetchedAt: NOW,
    };

    const merged = mergeCuratedAirdropFeeds([pendleFeed, merklFeed], NOW);
    expect(merged.cards.map(c => c.n)).toEqual(['Ethena', 'Morpho', 'Resolv', 'Euler', 'Level']);
  });

  test('throws when all live sources fail even if cached defiLlamaFeed or prevFeed exists, and throws on TGE-only result', async () => {
    const fail = async () => {
      throw new Error('upstream down');
    };
    const defiLlamaFeed: AirdropFeed = {
      cards: [makeCard({ n: 'Variational', source: 'DefiLlama', url: 'https://variational.io' })],
      tge: [],
      counts: { active: 1, preToken: 1 },
      fetchedAt: NOW,
    };
    const prevFeed: AirdropFeed = {
      cards: [makeCard({ n: 'PriorSurfCard', source: 'Surf', url: 'https://priorsurf.xyz' })],
      tge: [{ n: 'PriorTge', t: 'PTG', s: 'Claimable', d: '2026-11-20', source: 'Surf' }],
      counts: { active: 1, preToken: 1 },
      fetchedAt: NOW - 60_000,
    };

    // Total live failure must throw even when defiLlamaFeed + prevFeed are passed
    await expect(
      buildCuratedAirdropFeed({
        nowMs: NOW,
        defiLlamaFeed,
        prevFeed,
        fetchers: { surf: fail, asso7878: fail, arndxt: fail, pendle: fail, merkl: fail, airdropalert: fail },
      }),
    ).rejects.toThrow(/All curated airdrop sources failed/i);

    // AirdropAlert-only TGE with zero cards must also throw so D1 cards are never wiped
    await expect(
      buildCuratedAirdropFeed({
        nowMs: NOW,
        fetchers: {
          surf: fail,
          asso7878: fail,
          arndxt: fail,
          pendle: fail,
          merkl: fail,
          airdropalert: async () => ({
            cards: [],
            tge: [{ n: 'OnlyTge', t: 'OT', s: 'Claimable', d: '2026-11-24', source: 'AirdropAlert' }],
            counts: { active: 0, preToken: 0 },
            fetchedAt: NOW,
          }),
        },
      }),
    ).rejects.toThrow(/zero cards/i);
  });

  test('honors disabledSourceIds, deferredSourceIds, and preserves prevFeed cards/TGE for failed or deferred sources', async () => {
    const called: string[] = [];
    const prevFeed: AirdropFeed = {
      cards: [
        makeCard({ n: 'PrevSurf', source: 'Surf', url: 'https://prevsurf.xyz', sc: 90 }),
        makeCard({ n: 'PrevAsso', source: 'ASSO7878', url: 'https://prevasso.xyz', sc: 80 }),
        makeCard({ n: 'PrevDisabled', source: 'arndxt', url: 'https://prevdisabled.xyz', sc: 70 }),
        makeCard({ n: 'PrevDeferred', source: 'Pendle', url: 'https://app.pendle.finance/trade/markets/0x9', sc: 65 }),
      ],
      tge: [
        { n: 'PrevSurfTge', t: 'PST', s: 'Claimable', d: '2026-11-25', source: 'Surf' },
        { n: 'PrevDisabledTge', t: 'PDT', s: 'Token live', d: '2026-11-01', source: 'arndxt' },
      ],
      counts: { active: 4, preToken: 4 },
      fetchedAt: NOW - 60_000,
    };

    const result = await buildCuratedAirdropFeed({
      nowMs: NOW,
      prevFeed,
      disabledSourceIds: new Set(['sheet:arndxt_sheet']),
      deferredSourceIds: new Set(['feed:pendle_points']),
      fetchers: {
        surf: async () => {
          called.push('surf');
          throw new Error('timeout');
        },
        asso7878: async () => {
          called.push('asso7878');
          return {
            cards: [makeCard({ n: 'FreshAsso', source: 'ASSO7878', url: 'https://freshasso.xyz', sc: 82 })],
            tge: [],
            counts: { active: 1, preToken: 1 },
            fetchedAt: NOW,
          };
        },
        arndxt: async () => {
          called.push('arndxt');
          return { cards: [], tge: [], counts: { active: 0, preToken: 0 }, fetchedAt: NOW };
        },
        pendle: async () => {
          called.push('pendle');
          return { cards: [], tge: [], counts: { active: 0, preToken: 0 }, fetchedAt: NOW };
        },
        merkl: async () => {
          called.push('merkl');
          return { cards: [], tge: [], counts: { active: 0, preToken: 0 }, fetchedAt: NOW };
        },
        airdropalert: async () => {
          called.push('airdropalert');
          return { cards: [], tge: [], counts: { active: 0, preToken: 0 }, fetchedAt: NOW };
        },
      },
    });

    expect(called).not.toContain('arndxt');
    expect(called).not.toContain('pendle');
    expect(result.feed.cards.map(c => c.n)).toEqual(['PrevSurf', 'FreshAsso', 'PrevDeferred']);
    expect(result.feed.tge.map(t => t.n)).toEqual(['PrevSurfTge']);
    // Disabled/deferred sources should not emit live ok/fail outcomes
    expect(result.outcomes.some(o => o.sourceId === 'sheet:arndxt_sheet')).toBe(false);
    expect(result.outcomes.some(o => o.sourceId === 'feed:pendle_points')).toBe(false);

    // When ALL live jobs are skipped by deferredSourceIds, prevFeed is preserved without throwing
    const allDeferred = await buildCuratedAirdropFeed({
      nowMs: NOW,
      prevFeed,
      deferredSourceIds: new Set([
        'surf',
        'sheet:asso7878_sheet',
        'sheet:arndxt_sheet',
        'feed:pendle_points',
        'feed:merkl_opportunities',
        'feed:airdropalert_calendar',
      ]),
      fetchers: {
        surf: async () => {
          throw new Error('must not run');
        },
        asso7878: async () => {
          throw new Error('must not run');
        },
        arndxt: async () => {
          throw new Error('must not run');
        },
        pendle: async () => {
          throw new Error('must not run');
        },
        merkl: async () => {
          throw new Error('must not run');
        },
        airdropalert: async () => {
          throw new Error('must not run');
        },
      },
    });
    expect(allDeferred.feed.cards.length).toBe(4);
  });

  test('mergeSecondaryIntoPrimary copies riskLabel, blocks zero badge on paid primary, and recomputes taskTypes', () => {
    const primaryFeed: AirdropFeed = {
      cards: [
        makeCard({
          n: 'PaidProto',
          source: 'Surf',
          url: 'https://paidproto.xyz',
          costNum: 100,
          b: ['live'],
          taskTypes: ['staking'],
          tasks: [{ title: 'Stake ETH', type: 'staking', status: 'OPEN', cost: 100, timeMinutes: 5, url: 'https://paidproto.xyz' }],
        }),
      ],
      tge: [],
      counts: { active: 1, preToken: 1 },
      fetchedAt: NOW,
    };
    const secondaryFeed: AirdropFeed = {
      cards: [
        makeCard({
          n: 'PaidProto',
          source: 'ASSO7878',
          url: 'https://paidproto.xyz',
          costNum: 0,
          b: ['zero', 'risk'],
          riskLabel: 'Sybil / negative EV',
          taskTypes: ['social'],
          tasks: [{ title: 'Daily check-in', type: 'social', status: 'OPEN', cost: 0, timeMinutes: 1, url: 'https://paidproto.xyz' }],
        }),
      ],
      tge: [],
      counts: { active: 1, preToken: 1 },
      fetchedAt: NOW,
    };

    const merged = mergeCuratedAirdropFeeds([primaryFeed, secondaryFeed], NOW);
    const card = merged.cards[0];
    expect(card.b).toContain('risk');
    expect(card.riskLabel).toBe('Sybil / negative EV');
    expect(card.b).not.toContain('zero');
    expect(card.taskTypes).toContain('staking');
    expect(card.taskTypes).toContain('social');
  });

  test('DefiLlama extractor excludes non-airdrop categories and computes recency from nowMs rather than hardcoded 2026', () => {
    const futureNow = Date.parse('2028-06-01T00:00:00Z');
    const raw = [
      { name: 'RealDeFi', slug: 'realdefi', symbol: '-', category: 'Dexes', chains: ['Base'], tvl: 40_000_000, listedAt: Math.floor(Date.parse('2028-02-01T00:00:00Z') / 1000), url: 'https://realdefi.xyz' },
      { name: 'OldDeFi', slug: 'olddefi', symbol: '-', category: 'Lending', chains: ['Ethereum'], tvl: 35_000_000, listedAt: Math.floor(Date.parse('2026-02-01T00:00:00Z') / 1000), url: 'https://olddefi.xyz' },
      { name: 'CanonBridge', slug: 'cb', symbol: '-', category: 'Canonical Bridge', chains: ['Base'], tvl: 900_000_000, url: 'https://cb.xyz' },
      { name: 'SomeChain', slug: 'ch', symbol: '-', category: 'Chain', chains: ['Ethereum'], tvl: 800_000_000, url: 'https://ch.xyz' },
      { name: 'CeFiDesk', slug: 'cefi', symbol: '-', category: 'CeFi', chains: ['Ethereum'], tvl: 700_000_000, url: 'https://cefi.xyz' },
      { name: 'Custodian', slug: 'cust', symbol: '-', category: 'Custody', chains: ['Ethereum'], tvl: 600_000_000, url: 'https://cust.xyz' },
      { name: 'TreasuryMgr', slug: 'tm', symbol: '-', category: 'Treasury Manager', chains: ['Ethereum'], tvl: 500_000_000, url: 'https://tm.xyz' },
      { name: 'RwaVault', slug: 'rwa', symbol: '-', category: 'RWA', chains: ['Ethereum'], tvl: 400_000_000, url: 'https://rwa.xyz' },
    ];
    const feed = extractDefiLlamaTokenlessAirdrops(raw, futureNow);
    expect(feed.cards.map(c => c.n)).toEqual(['RealDeFi', 'OldDeFi']);
    expect(feed.cards[0].b).toContain('live');
    expect(feed.cards[1].b).not.toContain('live');
  });

  test('DefiLlama extractor skips malformed rows and non-string fields cleanly without throwing', () => {
    const raw: unknown[] = [
      null,
      undefined,
      42,
      'not-an-object',
      true,
      ['array-row'],
      { name: 123, symbol: '-', category: 'Dexes', tvl: 20_000_000 },
      { name: '   ', symbol: '-', category: 'Dexes', tvl: 20_000_000 },
      { name: 'BadCategoryType', symbol: '-', category: 99, tvl: 20_000_000 },
      { name: 'BadCategoryObj', symbol: '-', category: { label: 'Dexes' }, tvl: 20_000_000 },
      { name: 'InfiniteTvl', symbol: '-', category: 'Dexes', tvl: Number.POSITIVE_INFINITY },
      { name: 'NaNTvl', symbol: '-', category: 'Dexes', tvl: Number.NaN },
      { name: 'ExcludedCex', symbol: '-', category: 'CEX', tvl: 50_000_000 },
      {
        name: 'CleanProto',
        slug: 404,
        symbol: '-',
        category: null,
        chains: ['Arbitrum', 123, null, {}, 'Base'],
        chain: 777,
        tvl: 25_000_000,
        listedAt: 'bad-timestamp',
        url: { href: 'https://bad-url.xyz' },
      },
      {
        name: 'FallbackChainProto',
        slug: 'fallback-chain',
        symbol: '-',
        category: 'Lending',
        chains: [null, 42],
        chain: 'Optimism',
        tvl: 12_000_000,
        url: 'https://fallbackchain.xyz',
      },
    ];

    const feed = extractDefiLlamaTokenlessAirdrops(raw, NOW);
    expect(feed.cards.map(c => c.n)).toEqual(['CleanProto', 'FallbackChainProto']);

    const clean = feed.cards[0];
    expect(clean.id).toBe('defillama:cleanproto');
    expect(clean.chains).toEqual(['Arbitrum', 'Base']);
    expect(clean.chain).toBe('Arbitrum');
    expect(clean.url).toBeNull();
    expect(clean.b).toEqual(['early']);

    const fallback = feed.cards[1];
    expect(fallback.id).toBe('defillama:fallback-chain');
    expect(fallback.chains).toEqual(['Optimism']);
    expect(fallback.chain).toBe('Optimism');
    expect(fallback.url).toBe('https://fallbackchain.xyz/');
  });

  test('never elevates foreign editable-sheet URLs onto non-sheet primary cards or known_domains during merge', () => {
    const surfFeed: AirdropFeed = {
      cards: [
        makeCard({
          n: 'NoUrlProto',
          id: 'surf-nourl',
          source: 'Surf',
          url: null,
          tasks: [],
          tk: '0/0',
          sc: 85,
        }),
        makeCard({
          n: 'TrustedProto',
          id: 'surf-trusted',
          source: 'Surf',
          url: 'https://official.xyz/app',
          tasks: [{ title: 'Surf task', type: 'testnet', status: 'OPEN', cost: 0, timeMinutes: 5, url: 'https://official.xyz/app' }],
          tk: '1/1',
          sc: 84,
        }),
      ],
      tge: [],
      counts: { active: 2, preToken: 2 },
      fetchedAt: NOW,
    };

    const assoFeed: AirdropFeed = {
      cards: [
        makeCard({
          n: 'NoUrlProto',
          id: 'asso7878:nourlproto',
          source: 'ASSO7878',
          url: 'https://sheet-injected.xyz/claim',
          tasks: [{ title: 'Sheet claim', type: 'bounty', status: 'OPEN', cost: 0, timeMinutes: null, url: 'https://sheet-injected.xyz/claim' }],
        }),
      ],
      tge: [],
      counts: { active: 1, preToken: 1 },
      fetchedAt: NOW,
    };

    const arndxtFeed: AirdropFeed = {
      cards: [
        makeCard({
          n: 'TrustedProto',
          id: 'arndxt:trustedproto',
          source: 'arndxt',
          url: 'https://foreign-sheet.xyz/phish',
          tasks: [
            { title: 'Same domain stake', type: 'staking', status: 'OPEN', cost: 10, timeMinutes: null, url: 'https://app.official.xyz/stake' },
            { title: 'Foreign domain phish', type: 'trading', status: 'OPEN', cost: 10, timeMinutes: null, url: 'https://foreign-sheet.xyz/phish' },
          ],
        }),
      ],
      tge: [],
      counts: { active: 1, preToken: 1 },
      fetchedAt: NOW,
    };

    const merged = mergeCuratedAirdropFeeds([surfFeed, assoFeed, arndxtFeed], NOW);
    const noUrl = merged.cards.find(c => c.n === 'NoUrlProto')!;
    expect(noUrl.url).toBeNull();
    expect(noUrl.tasks?.length).toBe(1);
    expect(noUrl.tasks?.[0].url).toBeNull();

    const trusted = merged.cards.find(c => c.n === 'TrustedProto')!;
    expect(trusted.url).toBe('https://official.xyz/app');
    expect(trusted.tasks?.find(t => t.title === 'Same domain stake')?.url).toBe('https://app.official.xyz/stake');
    expect(trusted.tasks?.find(t => t.title === 'Foreign domain phish')?.url).toBeNull();

    const known = collectKnownDomainEntries(merged, null);
    expect(known.some(k => k.domain === 'official.xyz' && k.origin === 'surf')).toBe(true);
    expect(known.some(k => k.domain === 'sheet-injected.xyz')).toBe(false);
    expect(known.some(k => k.domain === 'foreign-sheet.xyz')).toBe(false);
  });

  test('does not register rejected secondary sheet domains in byDomain, while indexing accepted merged domains', () => {
    const surfFeed: AirdropFeed = {
      cards: [
        makeCard({
          n: 'NoUrlProto',
          id: 'surf-nourl',
          source: 'Surf',
          url: null,
          tasks: [],
          tk: '0/0',
          sc: 90,
        }),
        makeCard({
          n: 'TrustedEmpty',
          id: 'surf-empty',
          source: 'Surf',
          url: null,
          tasks: [],
          tk: '0/0',
          sc: 85,
        }),
      ],
      tge: [],
      counts: { active: 2, preToken: 2 },
      fetchedAt: NOW,
    };

    const assoFeed: AirdropFeed = {
      cards: [
        // Matches NoUrlProto by name, but its foreign domain is rejected on merge -> must NOT pollute byDomain!
        makeCard({
          n: 'NoUrlProto',
          id: 'asso7878:nourlproto',
          source: 'ASSO7878',
          url: 'https://victim-proto.xyz/claim',
          tasks: [
            {
              title: 'Foreign sheet task',
              type: 'bounty',
              status: 'OPEN',
              cost: 0,
              timeMinutes: null,
              url: 'https://victim-proto.xyz/claim',
            },
          ],
        }),
      ],
      tge: [],
      counts: { active: 1, preToken: 1 },
      fetchedAt: NOW,
    };

    const defiLlamaFeed: AirdropFeed = {
      cards: [
        // Legitimate protocol owning victim-proto.xyz must remain its own distinct card.
        makeCard({
          n: 'VictimProto',
          id: 'defillama:victimproto',
          source: 'DefiLlama',
          url: 'https://victim-proto.xyz/',
          sc: 75,
        }),
        // Trusted DefiLlama enriches TrustedEmpty with an accepted project domain + accepted task domain.
        makeCard({
          n: 'TrustedEmpty',
          id: 'defillama:trustedempty',
          source: 'DefiLlama',
          url: 'https://trusted-empty.xyz/',
          tasks: [
            {
              title: 'App task',
              type: 'liquidity',
              status: 'OPEN',
              cost: 10,
              timeMinutes: null,
              url: 'https://portal.trusted-task.xyz/earn',
            },
          ],
          sc: 70,
        }),
      ],
      tge: [],
      counts: { active: 2, preToken: 2 },
      fetchedAt: NOW,
    };

    const laterFeed: AirdropFeed = {
      cards: [
        // Different display name, shares accepted merged task domain -> should merge into TrustedEmpty via byDomain.
        makeCard({
          n: 'TrustedEmpty V2',
          id: 'merkl:trustedempty-v2',
          source: 'Merkl',
          url: 'https://trusted-task.xyz/campaign',
          f: '$15.00M',
          raiseNum: 15_000_000,
          sc: 60,
        }),
      ],
      tge: [],
      counts: { active: 1, preToken: 1 },
      fetchedAt: NOW,
    };

    const merged = mergeCuratedAirdropFeeds([surfFeed, assoFeed, defiLlamaFeed, laterFeed], NOW);
    expect(merged.cards.map(c => c.n)).toEqual(['NoUrlProto', 'TrustedEmpty', 'VictimProto']);

    const victim = merged.cards.find(c => c.n === 'VictimProto')!;
    expect(victim.source).toBe('DefiLlama');
    expect(victim.url).toBe('https://victim-proto.xyz/');

    const trusted = merged.cards.find(c => c.n === 'TrustedEmpty')!;
    expect(trusted.url).toBe('https://trusted-empty.xyz/');
    expect(trusted.raiseNum).toBe(15_000_000);
  });

  test('supports cachedAsso7878Feed and cachedArndxtFeed without calling live sheet fetchers or bypassing total live failure', async () => {
    const called: string[] = [];
    const cachedAsso: AirdropFeed = {
      cards: [makeCard({ n: 'CachedAssoCard', source: 'ASSO7878', url: 'https://cachedasso.xyz', sc: 78 })],
      tge: [{ n: 'CachedAssoTge', t: 'CAT', s: 'Token live', d: '2026-10-01', source: 'ASSO7878' }],
      counts: { active: 1, preToken: 1 },
      fetchedAt: NOW - 10_000,
    };
    const cachedArndxt: AirdropFeed = {
      cards: [makeCard({ n: 'CachedArndxtCard', source: 'arndxt', url: 'https://cachedarndxt.xyz', sc: 76 })],
      tge: [],
      counts: { active: 1, preToken: 1 },
      fetchedAt: NOW - 10_000,
    };

    const result = await buildCuratedAirdropFeed({
      nowMs: NOW,
      cachedAsso7878Feed: cachedAsso,
      cachedArndxtFeed: cachedArndxt,
      fetchers: {
        surf: async () => {
          called.push('surf');
          throw new Error('surf timeout');
        },
        asso7878: async () => {
          called.push('asso7878');
          throw new Error('should not fetch asso7878 live when cached');
        },
        arndxt: async () => {
          called.push('arndxt');
          throw new Error('should not fetch arndxt live when cached');
        },
        pendle: async () => {
          called.push('pendle');
          return {
            cards: [makeCard({ n: 'LivePendle', source: 'Pendle', url: 'https://app.pendle.finance/trade/markets/0x1', sc: 80 })],
            tge: [],
            counts: { active: 1, preToken: 1 },
            fetchedAt: NOW,
          };
        },
        merkl: async () => ({ cards: [], tge: [], counts: { active: 0, preToken: 0 }, fetchedAt: NOW }),
        airdropalert: async () => ({ cards: [], tge: [], counts: { active: 0, preToken: 0 }, fetchedAt: NOW }),
      },
    });

    expect(called).not.toContain('asso7878');
    expect(called).not.toContain('arndxt');
    expect(result.feed.cards.map(c => c.n)).toEqual(['LivePendle', 'CachedAssoCard', 'CachedArndxtCard']);
    expect(result.feed.tge.map(t => t.n)).toEqual(['CachedAssoTge']);
    // Cached sheets must NOT emit sourceId outcomes that would overwrite cached fetched_at in D1
    expect(result.outcomes.some(o => o.sourceId === 'sheet:asso7878_sheet')).toBe(false);
    expect(result.outcomes.some(o => o.sourceId === 'sheet:arndxt_sheet')).toBe(false);

    // Disabled sheet must skip cached feed too
    const disabledRes = await buildCuratedAirdropFeed({
      nowMs: NOW,
      cachedAsso7878Feed: cachedAsso,
      cachedArndxtFeed: cachedArndxt,
      disabledSourceIds: new Set(['sheet:asso7878_sheet']),
      fetchers: {
        surf: async () => {
          throw new Error('timeout');
        },
        asso7878: async () => {
          throw new Error('must not run');
        },
        arndxt: async () => {
          throw new Error('must not run');
        },
        pendle: async () => ({
          cards: [makeCard({ n: 'LivePendle', source: 'Pendle', url: 'https://app.pendle.finance/trade/markets/0x1', sc: 80 })],
          tge: [],
          counts: { active: 1, preToken: 1 },
          fetchedAt: NOW,
        }),
        merkl: async () => ({ cards: [], tge: [], counts: { active: 0, preToken: 0 }, fetchedAt: NOW }),
        airdropalert: async () => ({ cards: [], tge: [], counts: { active: 0, preToken: 0 }, fetchedAt: NOW }),
      },
    });
    expect(disabledRes.feed.cards.map(c => c.n)).toEqual(['LivePendle', 'CachedArndxtCard']);

    // When all remaining live sources fail, cached sheets must NOT increment liveFulfilledCount -> must throw!
    const fail = async () => {
      throw new Error('down');
    };
    await expect(
      buildCuratedAirdropFeed({
        nowMs: NOW,
        cachedAsso7878Feed: cachedAsso,
        cachedArndxtFeed: cachedArndxt,
        fetchers: { surf: fail, asso7878: fail, arndxt: fail, pendle: fail, merkl: fail, airdropalert: fail },
      }),
    ).rejects.toThrow(/All curated airdrop sources failed/i);
  });

  test('strips merged sheet tasks from Surf fallback cards when the sheet source is later disabled', async () => {
    const surfCard = makeCard({
      n: 'SharedProto',
      id: 'surf-shared',
      source: 'Surf',
      url: 'https://sharedproto.xyz/app',
      taskTypes: ['testnet'],
      tasks: [{ title: 'Surf official task', type: 'testnet', status: 'OPEN', cost: 0, timeMinutes: 5, url: 'https://sharedproto.xyz/app' }],
    });
    const sheetCard = makeCard({
      n: 'SharedProto',
      id: 'asso7878:sharedproto',
      source: 'ASSO7878',
      url: 'https://sharedproto.xyz/sheet-task',
      taskTypes: ['social'],
      tasks: [{ title: 'Sheet bonus task', type: 'social', status: 'OPEN', cost: 0, timeMinutes: null, url: 'https://sharedproto.xyz/sheet-task' }],
    });
    const prevMerged = mergeCuratedAirdropFeeds(
      [
        { cards: [surfCard], tge: [], counts: { active: 1, preToken: 1 }, fetchedAt: NOW - 60_000 },
        { cards: [sheetCard], tge: [], counts: { active: 1, preToken: 1 }, fetchedAt: NOW - 60_000 },
      ],
      NOW - 60_000,
    );
    expect(prevMerged.cards[0].tasks?.map(t => t.title)).toEqual(['Surf official task', 'Sheet bonus task']);

    // Operator disables ASSO7878, then Surf fails while Pendle succeeds -> fallback Surf card must NOT restore the disabled sheet task.
    const nextRes = await buildCuratedAirdropFeed({
      nowMs: NOW,
      prevFeed: prevMerged,
      disabledSourceIds: new Set(['sheet:asso7878_sheet']),
      fetchers: {
        surf: async () => {
          throw new Error('surf outage');
        },
        asso7878: async () => {
          throw new Error('must not run while disabled');
        },
        arndxt: async () => ({ cards: [], tge: [], counts: { active: 0, preToken: 0 }, fetchedAt: NOW }),
        pendle: async () => ({
          cards: [makeCard({ n: 'LivePendle', source: 'Pendle', url: 'https://app.pendle.finance/trade/markets/0x1' })],
          tge: [],
          counts: { active: 1, preToken: 1 },
          fetchedAt: NOW,
        }),
        merkl: async () => ({ cards: [], tge: [], counts: { active: 0, preToken: 0 }, fetchedAt: NOW }),
        airdropalert: async () => ({ cards: [], tge: [], counts: { active: 0, preToken: 0 }, fetchedAt: NOW }),
      },
    });

    const restoredSurf = nextRes.feed.cards.find(c => c.n === 'SharedProto')!;
    expect(restoredSurf).toBeDefined();
    expect(restoredSurf.tasks?.map(t => t.title)).toEqual(['Surf official task']);
    expect(restoredSurf.tk).toBe('1/1');
    expect(restoredSurf.taskTypes).toEqual(['testnet']);
  });

  test('backfillLegacyAirdropSources stamps Surf on unlabeled cards and TGE while preserving labeled sources', () => {
    const legacyFeed: AirdropFeed = {
      cards: [
        makeCard({ n: 'LegacySurfNoSource', id: 'surf-legacy-1', url: 'https://legacysurf.xyz' }),
        makeCard({ n: 'LegacySurfBlankSource', id: 'surf-legacy-2', source: '   ', url: 'https://legacysurf2.xyz' }),
        makeCard({ n: 'LabeledSheet', id: 'asso7878:labeled', source: 'ASSO7878', url: 'https://labeledsheet.xyz' }),
      ],
      tge: [
        { n: 'LegacyTge', t: 'LTG', s: 'Claimable', d: '2026-11-25' },
        { n: 'BlankSourceTge', t: 'BST', s: 'Claimable', d: '2026-11-26', source: '' },
        { n: 'CalendarTge', t: 'CTG', s: 'Upcoming', d: '2026-11-27', source: 'AirdropAlert' },
      ],
      counts: { active: 3, preToken: 3 },
      fetchedAt: NOW - 60_000,
    };

    const backfilled = backfillLegacyAirdropSources(legacyFeed);
    expect(backfilled.cards.map(c => c.source)).toEqual(['Surf', 'Surf', 'ASSO7878']);
    expect(backfilled.tge.map(t => t.source)).toEqual(['Surf', 'Surf', 'AirdropAlert']);
    // Original input is not mutated
    expect(legacyFeed.cards[0].source).toBeUndefined();
    expect(legacyFeed.tge[0].source).toBeUndefined();
  });

  test('slicePrevFeedForSource defensively preserves unlabeled legacy Surf cards and TGE when Surf fails', async () => {
    const legacyPrevFeed: AirdropFeed = {
      cards: [
        makeCard({ n: 'LegacySurfCard', id: 'surf-legacy', url: 'https://legacysurf.xyz', sc: 88 }),
        makeCard({ n: 'OtherSourceCard', id: 'merkl:other', source: 'Merkl', url: 'https://othermerkl.xyz', sc: 70 }),
      ],
      tge: [
        { n: 'LegacySurfTge', t: 'LST', s: 'Claimable', d: '2026-11-25' },
      ],
      counts: { active: 2, preToken: 2 },
      fetchedAt: NOW - 60_000,
    };

    const res = await buildCuratedAirdropFeed({
      nowMs: NOW,
      prevFeed: legacyPrevFeed,
      fetchers: {
        surf: async () => {
          throw new Error('surf outage');
        },
        asso7878: async () => ({ cards: [], tge: [], counts: { active: 0, preToken: 0 }, fetchedAt: NOW }),
        arndxt: async () => ({ cards: [], tge: [], counts: { active: 0, preToken: 0 }, fetchedAt: NOW }),
        pendle: async () => ({
          cards: [makeCard({ n: 'LivePendle', source: 'Pendle', url: 'https://app.pendle.finance/trade/markets/0x1', sc: 80 })],
          tge: [],
          counts: { active: 1, preToken: 1 },
          fetchedAt: NOW,
        }),
        merkl: async () => ({ cards: [], tge: [], counts: { active: 0, preToken: 0 }, fetchedAt: NOW }),
        airdropalert: async () => ({ cards: [], tge: [], counts: { active: 0, preToken: 0 }, fetchedAt: NOW }),
      },
    });

    const restoredCard = res.feed.cards.find(c => c.n === 'LegacySurfCard');
    expect(restoredCard).toBeDefined();
    expect(restoredCard?.source).toBe('Surf');
    expect(res.feed.cards.some(c => c.n === 'OtherSourceCard')).toBe(false);
    expect(res.feed.tge).toEqual([{ n: 'LegacySurfTge', t: 'LST', s: 'Claimable', d: '2026-11-25', source: 'Surf' }]);
  });

  test('filterAirdropFeedByDisabledSources maps canonical IDs and raw names, strips merged tasks, renumbers ranks, and recomputes counts', () => {
    const feed: AirdropFeed = {
      cards: [
        makeCard({
          r: 1,
          n: 'SurfWithMergedTasks',
          id: 'surf-1',
          source: 'Surf',
          b: ['live'],
          taskTypes: ['testnet', 'social', 'staking'],
          tasks: [
            { title: 'Surf task', type: 'testnet', status: 'OPEN', cost: 0, timeMinutes: 5, url: 'https://surf1.xyz' },
            { title: 'Asso task', type: 'social', status: 'OPEN', cost: 0, timeMinutes: null, url: 'https://surf1.xyz', source: 'ASSO7878' },
            { title: 'Pendle task', type: 'staking', status: 'OPEN', cost: 100, timeMinutes: null, url: 'https://surf1.xyz', source: 'Pendle' },
          ],
          tk: '3/3',
          sc: 95,
        }),
        makeCard({ r: 2, n: 'AssoCard', id: 'asso7878:a', source: 'ASSO7878', b: ['live'], sc: 90 }),
        makeCard({ r: 3, n: 'ArndxtCard', id: 'arndxt:a', source: 'arndxt', b: ['live'], sc: 88 }),
        makeCard({ r: 4, n: 'PendleCard', id: 'pendle:p', source: 'Pendle', b: ['live'], sc: 85 }),
        makeCard({ r: 5, n: 'MerklCard', id: 'merkl:m', source: 'Merkl', b: ['live'], sc: 82 }),
        makeCard({ r: 6, n: 'AlertCard', id: 'airdropalert:c', source: 'AirdropAlert', b: ['live'], sc: 80 }),
        makeCard({ r: 7, n: 'DefiLlamaLaunched', id: 'defillama:dl', source: 'DefiLlama', b: ['live', 'token'], sc: 75 }),
        makeCard({ r: 8, n: 'RawNameDrop', id: 'custom:raw', source: 'CustomFeed', b: ['live'], sc: 70 }),
      ],
      tge: [
        { n: 'SurfTge', t: 'STG', s: 'Claimable', d: '2026-11-25', source: 'Surf' },
        { n: 'AssoTge', t: 'ATG', s: 'Token live', d: '2026-11-20', source: 'ASSO7878' },
        { n: 'ArndxtTge', t: 'XTG', s: 'Token live', d: '2026-11-19', source: 'arndxt' },
        { n: 'AlertTge', t: 'CTG', s: 'Upcoming', d: '2026-11-29', source: 'AirdropAlert' },
      ],
      counts: { active: 8, preToken: 7 },
      fetchedAt: NOW - 120_000,
    };

    // No disabled sources or non-matching IDs returns the exact same reference
    expect(filterAirdropFeedByDisabledSources(feed, new Set())).toBe(feed);
    expect(filterAirdropFeedByDisabledSources(feed, new Set(['feed:nonexistent']))).toBe(feed);

    const filtered = filterAirdropFeedByDisabledSources(
      feed,
      new Set([
        'sheet:asso7878_sheet',
        'SHEET:ARNDXT_SHEET',
        'feed:pendle_points',
        'feed:merkl_opportunities',
        'feed:airdropalert_calendar',
        'customfeed',
      ]),
    );

    expect(filtered.cards.map(c => ({ r: c.r, n: c.n }))).toEqual([
      { r: 1, n: 'SurfWithMergedTasks' },
      { r: 2, n: 'DefiLlamaLaunched' },
    ]);
    expect(filtered.cards[0].tasks?.map(t => t.title)).toEqual(['Surf task']);
    expect(filtered.cards[0].tk).toBe('1/1');
    expect(filtered.cards[0].taskTypes).toEqual(['testnet']);
    expect(filtered.tge).toEqual([{ n: 'SurfTge', t: 'STG', s: 'Claimable', d: '2026-11-25', source: 'Surf' }]);
    expect(filtered.counts).toEqual({ active: 2, preToken: 1 });
    expect(filtered.fetchedAt).toBe(NOW - 120_000);
  });

  test('resolves curated source URLs from the source registry while keeping explicit URL overrides higher priority', async () => {
    const requested: string[] = [];
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      return new Response('offline', { status: 503 });
    }) as unknown as typeof fetch;

    const customRegistry = new Map([
      ['sheet:asso7878_sheet', { platform: 'sheet' as const, handle: 'asso7878_sheet', lang: 'zh', trust: 0.75, tags: ['curated'], enabled: true, url: 'https://registry.test/asso.csv', parser: 'asso7878' as const }],
      ['sheet:arndxt_sheet', { platform: 'sheet' as const, handle: 'arndxt_sheet', lang: 'en', trust: 0.8, tags: ['curated'], enabled: true, url: 'https://registry.test/arndxt.csv', parser: 'arndxt' as const }],
      ['feed:pendle_points', { platform: 'feed' as const, handle: 'pendle_points', lang: 'en', trust: 0.85, tags: ['curated'], enabled: true, url: 'https://registry.test/pendle.json', parser: 'pendle' as const }],
      ['feed:merkl_opportunities', { platform: 'feed' as const, handle: 'merkl_opportunities', lang: 'en', trust: 0.85, tags: ['curated'], enabled: true, url: 'https://registry.test/merkl.json', parser: 'merkl' as const }],
      ['feed:airdropalert_calendar', { platform: 'feed' as const, handle: 'airdropalert_calendar', lang: 'en', trust: 0.85, tags: ['drops', 'tge'], enabled: true, url: 'https://registry.test/calendar.json', parser: 'wp_calendar' as const }],
    ]);

    try {
      await expect(
        buildCuratedAirdropFeed({
          nowMs: NOW,
          surfUrl: 'https://override.test/surf.json',
          arndxtUrl: 'https://override.test/arndxt.csv',
          sourceRegistry: customRegistry,
        }),
      ).rejects.toThrow(/All curated airdrop sources failed/i);

      expect(requested).toContain('https://override.test/surf.json');
      expect(requested).toContain('https://registry.test/asso.csv');
      expect(requested).toContain('https://override.test/arndxt.csv');
      expect(requested).not.toContain('https://registry.test/arndxt.csv');
      expect(requested).toContain('https://registry.test/pendle.json');
      expect(requested).toContain('https://registry.test/merkl.json');
      expect(requested).toContain('https://registry.test/calendar.json');
    } finally {
      globalThis.fetch = prevFetch;
    }
  });

  test('extractDefiLlamaTokenlessAirdrops reads sanitized https logo and mergeCuratedAirdropFeeds propagates img/ticker across cards and TGE respecting trust boundaries', () => {
    const defiRaw = [
      {
        name: 'Variational',
        slug: 'variational',
        symbol: '-',
        category: 'Derivatives',
        chains: ['Arbitrum'],
        tvl: 120_000_000,
        listedAt: 1770000000,
        url: 'https://variational.io',
        logo: 'https://icons.llama.fi/variational.png',
      },
      {
        name: 'HttpLogoProto',
        slug: 'httplogo',
        symbol: '-',
        category: 'Dexes',
        chains: ['Base'],
        tvl: 20_000_000,
        url: 'https://httplogo.xyz',
        logo: 'http://insecure.llama.fi/bad.png',
      },
      {
        name: 'SlugFallbackProto',
        slug: 'ether.fi-stake',
        symbol: '-',
        category: 'Liquid Staking',
        chains: ['Ethereum'],
        tvl: 15_000_000,
        url: 'https://ether.fi',
      },
    ];
    const defiFeed = extractDefiLlamaTokenlessAirdrops(defiRaw, NOW);
    expect(defiFeed.cards[0].img).toBe('https://icons.llama.fi/variational.png');
    expect(defiFeed.cards[1].img).toBe('');
    expect(defiFeed.cards[2].img).toBe('https://icons.llamao.fi/icons/protocols/ether.fi-stake?w=48&h=48');

    const surfFeed: AirdropFeed = {
      cards: [
        makeCard({
          n: 'Variational',
          id: 'surf-var',
          source: 'Surf',
          url: 'https://variational.io',
          img: '',
          t: null,
          sc: 90,
        }),
        makeCard({
          n: 'Treehouse',
          id: 'surf-tree',
          source: 'Surf',
          url: 'https://treehouse.finance',
          img: 'https://images.asksurf.ai/treehouse.png',
          t: 'TREE',
          sc: 85,
        }),
      ],
      tge: [],
      counts: { active: 2, preToken: 2 },
      fetchedAt: NOW,
    };

    const assoFeed: AirdropFeed = {
      cards: [
        makeCard({
          n: 'Variational',
          id: 'asso7878:variational',
          source: 'ASSO7878',
          url: 'https://variational.io',
          img: 'https://untrusted-sheet.evil/pixel.png',
          t: 'FAKE',
          sc: 70,
        }),
        makeCard({
          n: 'SheetOnlyProto',
          id: 'asso7878:sheetonly',
          source: 'ASSO7878',
          url: 'https://sheetonly.xyz',
          img: '',
          t: 'SOP',
          sc: 65,
        }),
      ],
      tge: [
        { n: 'Treehouse', t: '', s: 'Token live', d: '2026-11-20', source: 'ASSO7878' },
        { n: 'Variational', t: '', s: 'Upcoming', d: '2026-12-01', source: 'AirdropAlert' },
      ],
      counts: { active: 2, preToken: 2 },
      fetchedAt: NOW,
    };

    const trustedSecondary: AirdropFeed = {
      cards: [
        makeCard({
          n: 'Variational',
          id: 'merkl:variational',
          source: 'Merkl',
          url: 'https://variational.io',
          img: 'https://icons.merkl.xyz/variational.png',
          t: 'VAR',
          sc: 72,
        }),
        makeCard({
          n: 'SheetOnlyProto',
          id: 'defillama:sheetonly',
          source: 'DefiLlama',
          url: 'https://sheetonly.xyz',
          img: 'https://icons.llama.fi/sheetonly.png',
          t: null,
          sc: 60,
        }),
      ],
      tge: [],
      counts: { active: 2, preToken: 2 },
      fetchedAt: NOW,
    };

    const merged = mergeCuratedAirdropFeeds([surfFeed, assoFeed, trustedSecondary], NOW);
    // Untrusted ASSO7878 must NOT inject img or t onto Surf primary; trusted Merkl CAN propagate img and t.
    const variational = merged.cards.find(c => c.n === 'Variational')!;
    expect(variational.img).toBe('https://icons.merkl.xyz/variational.png');
    expect(variational.t).toBe('VAR');

    // Trusted DefiLlama enriches an ASSO7878 primary card's missing img while preserving sheet's ticker.
    const sheetOnly = merged.cards.find(c => c.n === 'SheetOnlyProto')!;
    expect(sheetOnly.img).toBe('https://icons.llama.fi/sheetonly.png');
    expect(sheetOnly.t).toBe('SOP');

    // TGE entries cross-populate logo and ticker from matching merged cards by normalized project key.
    const tgeTree = merged.tge.find(t => t.n === 'Treehouse')!;
    expect(tgeTree.logo).toBe('https://images.asksurf.ai/treehouse.png');
    expect(tgeTree.t).toBe('TREE');

    const tgeVar = merged.tge.find(t => t.n === 'Variational')!;
    expect(tgeVar.logo).toBe('https://icons.merkl.xyz/variational.png');
    expect(tgeVar.t).toBe('VAR');
  });
});
