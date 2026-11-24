import type { FeedItem, FeedResponse } from '../../shared/types';
import { getJson, type JsonFetchResult } from './api';
import { mergeVisibleUpdates, selectPending } from './feedMerge';

const MAX_CONTINUATION_PAGES = 10;
const DEFAULT_MAX_CHUNKS_PER_POLL = 10;

export type FeedFetcher = (
  path: string,
  etag?: string | null,
  signal?: AbortSignal,
) => Promise<JsonFetchResult<FeedResponse>>;

export interface FeedFetchOptions {
  maxContinuationPages?: number;
  startCursor?: string;
  initialItems?: readonly FeedItem[];
  initialGeneratedAt?: number;
  seenCursors?: ReadonlySet<string>;
}

export interface FeedPageRecord {
  path: string;
  etag: string | null;
  body: FeedResponse;
}

export interface FeedSessionConfig {
  limit?: number;
  maxContinuationPages?: number;
  maxChunksPerPoll?: number;
}

export interface FeedSession {
  fetch: (signal?: AbortSignal, opts?: { resetResume?: boolean }) => Promise<JsonFetchResult<FeedResponse>>;
}

function appendUniqueItems(target: FeedItem[], seenIds: Set<string>, items: readonly FeedItem[], limit: number): void {
  for (const item of items) {
    if (target.length >= limit) break;
    if (seenIds.has(item.id)) continue;
    seenIds.add(item.id);
    target.push(item);
  }
}

function buildCursorPath(cursor: string, remaining: number): string {
  return `/feed.json?cursor=${encodeURIComponent(cursor)}&limit=${remaining}`;
}

/**
 * Fetches `/feed.json` (or resumes from `options.startCursor`) and follows
 * scan-budget continuation `cursor` tokens up to `maxContinuationPages`.
 * Clears `etag` whenever continuation pages are read so page-1 ETags never
 * suppress updates on later pages, and preserves any unexhausted `cursor`.
 */
export async function fetchFeedPages(
  etag?: string | null,
  signal?: AbortSignal,
  fetcher: FeedFetcher = getJson,
  limit = 100,
  options?: FeedFetchOptions,
): Promise<JsonFetchResult<FeedResponse>> {
  const maxPages = options?.maxContinuationPages ?? MAX_CONTINUATION_PAGES;
  const seenIds = new Set<string>();
  const merged: FeedItem[] = [];
  if (options?.initialItems) {
    appendUniqueItems(merged, seenIds, options.initialItems, limit);
  }

  let generatedAt = options?.initialGeneratedAt ?? 0;
  let nextCursor: string | undefined = options?.startCursor;
  let usedContinuation = Boolean(options?.startCursor);
  let firstEtag: string | null = null;
  let fellBackToSnapshot = false;

  if (!options?.startCursor) {
    const first = await fetcher('/feed.json', etag, signal);
    if (first.status === 304 || first.source !== 'api') {
      return first;
    }
    firstEtag = first.etag;
    generatedAt = Math.max(generatedAt, first.body.generatedAt);
    appendUniqueItems(merged, seenIds, first.body.items, limit);
    if (!first.body.cursor || merged.length >= limit) {
      return first;
    }
    nextCursor = first.body.cursor;
    usedContinuation = true;
  }

  const seenCursors = new Set<string>(options?.seenCursors);
  let pages = 0;

  while (nextCursor && merged.length < limit && pages < maxPages) {
    if (seenCursors.has(nextCursor)) {
      nextCursor = undefined;
      break;
    }
    seenCursors.add(nextCursor);
    pages += 1;
    const remaining = Math.max(1, limit - merged.length);
    const nextPath = buildCursorPath(nextCursor, remaining);
    const nextRes = await fetcher(nextPath, null, signal);
    if (nextRes.status !== 200 || nextRes.source !== 'api') {
      fellBackToSnapshot = true;
      nextCursor = undefined;
      break;
    }
    if (nextRes.body.generatedAt > generatedAt) {
      generatedAt = nextRes.body.generatedAt;
    }
    appendUniqueItems(merged, seenIds, nextRes.body.items, limit);
    nextCursor = nextRes.body.cursor;
  }

  const preservedCursor =
    !fellBackToSnapshot && merged.length < limit && nextCursor && !seenCursors.has(nextCursor)
      ? nextCursor
      : undefined;

  return {
    status: 200,
    body: {
      generatedAt,
      items: merged,
      ...(preservedCursor ? { cursor: preservedCursor } : {}),
    },
    etag: usedContinuation ? null : firstEtag,
    source: 'api',
  };
}

