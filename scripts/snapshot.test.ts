import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildAirdrops,
  collectLiveTelegramPosts,
  finalizeSnapshotCluster,
  fixtureFallbackNeeded,
  isEnglishText,
  isValidMarketsPayload,
  mergeMarketsWithPrior,
  mergePostsStable,
  mergeSectionsWithPrior,
  resolveFixtureFetchedAt,
  resolveSnapshotSurfMatch,
  resolveWorkerBase,
  selectFeedOutput,
  validateSnapshotBundle,
  writeFileAtomic,
  type MergePost,
} from './snapshot.mts';
import { buildFeedLogoIndex } from '../worker/src/normalize/cluster';
import { parseWpCalendarFeedPayload } from '../worker/src/sources/feeds';
import type { AirdropFeed, FeedResponse, MarketSection, MarketSector, MarketsResponse, SourceHealth } from '../shared/types';

function section(id: string, title = `T ${id}`): MarketSection {
  return { id, title, blurb: '', cols: [], rows: [] } as unknown as MarketSection;
}

function post(handle: string, msgId: string, postedAt: number, text = 'Airdrop claim open'): MergePost {
  return { handle, msgId, postUrl: `https://t.me/${handle}/${msgId}`, postedAt, text, urls: [] };
}

describe('mergePostsStable', () => {
  test('identical channels in different argument order yield identical output', () => {
    const cutoff = 0;
    const a = {
      handle: 'alpha',
      posts: [post('alpha', '1', 100), post('alpha', '2', 200), post('alpha', '3', 300)],
    };
    const b = {
      handle: 'beta',
      posts: [post('beta', '1', 150), post('beta', '2', 250)],
    };
    expect(mergePostsStable([a, b], cutoff)).toEqual(mergePostsStable([b, a], cutoff));
  });

  test('keeps newest posts per channel when pages carry more than the cap', () => {
    const posts = [post('alpha', '1', 100), post('alpha', '7', 700), post('alpha', '2', 200)];
    const merged = mergePostsStable([{ handle: 'alpha', posts }], 0, 2);
    expect(merged.map(p => p.msgId)).toEqual(['7', '2']);
  });

  test('drops posts before cutoff and non-English text', () => {
    const posts = [
      post('alpha', '1', 300),
      post('alpha', '2', 400, 'Geräusch — umlauts are fine'),
      post('alpha', '3', 500, '\u7a7a\u6295\u798f\u5229\u5feb\u6765\u9886\u53d6'),
    ];
    const merged = mergePostsStable([{ handle: 'alpha', posts }], 350);
    expect(merged.map(p => p.msgId)).toEqual(['2']);
  });

  test('merges telegram and feed platform posts deterministically regardless of input order', () => {
    const tg = {
      handle: 'airdrops_io',
      posts: [{ ...post('airdrops_io', '10', 500), platform: 'telegram' as const }],
    };
    const feed = {
      handle: 'airdroptracker_rss',
      posts: [
        {
          platform: 'feed' as const,
          handle: 'airdroptracker_rss',
          msgId: 'rss-1',
          postUrl: 'https://www.airdroptracker.io/guide',
          postedAt: 500,
          text: 'Testnet guide',
          urls: [],
        },
      ],
    };
    expect(mergePostsStable([tg, feed], 0)).toEqual(mergePostsStable([feed, tg], 0));
    expect(mergePostsStable([tg, feed], 0).map(p => p.platform)).toEqual(['feed', 'telegram']);
  });
});

describe('fixtureFallbackNeeded (total-failure gate)', () => {
  test('false when any channel collected live posts — live run must not seed fixtures', () => {
    // Pins the gate decision: it must consume POST-COLLECTION state. The old
    // gate read `clusters.size === 0` before clustering ran, which was always
    // true and force-seeded fixtures on every local run. Reverting to the
    // cluster map also fails typecheck: AccCluster lacks { handle, posts }.
    const channelPosts = new Map([
      ['alpha', { handle: 'alpha', posts: [post('alpha', '1', 100)] }],
      ['beta', { handle: 'beta', posts: [] }],
    ]);
    expect(fixtureFallbackNeeded(channelPosts)).toBe(false);
  });

  test('true only when the deferred post map is empty (no channel fetched)', () => {
    expect(fixtureFallbackNeeded(new Map())).toBe(true);
  });
});

