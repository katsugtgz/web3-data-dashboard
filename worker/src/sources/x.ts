import type { AirdropFeed } from '../../../shared/types';
import { FETCH_TIMEOUT_MS, USER_AGENT } from '../lib/format';
import {
  buildSurfIndex,
  ingestPostIntoCluster,
  type IngestPostResult,
  type SurfIndex,
} from '../normalize/cluster';
import {
  BENIGN_DNS_IPS,
  extractBareDomainUrls,
  getRegistrableDomain,
  isRawIpHost,
} from '../normalize/domains';
import { parseDropPost, type ParseContext } from '../normalize/parse';
import { loadKnownDomains, URL_SHORTENERS } from '../safety';

export interface ParsedXPost {
  idStr: string;
  postUrl: string;
  postedAt: number;
  text: string;
  urls: string[];
}

interface NextTweetEntityUrl {
  expanded_url?: string;
  display_url?: string;
  url?: string;
}

interface NextTweet {
  id_str?: string;
  id?: string | number;
  created_at?: string;
  full_text?: string;
  text?: string;
  permalink?: string;
  entities?: {
    urls?: NextTweetEntityUrl[];
  };
}

function extractTweetEntityUrls(entities?: NextTweetEntityUrl[]): string[] {
  const out: string[] = [];
  for (const item of entities ?? []) {
    const primary = item.expanded_url || item.url;
    if (primary && /^https?:\/\//i.test(primary)) {
      try {
        const host = new URL(primary).hostname.toLowerCase();
        if (isRawIpHost(host) && BENIGN_DNS_IPS.has(host)) continue;
      } catch {
        continue;
      }
      out.push(primary);

      const reg = getRegistrableDomain(primary);
      if (reg && URL_SHORTENERS[reg] && item.display_url) {
        for (const extra of extractBareDomainUrls(item.display_url)) {
          out.push(extra);
        }
      }
    }
  }
  return [...new Set(out)];
}

export function parseNextDataTimeline(html: string, handle: string): ParsedXPost[] {
  const m = html.match(/<script\s+id="__NEXT_DATA__"\s+type="application\/json">([\s\S]*?)<\/script>/i);
  if (!m) return [];
  try {
    const json = JSON.parse(m[1]) as {
      props?: { pageProps?: { timeline?: { entries?: { content?: { tweet?: NextTweet } }[] } } };
    };
    const entries = json?.props?.pageProps?.timeline?.entries ?? [];
    const out: ParsedXPost[] = [];
    for (const entry of entries) {
      const tweet = entry?.content?.tweet;
      if (!tweet) continue;
      const idStr = String(tweet.id_str ?? tweet.id ?? '');
      if (!idStr) continue;
      const text = (tweet.full_text ?? tweet.text ?? '').trim();
      if (!text) continue;
      // Undated/invalid timestamps must be REJECTED, not stamped as now: the
      // 14-day cutoff would otherwise admit stale undated tweets forever.
      const parsedTime = tweet.created_at ? Date.parse(tweet.created_at) : NaN;
      if (!Number.isFinite(parsedTime)) continue;
      const urls = extractTweetEntityUrls(tweet.entities?.urls);
      const postUrl = tweet.permalink
        ? tweet.permalink.startsWith('http')
          ? tweet.permalink
          : `https://x.com${tweet.permalink}`
        : `https://x.com/${handle}/status/${idStr}`;
      out.push({
        idStr,
        postUrl,
        postedAt: parsedTime,
        text,
        urls,
      });
    }
    return out;
  } catch {
    return [];
  }
}

export function parseCdnSyndication(body: string, handle: string): ParsedXPost[] {
  const trimmed = body.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const data = JSON.parse(trimmed) as { entries?: NextTweet[] } | NextTweet[];
      const list = Array.isArray(data) ? data : (data.entries ?? []);
      return list
        .map(tweet => {
          const idStr = String(tweet.id_str ?? tweet.id ?? '');
          const text = (tweet.full_text ?? tweet.text ?? '').trim();
          if (!idStr || !text) return null;
          // Same rejection as the __NEXT_DATA__ path: no valid timestamp, no post.
          const parsedTime = tweet.created_at ? Date.parse(tweet.created_at) : NaN;
          if (!Number.isFinite(parsedTime)) return null;
          const urls = extractTweetEntityUrls(tweet.entities?.urls);
          return {
            idStr,
            postUrl: `https://x.com/${handle}/status/${idStr}`,
            postedAt: parsedTime,
            text,
            urls,
          };
        })
        .filter((p): p is ParsedXPost => p !== null);
    } catch {
      return [];
    }
  }
  return parseNextDataTimeline(trimmed, handle);
}