interface PendingSessionResume {
  cursor: string;
  items: FeedItem[];
  generatedAt: number;
  seenIds: Set<string>;
  seenCursors: Set<string>;
  pages: Map<string, FeedPageRecord>;
  anyModified: boolean;
  usedContinuation: boolean;
  firstEtag: string | null;
}

/**
 * Stateful `/feed.json` fetcher that tracks per-page ETags across all
 * continuation pages and resumes cursor chains past `maxContinuationPages`
 * without dropping trailing items or short-circuiting on a page-1 304.
 */
export function createFeedSession(
  fetcher: FeedFetcher = getJson,
  config: FeedSessionConfig = {},
): FeedSession {
  const limit = config.limit ?? 100;
  const maxContinuationPages = Math.max(1, config.maxContinuationPages ?? MAX_CONTINUATION_PAGES);
  const maxChunksPerPoll = Math.max(1, config.maxChunksPerPoll ?? DEFAULT_MAX_CHUNKS_PER_POLL);

  let cachedPages = new Map<string, FeedPageRecord>();
  let pendingResume: PendingSessionResume | null = null;

  async function fetchPageWithCache(
    path: string,
    signal: AbortSignal | undefined,
    nextPages: Map<string, FeedPageRecord>,
  ): Promise<{ kind: 'api'; body: FeedResponse; etag: string | null; modified: boolean } | { kind: 'fallback'; res: JsonFetchResult<FeedResponse> }> {
    const prevRecord = cachedPages.get(path);
    const res = await fetcher(path, prevRecord?.etag ?? null, signal);
    if (res.status === 304) {
      if (prevRecord) {
        nextPages.set(path, prevRecord);
        return { kind: 'api', body: prevRecord.body, etag: prevRecord.etag, modified: false };
      }
      // Uncached 304 cannot supply a body; re-fetch cleanly without an ETag.
      const fresh = await fetcher(path, null, signal);
      if (fresh.status !== 200 || fresh.source !== 'api') {
        return { kind: 'fallback', res: fresh };
      }
      nextPages.set(path, { path, etag: fresh.etag, body: fresh.body });
      return { kind: 'api', body: fresh.body, etag: fresh.etag, modified: true };
    }
    if (res.source !== 'api') {
      return { kind: 'fallback', res };
    }
    nextPages.set(path, { path, etag: res.etag, body: res.body });
    return { kind: 'api', body: res.body, etag: res.etag, modified: true };
  }

  return {
    async fetch(signal, opts) {
      if (opts?.resetResume) {
        pendingResume = null;
      }

      const active = pendingResume;
      const seenIds = active ? new Set(active.seenIds) : new Set<string>();
      const seenCursors = active ? new Set(active.seenCursors) : new Set<string>();
      const merged = active ? [...active.items] : [];
      const nextPages = active ? new Map(active.pages) : new Map<string, FeedPageRecord>();
      let generatedAt = active?.generatedAt ?? 0;
      let anyModified = active?.anyModified ?? false;
      let usedContinuation = active?.usedContinuation ?? false;
      let firstEtag = active?.firstEtag ?? null;
      let nextCursor: string | undefined = active?.cursor;
      let fellBack = false;

      if (!active) {
        const root = await fetchPageWithCache('/feed.json', signal, nextPages);
        if (root.kind === 'fallback') {
          cachedPages = new Map();
          pendingResume = null;
          return root.res;
        }
        anyModified = anyModified || root.modified;
        firstEtag = root.etag;
        generatedAt = Math.max(generatedAt, root.body.generatedAt);
        appendUniqueItems(merged, seenIds, root.body.items, limit);
        if (root.body.cursor && merged.length < limit) {
          nextCursor = root.body.cursor;
          usedContinuation = true;
        }
      }

      const pageBudget = maxContinuationPages * maxChunksPerPoll;
      let continuationPages = 0;

      while (nextCursor && merged.length < limit && continuationPages < pageBudget) {
        signal?.throwIfAborted();
        if (seenCursors.has(nextCursor)) {
          nextCursor = undefined;
          break;
        }
        seenCursors.add(nextCursor);
        continuationPages += 1;

        const remaining = Math.max(1, limit - merged.length);
        const pagePath = buildCursorPath(nextCursor, remaining);
        const page = await fetchPageWithCache(pagePath, signal, nextPages);
        if (page.kind === 'fallback') {
          fellBack = true;
          nextCursor = undefined;
          cachedPages = new Map();
          pendingResume = null;
          break;
        }

        anyModified = anyModified || page.modified;
        if (page.body.generatedAt > generatedAt) {
          generatedAt = page.body.generatedAt;
        }
        appendUniqueItems(merged, seenIds, page.body.items, limit);
        nextCursor = page.body.cursor;
      }

      const preservedCursor =
        !fellBack && merged.length < limit && nextCursor && !seenCursors.has(nextCursor)
          ? nextCursor
          : undefined;

      if (preservedCursor) {
        pendingResume = {
          cursor: preservedCursor,
          items: merged,
          generatedAt,
          seenIds,
          seenCursors,
          pages: nextPages,
          anyModified,
          usedContinuation: true,
          firstEtag,
        };
        return {
          status: 200,
          body: {
            generatedAt,
            items: merged,
            cursor: preservedCursor,
          },
          etag: null,
          source: 'api',
        };
      }

      pendingResume = null;
      if (!fellBack) {
        cachedPages = nextPages;
        if (!anyModified && !active) {
          return { status: 304 };
        }
      }

      return {
        status: 200,
        body: {
          generatedAt,
          items: merged,
        },
        etag: !fellBack && !usedContinuation ? firstEtag : null,
        source: 'api',
      };
    },
  };
}