describe('snapshot guards (fixture-seeded feed invariant)', () => {
  test('committed feed reuse: empty parsed items never substitute for the previous snapshot', () => {
    // Mirrors readExistingFeed's acceptance rule: item array must be present
    // and non-empty, otherwise the guard throws instead of shipping fixtures.
    const committed = { generatedAt: 1, items: [{ id: 'x' }] } as unknown as FeedResponse;
    const accepted = Array.isArray(committed.items) && committed.items.length > 0;
    const empty = { generatedAt: 2, items: [] } as unknown as FeedResponse;
    const rejected = Array.isArray(empty.items) && empty.items.length > 0;
    expect(accepted).toBe(true);
    expect(rejected).toBe(false);
  });
});

describe('isEnglishText', () => {
  test('matches the worker NON_LATIN_SCRIPT_RE set', () => {
    expect(isEnglishText('Claim now at example.com')).toBe(true);
    expect(isEnglishText('\u7a7a\u6295')).toBe(false);
    expect(isEnglishText('Привет airdrop')).toBe(false);
    expect(isEnglishText('بونص')).toBe(false);
    expect(isEnglishText('café')).toBe(true);
  });
});

describe('mergeSectionsWithPrior (reduced-markets guard)', () => {
  const required = ['crypto', 'defi'] as const;

  test('keeps prior section when fresh run missed one id', () => {
    const prior = [section('crypto'), section('defi'), section('yields')];
    const fresh = [section('crypto'), section('yields')];
    const merged = mergeSectionsWithPrior(fresh, prior, required);
    expect(merged?.map(s => s.id)).toEqual(['crypto', 'defi', 'yields']);
  });

  test('fresh fetch wins over prior for the same id', () => {
    const fresh = [section('crypto', 'fresh')];
    const prior = [section('crypto', 'stale'), section('defi')];
    const merged = mergeSectionsWithPrior(fresh, prior, required);
    expect(merged?.find(s => s.id === 'crypto')?.title).toBe('fresh');
    expect(merged?.map(s => s.id)).toEqual(['crypto', 'defi']);
  });

  test('required section missing everywhere returns null (caller throws)', () => {
    expect(mergeSectionsWithPrior([section('yields')], [section('yields')], required)).toBeNull();
  });

  test('no prior and all fresh present passes through', () => {
    const merged = mergeSectionsWithPrior([section('defi'), section('crypto')], [], required);
    expect(merged?.map(s => s.id)).toEqual(['crypto', 'defi']);
  });
});