const TWENTY_FOUR_H_MS = 24 * 3_600_000;
const SIX_H_MS = 6 * 3_600_000;
const FOURTEEN_DAYS_MS = 14 * 86_400_000;

export function computeXBackoff(
  prevFailCount: number,
  prevFirstFailAt: number | null,
  nowMs: number,
): {
  failCount: number;
  firstFailAt: number;
  status: 'degraded' | 'down';
  nextPollAt: number;
} {
  const failCount = prevFailCount + 1;
  const firstFailAt = prevFirstFailAt ?? nowMs;
  if (nowMs - firstFailAt >= TWENTY_FOUR_H_MS) {
    return {
      failCount,
      firstFailAt,
      status: 'down',
      nextPollAt: nowMs + SIX_H_MS,
    };
  }
  const expMinutes = Math.min(120, 5 * 2 ** Math.min(5, failCount - 1));
  return {
    failCount,
    firstFailAt,
    status: 'degraded',
    nextPollAt: nowMs + expMinutes * 60_000,
  };
}

export async function fetchXTimelineBestEffort(handle: string): Promise<ParsedXPost[]> {
  const urls = [
    `https://cdn.syndication.twimg.com/timeline/profile?screen_name=${encodeURIComponent(handle)}`,
    `https://syndication.twitter.com/srv/timeline-profile/screen-name/${encodeURIComponent(handle)}`,
  ];

  for (const endpoint of urls) {
    try {
      const res = await fetch(endpoint, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) continue;
      const body = await res.text();
      if (!body.trim()) continue;
      const parsed = endpoint.includes('cdn.syndication')
        ? parseCdnSyndication(body, handle)
        : parseNextDataTimeline(body, handle);
      if (parsed.length > 0) return parsed;
    } catch {
      // Expected failure on X syndication endpoints; try next or degrade cleanly
    }
  }
  throw new Error(`X endpoints unavailable for @${handle}`);
}

interface XSourceRow {
  id: string;
  handle: string;
  lang: string | null;
  trust: number;
  last_seen_id: string | null;
  fail_count: number;
  first_fail_at: number | null;
}

export interface XPollSummary {
  polled: number;
  insertedPosts: number;
  degraded: number;
  ingestedResults: IngestPostResult[];
}

