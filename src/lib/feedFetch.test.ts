import { describe, expect, test } from 'bun:test';
import type { FeedItem, FeedResponse } from '../../shared/types';
import { createFeedSession, fetchFeedPages, type FeedFetcher } from './feedFetch';

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
      expect(res.etag).toBeNull();
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

  test('preserves cursor when continuation page cap is hit, resumes to 5501st row, and guards repeated cursors', async () => {
    const paginatedFetcher: FeedFetcher = async path => {
      if (path === '/feed.json') {
        return { status: 200, body: { generatedAt: 100, items: [], cursor: 'c1' }, etag: '"e0"', source: 'api' };
      }
      const m = path.match(/cursor=c(\d+)/);
      const pageIdx = m ? Number(m[1]) : 0;
      if (pageIdx < 11) {
        return {
          status: 200,
          body: { generatedAt: 100 + pageIdx, items: [], cursor: `c${pageIdx + 1}` },
          etag: `"e${pageIdx}"`,
          source: 'api',
        };
      }
      return {
        status: 200,
        body: { generatedAt: 200, items: [makeFeedItem('drop_5501', 200)] },
        etag: '"e11"',
        source: 'api',
      };
    };

    const chunk1 = await fetchFeedPages(null, undefined, paginatedFetcher);
    expect(chunk1.status).toBe(200);
    if (chunk1.status === 200) {
      expect(chunk1.body.items).toEqual([]);
      expect(chunk1.body.cursor).toBe('c11');
      expect(chunk1.etag).toBeNull();

      const chunk2 = await fetchFeedPages(null, undefined, paginatedFetcher, 100, {
        startCursor: chunk1.body.cursor,
        initialItems: chunk1.body.items,
        initialGeneratedAt: chunk1.body.generatedAt,
      });
      expect(chunk2.status).toBe(200);
      if (chunk2.status === 200) {
        expect(chunk2.body.items.map(i => i.id)).toEqual(['drop_5501']);
        expect(chunk2.body.cursor).toBeUndefined();
      }
    }

    // Repeated cursor cycle terminates safely without infinite loop or leaking cursor.
    let loopCalls = 0;
    const loopFetcher: FeedFetcher = async () => {
      loopCalls += 1;
      return {
        status: 200,
        body: { generatedAt: 100, items: [], cursor: 'same_cursor' },
        etag: '"loop"',
        source: 'api',
      };
    };
    const loopRes = await fetchFeedPages(null, undefined, loopFetcher);
    expect(loopCalls).toBe(2);
    expect(loopRes.status).toBe(200);
    if (loopRes.status === 200) {
      expect(loopRes.body.cursor).toBeUndefined();
    }
  });
});

describe('createFeedSession', () => {
  test('resumes across more than 10 continuation pages and carries leftover cursors across polls when maxChunksPerPoll is exceeded', async () => {
    const fetcher: FeedFetcher = async path => {
      if (path === '/feed.json') {
        return { status: 200, body: { generatedAt: 100, items: [], cursor: 'c1' }, etag: '"e0"', source: 'api' };
      }
      const idx = Number(path.match(/cursor=c(\d+)/)?.[1] ?? '0');
      if (idx < 11) {
        return {
          status: 200,
          body: { generatedAt: 100 + idx, items: [], cursor: `c${idx + 1}` },
          etag: `"e${idx}"`,
          source: 'api',
        };
      }
      return {
        status: 200,
        body: { generatedAt: 500, items: [makeFeedItem('drop_5501', 500)] },
        etag: '"e11"',
        source: 'api',
      };
    };

    // Uncapped chunks per poll reaches row 5501 in one fetch call.
    const autoSession = createFeedSession(fetcher, { limit: 100, maxContinuationPages: 10, maxChunksPerPoll: 5 });
    const full = await autoSession.fetch();
    expect(full.status).toBe(200);
    if (full.status === 200) {
      expect(full.body.items.map(i => i.id)).toEqual(['drop_5501']);
      expect(full.body.cursor).toBeUndefined();
    }

    // With maxChunksPerPoll = 1, poll 1 preserves cursor and poll 2 resumes directly from c11.
    const steppedCalls: string[] = [];
    const steppedSession = createFeedSession(
      async (path, etag, signal) => {
        steppedCalls.push(path);
        return fetcher(path, etag, signal);
      },
      { limit: 100, maxContinuationPages: 10, maxChunksPerPoll: 1 },
    );
    const poll1 = await steppedSession.fetch();
    expect(poll1.status).toBe(200);
    if (poll1.status === 200) {
      expect(poll1.body.items).toEqual([]);
      expect(poll1.body.cursor).toBe('c11');
    }
    const poll2 = await steppedSession.fetch();
    expect(poll2.status).toBe(200);
    if (poll2.status === 200) {
      expect(poll2.body.items.map(i => i.id)).toEqual(['drop_5501']);
      expect(poll2.body.cursor).toBeUndefined();
    }
    expect(steppedCalls[11]).toBe('/feed.json?cursor=c11&limit=100');
  });

  test('validates ETags across all continuation pages instead of short-circuiting on page 1 304', async () => {
    let page2Version = 1;
    const calls: { path: string; etag: string | null | undefined }[] = [];
    const fetcher: FeedFetcher = async (path, etag) => {
      calls.push({ path, etag });
      if (path === '/feed.json') {
        if (etag === '"p1-v1"') return { status: 304 };
        return {
          status: 200,
          body: { generatedAt: 100, items: [], cursor: 'c1' },
          etag: '"p1-v1"',
          source: 'api',
        };
      }
      const currentTag = `"p2-v${page2Version}"`;
      if (etag === currentTag) return { status: 304 };
      return {
        status: 200,
        body: {
          generatedAt: page2Version === 1 ? 200 : 300,
          items: [makeFeedItem(`drop_v${page2Version}`, page2Version === 1 ? 200 : 300)],
        },
        etag: currentTag,
        source: 'api',
      };
    };

    const session = createFeedSession(fetcher);

    // Poll 1: loads page 1 + page 2 (v1).
    const r1 = await session.fetch();
    expect(r1.status).toBe(200);
    if (r1.status === 200) {
      expect(r1.body.items.map(i => i.id)).toEqual(['drop_v1']);
    }

    // Poll 2: page 1 returns 304 AND page 2 returns 304 -> session returns 304.
    const r2 = await session.fetch();
    expect(r2).toEqual({ status: 304 });

    // Poll 3: page 1 STILL returns 304, but page 2 changed to v2 -> must return 200 with v2 item!
    page2Version = 2;
    const r3 = await session.fetch();
    expect(r3.status).toBe(200);
    if (r3.status === 200) {
      expect(r3.body.items.map(i => i.id)).toEqual(['drop_v2']);
      expect(r3.body.generatedAt).toBe(300);
    }

    // Poll 4: both pages unchanged again -> 304 using updated page 2 ETag.
    const r4 = await session.fetch();
    expect(r4).toEqual({ status: 304 });
    expect(calls.slice(-2)).toEqual([
      { path: '/feed.json', etag: '"p1-v1"' },
      { path: '/feed.json?cursor=c1&limit=100', etag: '"p2-v2"' },
    ]);
  });
});