describe('finalizeSnapshotCluster (Worker safety & link parity)', () => {
  test('flags quest-platform lookalikes via platformDomains, uses selectFeedLinks(maxLinks=6), and reconciles safety reasons', () => {
    const now = 1_795_240_000_000;
    const lookalikeItem = finalizeSnapshotCluster(
      {
        id: 'c-lookalike',
        project: 'Zea1y',
        domain: 'zea1y.io',
        chains: new Set(['Base']),
        taskTypes: new Set(['quest']),
        summary: 'Complete quests at zea1y.io',
        urls: new Set([
          'https://zea1y.io/quest',
          'https://t.me/airdropfind?boost',
          'https://linktr.ee/airdropfind',
        ]),
        rawIpUrls: new Set(),
        sources: [{ platform: 'telegram', handle: 'airdropfind', postUrl: 'https://t.me/airdropfind/1', postedAt: now }],
        sourceIds: new Set(['telegram:airdropfind']),
        sourceHandles: new Set(['airdropfind']),
        trustMax: 0.85,
        firstSeen: now,
        lastSeen: now,
        texts: ['Complete quests at https://zea1y.io/quest'],
      },
      {
        projectDomains: new Map([['arbitrum.io', 'Arbitrum']]),
        platformDomains: new Set(['zealy.io', 'galxe.com']),
        allKnownDomains: new Set(['arbitrum.io', 'zealy.io', 'galxe.com']),
        nowMs: now,
      },
    );

    expect(lookalikeItem.risk.level).toBe('risk');
    expect(lookalikeItem.risk.reasons.some(r => r.includes('zea1y.io vs zealy.io'))).toBe(true);
    expect(lookalikeItem.links.some(l => l.url.includes('t.me/') || l.url.includes('linktr.ee'))).toBe(false);

    // Caps selected links at 6 (matching Worker maxLinks: 6) and keeps known flag accurate.
    const manyUrls = [
      'https://alphaproto.xyz/claim',
      'https://betavault.io/quest',
      'https://gammaswap.fi/stake',
      'https://deltamint.app/mint',
      'https://epsilonbridge.net/bridge',
      'https://zetaquest.org/tasks',
      'https://thetapool.com/farm',
      'https://kappafarm.co/points',
    ];
    const cappedItem = finalizeSnapshotCluster(
      {
        id: 'c-cap',
        project: 'AlphaProto',
        domain: 'alphaproto.xyz',
        chains: new Set(['Ethereum']),
        taskTypes: new Set(['testnet', 'other']),
        summary: 'AlphaProto testnet claim',
        urls: new Set(manyUrls),
        rawIpUrls: new Set(),
        sources: [{ platform: 'feed', handle: 'airdrops_io_rss', postUrl: 'https://airdrops.io/p/1', postedAt: now }],
        sourceIds: new Set(['feed:airdrops_io_rss']),
        sourceHandles: new Set(['airdrops_io_rss']),
        trustMax: 0.8,
        firstSeen: now,
        lastSeen: now,
        texts: ['AlphaProto testnet claim'],
      },
      {
        projectDomains: new Map([['alphaproto.xyz', 'AlphaProto']]),
        platformDomains: new Set(['zealy.io']),
        allKnownDomains: new Set(['alphaproto.xyz', 'zealy.io']),
        nowMs: now,
      },
    );

    expect(cappedItem.links.length).toBe(6);
    expect(cappedItem.links[0]).toEqual({ url: 'https://alphaproto.xyz/claim', known: true });
    expect(cappedItem.links[1].known).toBe(false);
    expect(cappedItem.risk.level).toBe('warn');
    expect(cappedItem.risk.reasons.some(r => r.includes('Domain not in verified registry'))).toBe(true);
    expect(cappedItem.taskTypes).toEqual(['testnet']);

    // Reconciles plain-http exact https twin cleanly (no stale Insecure transport warning).
    const twinItem = finalizeSnapshotCluster(
      {
        id: 'c-twin',
        project: 'AlphaProto',
        domain: 'alphaproto.xyz',
        chains: new Set(['Base']),
        taskTypes: new Set(['testnet']),
        summary: 'AlphaProto claim',
        urls: new Set(['http://alphaproto.xyz/claim', 'https://alphaproto.xyz/claim']),
        rawIpUrls: new Set(),
        sources: [{ platform: 'telegram', handle: 'airdropfind', postUrl: 'https://t.me/airdropfind/2', postedAt: now }],
        sourceIds: new Set(['telegram:airdropfind']),
        sourceHandles: new Set(['airdropfind']),
        trustMax: 0.85,
        firstSeen: now,
        lastSeen: now,
        texts: ['AlphaProto claim https://alphaproto.xyz/claim'],
      },
      {
        projectDomains: new Map([['alphaproto.xyz', 'AlphaProto']]),
        platformDomains: new Set(['zealy.io']),
        allKnownDomains: new Set(['alphaproto.xyz', 'zealy.io']),
        nowMs: now,
      },
    );
    expect(twinItem.risk.level).toBe('ok');
    expect(twinItem.risk.reasons).toEqual([]);

    // Propagates known Surf/curated logo onto non-risk FeedItem.logo and suppresses on risk clusters.
    const logoIndex = buildFeedLogoIndex(
      {
        cards: [
          {
            r: 1,
            n: 'AlphaProto',
            t: 'ALPHA',
            g: 'S',
            b: ['live'],
            img: 'https://images.asksurf.ai/alphaproto.png',
            f: '$10M',
            tk: '1/1',
            h: 100,
            u: 'today',
            fit: ['zero'],
            best: { n: 'Task', ty: 'testnet', c: 'Free', m: '5 min' },
            sc: 90,
            sub: [9, 9, null],
            url: 'https://alphaproto.xyz/',
            source: 'Surf',
          },
        ],
        tge: [],
        counts: { active: 1, preToken: 1 },
        fetchedAt: now,
      },
      null,
    );
    const logoItem = finalizeSnapshotCluster(
      {
        id: 'c-logo',
        project: 'AlphaProto',
        domain: 'alphaproto.xyz',
        chains: new Set(['Base']),
        taskTypes: new Set(['testnet']),
        summary: 'AlphaProto testnet live',
        urls: new Set(['https://alphaproto.xyz/claim']),
        rawIpUrls: new Set(),
        sources: [{ platform: 'telegram', handle: 'airdropfind', postUrl: 'https://t.me/airdropfind/3', postedAt: now }],
        sourceIds: new Set(['telegram:airdropfind']),
        sourceHandles: new Set(['airdropfind']),
        trustMax: 0.85,
        firstSeen: now,
        lastSeen: now,
        texts: ['AlphaProto testnet live https://alphaproto.xyz/claim'],
      },
      {
        projectDomains: new Map([['alphaproto.xyz', 'AlphaProto']]),
        platformDomains: new Set(['zealy.io']),
        allKnownDomains: new Set(['alphaproto.xyz', 'zealy.io']),
        logoIndex,
        nowMs: now,
      },
    );
    expect(logoItem.logo).toBe('https://images.asksurf.ai/alphaproto.png');

    const riskyLogoItem = finalizeSnapshotCluster(
      {
        id: 'c-risk-logo',
        project: 'AlphaProto',
        domain: 'a1phaproto.xyz',
        chains: new Set(['Base']),
        taskTypes: new Set(['testnet']),
        summary: 'Fake AlphaProto claim',
        urls: new Set(['https://a1phaproto.xyz/claim']),
        rawIpUrls: new Set(),
        sources: [{ platform: 'telegram', handle: 'airdropfind', postUrl: 'https://t.me/airdropfind/4', postedAt: now }],
        sourceIds: new Set(['telegram:airdropfind']),
        sourceHandles: new Set(['airdropfind']),
        trustMax: 0.85,
        firstSeen: now,
        lastSeen: now,
        texts: ['Fake AlphaProto claim https://a1phaproto.xyz/claim'],
      },
      {
        projectDomains: new Map([['alphaproto.xyz', 'AlphaProto']]),
        platformDomains: new Set(['zealy.io']),
        allKnownDomains: new Set(['alphaproto.xyz', 'zealy.io']),
        logoIndex,
        nowMs: now,
      },
    );
    expect(riskyLogoItem.risk.level).toBe('risk');
    expect(riskyLogoItem.logo).toBeUndefined();
  });

  test('resolveSnapshotSurfMatch does not use ticker fallback when a post has a different projectDomain, and parseWpCalendarFeedPayload rejects malformed objects', () => {
    const surfIndex = {
      byDomain: new Map([['knownsurf.xyz', { name: 'KnownSurf', tier: 'S' as const, cardRank: 1 }]]),
      byTicker: new Map([['SURF', { name: 'KnownSurf', tier: 'S' as const, cardRank: 1 }]]),
    };

    // Unmatched projectDomain + matching ticker must NOT attach another project's Surf tier
    expect(resolveSnapshotSurfMatch({ projectDomain: 'unrelated.xyz', ticker: 'SURF' }, surfIndex)).toBeUndefined();
    // Matching projectDomain still resolves
    expect(resolveSnapshotSurfMatch({ projectDomain: 'knownsurf.xyz', ticker: 'OTHER' }, surfIndex)?.tier).toBe('S');
    // No projectDomain -> ticker fallback preserved
    expect(resolveSnapshotSurfMatch({ ticker: 'SURF' }, surfIndex)?.tier).toBe('S');

    // Calendar payload validation: non-array object rejects; empty array succeeds
    expect(() => parseWpCalendarFeedPayload({ code: 'rest_forbidden' })).toThrow();
    expect(() => parseWpCalendarFeedPayload(null)).toThrow();
    expect(parseWpCalendarFeedPayload([])).toEqual([]);
  });
});

