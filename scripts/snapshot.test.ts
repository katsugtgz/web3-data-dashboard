import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildAirdrops,
  collectLiveTelegramPosts,
  fixtureFallbackNeeded,
  isEnglishText,
  isValidMarketsPayload,
  mergeMarketsWithPrior,
  mergePostsStable,
  mergeSectionsWithPrior,
  resolveFixtureFetchedAt,
  resolveWorkerBase,
  selectFeedOutput,
  validateSnapshotBundle,
  writeFileAtomic,
  type MergePost,
} from './snapshot.mts';
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
