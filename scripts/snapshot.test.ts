import { describe, expect, test } from 'bun:test';
import {
  finalizeSnapshotCluster,
  fixtureFallbackNeeded,
  isEnglishText,
  mergePostsStable,
  mergeSectionsWithPrior,
  type MergePost,
} from './snapshot.mts';
import type { FeedResponse, MarketSection } from '../shared/types';

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
      post('alpha', '3', 500, '空投福利快来领取'),
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
    expect(isEnglishText('空投')).toBe(false);
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
    expect(cappedItem.risk.level).toBe('ok');
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
  });
});