describe('snapshot hardening (M-34)', () => {
  test('isEnglishText rejects expanded CJK symbols, fullwidth, and Bopomofo matching check-no-cjk.sh', () => {
    expect(isEnglishText('Price 100\uFFE5')).toBe(false);
    expect(isEnglishText('Corp \u3231')).toBe(false);
    expect(isEnglishText('Vertical \uFE30 mark')).toBe(false);
    expect(isEnglishText('Bopomofo \u3105')).toBe(false);
  });

  test('single failing TG channel or empty HTTP-200 page does not discard live channels', async () => {
    const validHtml = `<div class="tgme_widget_message" data-post="alpha/10">
      <div class="tgme_widget_message_text">Alpha testnet airdrop live https://alpha.example.com</div>
      <a class="tgme_widget_message_date"><time datetime="2026-11-24T12:00:00+00:00"></time></a>
    </div>`;
    const empty200Html = '<html><body><div>If you have Telegram, you can view and join</div></body></html>';

    const collected = await collectLiveTelegramPosts(
      [{ handle: 'alpha' }, { handle: 'empty_ch' }, { handle: 'failed_ch' }],
      1_800_000_000_000,
      async handle => {
        if (handle === 'alpha') return validHtml;
        if (handle === 'empty_ch') return empty200Html;
        throw new Error('HTTP 503');
      },
    );

    expect(collected.liveChannelsSucceeded).toBe(1);
    expect(collected.channelPosts.has('alpha')).toBe(true);
    expect(collected.channelPosts.has('empty_ch')).toBe(false);
    expect(collected.channelPosts.has('failed_ch')).toBe(false);
    expect(collected.healthMap.get('telegram:alpha')?.status).toBe('ok');
    expect(collected.healthMap.get('telegram:empty_ch')?.status).toBe('down');
    expect(collected.healthMap.get('telegram:failed_ch')?.status).toBe('down');

    const liveFeed = { generatedAt: 200, items: [{ id: 'live-1' }] } as unknown as FeedResponse;
    const priorFeed = { generatedAt: 100, items: [{ id: 'prior-1' }] } as unknown as FeedResponse;
    expect(selectFeedOutput(liveFeed, collected.liveChannelsSucceeded, priorFeed)).toBe(liveFeed);
  });

  test('selectFeedOutput falls back to prior feed only when all channels fail or live drops are empty', () => {
    const emptyLive = { generatedAt: 200, items: [] } as unknown as FeedResponse;
    const nonEmptyLive = { generatedAt: 200, items: [{ id: 'live-1' }] } as unknown as FeedResponse;
    const priorFeed = { generatedAt: 100, items: [{ id: 'prior-1' }] } as unknown as FeedResponse;

    expect(selectFeedOutput(nonEmptyLive, 0, priorFeed)).toBe(priorFeed);
    expect(selectFeedOutput(emptyLive, 2, priorFeed)).toBe(priorFeed);
    expect(() => selectFeedOutput(emptyLive, 0, null)).toThrow();
  });

  test('resolveFixtureFetchedAt and buildAirdrops preserve fixture timestamp and never stamp nowMs', async () => {
    expect(resolveFixtureFetchedAt({ fetchedAt: 1_710_000_000_000, active: [] })).toBe(1_710_000_000_000);
    expect(
      resolveFixtureFetchedAt({
        active: [{ last_status_update: 1_795_100_000 }, { last_status_update: 1_795_242_900 }],
      }),
    ).toBe(1_795_242_900_000);
    expect(resolveFixtureFetchedAt({ active: [] })).toBe(0);

    const fixtureFallback = await buildAirdrops({
      workerBase: '',
      nowMs: 1_900_000_000_000,
      fetchLive: async () => {
        throw new Error('Surf down');
      },
      readPrior: async () => null,
      readFixture: async () => ({
        fetchedAt: 1_710_000_000_000,
        active: [{ project_name: 'TestProj', last_status_update: 1_700_000_000 }],
        tge: [],
      }),
    });
    expect(fixtureFallback.fetchedAt).toBe(1_710_000_000_000);
    expect(fixtureFallback.fetchedAt).not.toBe(1_900_000_000_000);
  });

  test('resolveWorkerBase prefers VITE_API_BASE over WORKER_URL and trims trailing slashes', () => {
    expect(resolveWorkerBase({ VITE_API_BASE: 'https://api.example.com///', WORKER_URL: 'https://old.example.com' })).toBe(
      'https://api.example.com',
    );
    expect(resolveWorkerBase({ VITE_API_BASE: '', WORKER_URL: 'https://fallback.example.com/' })).toBe(
      'https://fallback.example.com',
    );
    expect(resolveWorkerBase({})).toBe('');
  });

  test('validates /markets.json payload and preserves prior sectors when crypto fetch fails', () => {
    const validPayload: MarketsResponse = {
      generatedAt: 1,
      sections: [
        { ...section('crypto'), rows: [{ id: 'btc' } as never] },
        { ...section('defi'), rows: [{ id: 'aave' } as never] },
      ],
      sectors: [{ id: 'l1', name: 'L1', change24h: 1, marketCap: 100, share: 50 } as unknown as MarketSector],
    };
    expect(isValidMarketsPayload(validPayload)).toBe(true);
    expect(isValidMarketsPayload({ generatedAt: 1, sections: [], sectors: [] })).toBe(false);
    expect(isValidMarketsPayload({ generatedAt: 1, sections: [{ id: 'crypto', rows: [] }], sectors: [] })).toBe(false);

    const priorSectors: MarketSector[] = [
      { id: 'defi', name: 'DeFi', change24h: 2, marketCap: 50, share: 25 } as unknown as MarketSector,
    ];
    const merged = mergeMarketsWithPrior(
      [section('defi')],
      [],
      { sections: [section('crypto'), section('defi')], sectors: priorSectors },
      ['crypto', 'defi'],
    );
    expect(merged?.sections.map(s => s.id)).toEqual(['crypto', 'defi']);
    expect(merged?.sectors).toEqual(priorSectors);
  });

  test('validateSnapshotBundle enforces non-empty collections and zero forbidden CJK', () => {
    const airdrops = { cards: [{ r: 1, n: 'Alpha' }], tge: [], counts: { active: 1, preToken: 1 }, fetchedAt: 1 } as unknown as AirdropFeed;
    const markets = { generatedAt: 1, sections: [section('crypto')], sectors: [] } as MarketsResponse;
    const feed = { generatedAt: 1, items: [{ id: '1', summary: 'Clean English' }] } as unknown as FeedResponse;
    const sources = [{ id: 'telegram:alpha', platform: 'telegram', handle: 'alpha', status: 'ok', lastOkAt: 1 }] as SourceHealth[];

    expect(() => validateSnapshotBundle({ airdrops, markets, feed, sources })).not.toThrow();
    expect(() =>
      validateSnapshotBundle({ airdrops: { ...airdrops, cards: [] }, markets, feed, sources }),
    ).toThrow(/airdrops/i);
    expect(() =>
      validateSnapshotBundle({ airdrops, markets, feed, sources: [] }),
    ).toThrow(/sources/i);
    expect(() =>
      validateSnapshotBundle({
        airdrops,
        markets,
        feed: { generatedAt: 1, items: [{ id: '1', summary: 'Bad 100\uFFE5' }] } as unknown as FeedResponse,
        sources,
      }),
    ).toThrow(/CJK/i);
  });

  test('writeFileAtomic writes final content cleanly without leaving .tmp artifacts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'snapshot-atomic-'));
    try {
      const target = join(dir, 'feed.json');
      await writeFileAtomic(target, '{"ok":true}');
      expect(await readFile(target, 'utf8')).toBe('{"ok":true}');
      expect(await readdir(dir)).toEqual(['feed.json']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