function compareSnowflakeIds(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

async function pollSingleXSource(
  db: D1Database,
  src: XSourceRow,
  parseCtx: ParseContext,
  surfIndex: SurfIndex,
  projectDomains: Map<string, string>,
  platformDomains: Set<string> | undefined,
  nowMs: number,
  fetcher: (handle: string) => Promise<ParsedXPost[]>,
): Promise<{ insertedPosts: number; degraded: boolean; ingestedResults: IngestPostResult[] }> {
  const cutoffMs = nowMs - FOURTEEN_DAYS_MS;
  try {
    const posts = await fetcher(src.handle);
    if (posts.length === 0) throw new Error(`0 tweets parsed for @${src.handle}`);

    let maxSeen = src.last_seen_id ?? '';
    const newPosts = posts.filter(p => {
      if (!maxSeen || compareSnowflakeIds(p.idStr, maxSeen) > 0) maxSeen = p.idStr;
      if (src.last_seen_id && compareSnowflakeIds(p.idStr, src.last_seen_id) <= 0) return false;
      return p.postedAt >= cutoffMs;
    });

    const sourceParseCtx: ParseContext = {
      ...parseCtx,
      sourceLang: src.lang ?? undefined,
      surfByDomain: surfIndex.byDomain,
      surfByTicker: surfIndex.byTicker,
    };

    const relevantPosts = newPosts
      .map(post => ({ post, parsed: parseDropPost(post.text, post.urls, sourceParseCtx) }))
      .filter(entry => entry.parsed.isRelevantDrop);

    const ingestedResults = await Promise.all(
      relevantPosts.map(({ post: p, parsed }) =>
        ingestPostIntoCluster(
          db,
          {
            postId: `x:${src.handle}:${p.idStr}`,
            sourceId: src.id,
            sourceTrust: src.trust,
            postUrl: p.postUrl,
            postedAt: p.postedAt,
            text: p.text,
            htmlUrls: p.urls,
            sourceLang: src.lang ?? undefined,
          },
          sourceParseCtx,
          surfIndex,
          projectDomains,
          platformDomains,
          nowMs,
          parsed,
        ),
      ),
    );

    await db
      .prepare(
        `UPDATE sources
         SET last_seen_id = ?2, last_ok_at = ?3, last_polled_at = ?3,
             status = 'ok', fail_count = 0, first_fail_at = NULL, next_poll_at = NULL
         WHERE id = ?1`,
      )
      .bind(src.id, maxSeen || src.last_seen_id, nowMs)
      .run();

    return { insertedPosts: ingestedResults.length, degraded: false, ingestedResults };
  } catch (err) {
    console.error(`x-poll-error:${src.id}`, err);
    const backoff = computeXBackoff(src.fail_count ?? 0, src.first_fail_at ?? null, nowMs);
    await db
      .prepare(
        `UPDATE sources
         SET last_polled_at = ?2, fail_count = ?3, first_fail_at = ?4, status = ?5, next_poll_at = ?6
         WHERE id = ?1`,
      )
      .bind(src.id, nowMs, backoff.failCount, backoff.firstFailAt, backoff.status, backoff.nextPollAt)
      .run();
    return { insertedPosts: 0, degraded: true, ingestedResults: [] };
  }
}

export async function pollXBatch(
  db: D1Database,
  batchSize = 3,
  nowMs = Date.now(),
  surfFeed?: AirdropFeed | null,
  fetcher: (handle: string) => Promise<ParsedXPost[]> = fetchXTimelineBestEffort,
): Promise<XPollSummary> {
  const res = await db
    .prepare(
      `SELECT id, handle, lang, trust, last_seen_id, fail_count, first_fail_at
       FROM sources
       WHERE platform = 'x' AND enabled = 1 AND (next_poll_at IS NULL OR next_poll_at <= ?1)
       ORDER BY last_polled_at ASC NULLS FIRST
       LIMIT ?2`,
    )
    .bind(nowMs, batchSize)
    .all<XSourceRow>();

  const sources = res.results ?? [];
  if (sources.length === 0) {
    return { polled: 0, insertedPosts: 0, degraded: 0, ingestedResults: [] };
  }

  let projectDomains: Map<string, string>;
  let platformDomains: Set<string> | undefined;
  try {
    ({ projectDomains, platformDomains } = await loadKnownDomains(db));
  } catch (err) {
    console.error('x-poll-error:loadKnownDomains', err);
    await Promise.all(
      sources.map(src =>
        db
          .prepare(`UPDATE sources SET last_polled_at = ?2, status = 'degraded' WHERE id = ?1`)
          .bind(src.id, nowMs)
          .run(),
      ),
    );
    return { polled: sources.length, insertedPosts: 0, degraded: sources.length, ingestedResults: [] };
  }
  const surfIndex = buildSurfIndex(surfFeed);
  const parseCtx: ParseContext = { knownDomains: projectDomains };

  const outcomes = (
    await Promise.all(
      sources.map(async src => {
        try {
          return await pollSingleXSource(db, src, parseCtx, surfIndex, projectDomains, platformDomains, nowMs, fetcher);
        } catch (err) {
          console.error(`x-poll-error:${src.id}`, err);
          return { insertedPosts: 0, degraded: true, ingestedResults: [] };
        }
      }),
    )
  ).flat();

  let insertedPosts = 0;
  let degraded = 0;
  const ingestedResults: IngestPostResult[] = [];
  for (const o of outcomes) {
    insertedPosts += o.insertedPosts;
    if (o.degraded) degraded++;
    ingestedResults.push(...o.ingestedResults);
  }

  return { polled: sources.length, insertedPosts, degraded, ingestedResults };
}