export interface ReconciledFeedUpdate {
  items: FeedItem[];
  pending: FeedItem[] | null;
  knownIds: Set<string>;
  generatedAt: number | null;
  preserved: boolean;
}

/**
 * Reconciles a 200 `/feed.json` response against currently displayed items.
 * When `res.cursor` indicates a partial multi-poll scan and items are already
 * visible, preserves the current list intact until the scan finishes.
 */
export function reconcileFeedUpdate(
  displayed: FeedItem[],
  knownIds: ReadonlySet<string>,
  res: FeedResponse,
  mode: 'initial' | 'manual' | 'background',
): ReconciledFeedUpdate {
  if (res.cursor && displayed.length > 0) {
    return {
      items: displayed,
      pending: null,
      knownIds: new Set(knownIds),
      generatedAt: null,
      preserved: true,
    };
  }

  if (mode !== 'background') {
    return {
      items: res.items,
      pending: [],
      knownIds: new Set(res.items.map(it => it.id)),
      generatedAt: res.generatedAt,
      preserved: false,
    };
  }

  const queued = selectPending(res.items, knownIds);
  const next = displayed.length === 0 ? res.items : mergeVisibleUpdates(displayed, res.items);
  return {
    items: next,
    pending: queued ?? [],
    knownIds: new Set(next.map(it => it.id)),
    generatedAt: res.generatedAt,
    preserved: false,
  };
}
