import { describe, expect, test } from 'bun:test';
import type { FeedItem, FeedResponse } from '../../shared/types';
import { fetchFeedPages, type FeedFetcher } from './feedFetch';

function makeFeedItem(id: string, lastSeen = 1_795_364_909_000): FeedItem {
  return {
    id,
    project: `Project ${id}`,
    chains: [],
    taskTypes: ['testnet'],
    summary: 'Testnet airdrop live.',
    links: [{ url: `https://${id}.xyz/claim`, known: false }],
    sources: [{ platform: 'telegram', handle: 'ch1', postUrl: `https://t.me/ch1/${id}`, postedAt: lastSeen }],
    sourceCount: 1,
    score: 0.5,
    risk: { level: 'ok', reasons: [] },
    firstSeen: lastSeen,
    lastSeen,
  };
}

describe('fetchFeedPages', () => {
  test('follows cursor across multiple API pages until exhausted and dedupes items', async () => {
    const calls: { path: string; etag: string | null | undefined }[] = [];
    const fetcher: FeedFetcher = async (path, etag) => {
      calls.push({ path, etag });
      if (path === '/feed.json') {
        const body: FeedResponse = {
          generatedAt: 100,
          items: [],
          cursor: 'score|0.9|100|noise_1',
        };
        return { status: 200, body, etag: '"e1"', source: 'api' };
      }
      if (path === '/feed.json?cursor=score%7C0.9%7C100%7Cnoise_1&limit=100') {
        const body: FeedResponse = {
          generatedAt: 200,
          items: [makeFeedItem('drop_1', 200)],
          cursor: 'score|0.5|200|drop_1',
        };
        return { status: 200, body, etag: '"e2"', source: 'api' };
      }
      const body: FeedResponse = {
        generatedAt: 150,
        items: [makeFeedItem('drop_1', 200), makeFeedItem('drop_2', 300)],
      };
      return { status: 200, body, etag: '"e3"', source: 'api' };
    };

    const res = await fetchFeedPages('"prev"', undefined, fetcher);
    expect(calls).toEqual([
      { path: '/feed.json', etag: '"prev"' },
      { path: '/feed.json?cursor=score%7C0.9%7C100%7Cnoise_1&limit=100', etag: null },
      { path: '/feed.json?cursor=score%7C0.5%7C200%7Cdrop_1&limit=99', etag: null },
    ]);
    expect(res.status).toBe(200);
    if (res.status === 200) {
      expect(res.source).toBe('api');
      expect(res.etag).toBe('"e1"');
      expect(res.body.generatedAt).toBe(200);
      expect(res.body.items.map(i => i.id)).toEqual(['drop_1', 'drop_2']);
      expect(res.body.cursor).toBeUndefined();
    }
  });

  test('returns single-page response and 304 untouched without extra requests', async () => {
    let calls = 0;
    const singleFetcher: FeedFetcher = async () => {
      calls++;
      return {
        status: 200,
        body: { generatedAt: 500, items: [makeFeedItem('drop_a', 500)] },
        etag: '"single"',
        source: 'api',
      };
    };
    const single = await fetchFeedPages(null, undefined, singleFetcher);
    expect(calls).toBe(1);
    expect(single.status).toBe(200);

    const notModFetcher: FeedFetcher = async () => ({ status: 304 });
    const notMod = await fetchFeedPages('"same"', undefined, notModFetcher);
    expect(notMod).toEqual({ status: 304 });
  });

  test('stops cleanly and clears etag when a continuation page falls back to snapshot', async () => {
    const fetcher: FeedFetcher = async path => {
      if (path === '/feed.json') {
        return {
          status: 200,
          body: { generatedAt: 100, items: [makeFeedItem('drop_1', 100)], cursor: 'score|0.8|100|n1' },
          etag: '"e1"',
          source: 'api',
        };
      }
      return {
        status: 200,
        body: { generatedAt: 999, items: [makeFeedItem('snap_1', 999)] },
        etag: null,
        source: 'snapshot',
      };
    };

    const res = await fetchFeedPages(null, undefined, fetcher);
    expect(res.status).toBe(200);
    if (res.status === 200) {
      expect(res.etag).toBeNull();
      expect(res.body.items.map(i => i.id)).toEqual(['drop_1']);
    }
  });
});
