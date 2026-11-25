import { describe, expect, test } from 'bun:test';
import type { AirdropFeed, Card } from '../../shared/types';
import { FORBIDDEN_CJK_RE } from './helpers';
import { collectKnownDomainEntries } from '../src/safety';
import {
  buildCuratedAirdropFeed,
  extractDefiLlamaTokenlessAirdrops,
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
});
