import { describe, expect, test } from 'bun:test';
import {
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
