import type { FeedItem, FeedResponse } from '../../shared/types';
import { getJson, type JsonFetchResult } from './api';

const MAX_CONTINUATION_PAGES = 10;

export type FeedFetcher = (
  path: string,
  etag?: string | null,
  signal?: AbortSignal,
) => Promise<JsonFetchResult<FeedResponse>>;

/**
 * Fetches `/feed.json` and follows scan-budget continuation `cursor` tokens
 * until `limit` items are collected, pages are exhausted, or a fallback occurs.
 */
export async function fetchFeedPages(
  etag?: string | null,
  signal?: AbortSignal,
  fetcher: FeedFetcher = getJson,
  limit = 100,
): Promise<JsonFetchResult<FeedResponse>> {
  const first = await fetcher('/feed.json', etag, signal);
  if (first.status === 304 || first.source !== 'api' || !first.body.cursor || first.body.items.length >= limit) {
    return first;
  }

  const seenIds = new Set<string>();
  const merged: FeedItem[] = [];
  let generatedAt = first.body.generatedAt;
  for (const item of first.body.items) {
    if (seenIds.has(item.id)) continue;
    seenIds.add(item.id);
    merged.push(item);
  }

  let nextCursor: string | undefined = first.body.cursor;
  let pages = 0;
  let resultEtag = first.etag;

  while (nextCursor && merged.length < limit && pages < MAX_CONTINUATION_PAGES) {
    pages += 1;
    const remaining = Math.max(1, limit - merged.length);
    const nextPath = `/feed.json?cursor=${encodeURIComponent(nextCursor)}&limit=${remaining}`;
    const nextRes = await fetcher(nextPath, null, signal);
    if (nextRes.status !== 200 || nextRes.source !== 'api') {
      resultEtag = null;
      break;
    }
    if (nextRes.body.generatedAt > generatedAt) {
      generatedAt = nextRes.body.generatedAt;
    }
    for (const item of nextRes.body.items) {
      if (seenIds.has(item.id)) continue;
      seenIds.add(item.id);
      merged.push(item);
      if (merged.length >= limit) break;
    }
    nextCursor = nextRes.body.cursor;
  }

  return {
    status: 200,
    body: {
      generatedAt,
      items: merged,
    },
    etag: resultEtag,
    source: 'api',
  };
}
