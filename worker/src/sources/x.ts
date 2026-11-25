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
  cleanUrl,
  extractBareDomainUrls,
  extractSuspiciousRawIpUrls,
  extractUrls,
  getRegistrableDomain,
  isRawIpHost,
} from '../normalize/domains';
import { parseDropPost, type ParseContext } from '../normalize/parse';
import { loadKnownDomains, URL_SHORTENERS } from '../safety';
import { decodeHtmlEntities } from './telegram';

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
const MAX_POSTS_PER_POLL = 10;
const MIRROR_TIMEOUT_MS = Math.min(FETCH_TIMEOUT_MS, 7000);

function parseSafeMirrorBase(rssMirrorBase?: string): { base: string; host: string; reg: string } | null {
  const trimmed = rssMirrorBase?.trim();
  if (!trimmed) return null;
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  if (u.username || u.password || u.search || u.hash) return null;
  const host = u.hostname.toLowerCase();
  if (
    !host ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    !host.includes('.') ||
    host.includes(':') ||
    isRawIpHost(host)
  ) {
    return null;
  }
  const reg = getRegistrableDomain(u.origin);
  if (!reg) return null;
  const pathname = u.pathname.replace(/\/+$/, '');
  return { base: `${u.origin}${pathname}`, host, reg };
}

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

export function parseXRssTimeline(xml: string, handle: string, mirrorHost?: string | string[]): ParsedXPost[] {
  const items = xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) ?? [];
  const out: ParsedXPost[] = [];
  const seenIds = new Set<string>();
  const rawMirrorHosts = Array.isArray(mirrorHost) ? mirrorHost : mirrorHost ? [mirrorHost] : [];
  const mirrorHostsLower = new Set<string>();
  const mirrorRegs = new Set<string>();
  for (const h of rawMirrorHosts) {
    const lower = h.trim().toLowerCase();
    if (!lower) continue;
    mirrorHostsLower.add(lower);
    const reg = getRegistrableDomain(`https://${lower}`);
    if (reg) mirrorRegs.add(reg);
  }

  const isMirrorUrl = (u: string): boolean => {
    if (mirrorHostsLower.size === 0) return false;
    try {
      const host = new URL(u).hostname.toLowerCase();
      if (mirrorHostsLower.has(host)) return true;
      const reg = getRegistrableDomain(u);
      return Boolean(reg && mirrorRegs.has(reg));
    } catch {
      return true;
    }
  };

  for (const block of items) {
    const getTag = (name: string): string => {
      const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
      return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1').trim() : '';
    };

    const rawDate = getTag('pubDate');
    const postedAt = rawDate ? Date.parse(decodeHtmlEntities(rawDate)) : NaN;
    if (!Number.isFinite(postedAt)) continue;

    const rawLink = decodeHtmlEntities(getTag('link'));
    const rawGuid = decodeHtmlEntities(getTag('guid'));
    const statusMatch =
      rawLink.match(/(?:status|statuses)\/(\d{5,})/i) ?? rawGuid.match(/(?:status|statuses)\/(\d{5,})/i);
    const idStr = statusMatch?.[1] ?? '';
    if (!idStr || seenIds.has(idStr)) continue;
    seenIds.add(idStr);

    const rawTitle = decodeHtmlEntities(getTag('title'));
    const rawDesc = decodeHtmlEntities(getTag('description'));
    const hrefs: string[] = [];
    const rawIpHrefs: string[] = [];
    for (const m of rawDesc.matchAll(/href\s*=\s*["'](https?:\/\/[^"'\s>]+)["']/gi)) {
      const rawHref = decodeHtmlEntities(m[1]).trim();
      try {
        const parsedHref = new URL(rawHref);
        const host = parsedHref.hostname.toLowerCase();
        if (isRawIpHost(host)) {
          if (!BENIGN_DNS_IPS.has(host)) {
            rawIpHrefs.push(parsedHref.toString());
          }
          continue;
        }
      } catch {
        continue;
      }
      const cleaned = cleanUrl(rawHref);
      if (!cleaned || isMirrorUrl(cleaned)) continue;
      hrefs.push(cleaned);
    }

    const plainDesc = rawDesc
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|div|li)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{2,}/g, '\n')
      .trim();
    const text = (plainDesc || rawTitle).trim();
    if (!text) continue;

    const cleanUrls = extractUrls(text, hrefs).filter(u => !isMirrorUrl(u));
    const rawIpUrls = extractSuspiciousRawIpUrls(text, rawIpHrefs);
    const urls = [...cleanUrls, ...rawIpUrls];

    out.push({
      idStr,
      postUrl: `https://x.com/${handle}/status/${idStr}`,
      postedAt,
      text,
      urls,
    });
  }

  return out;
}

export async function fetchXTimelineBestEffort(handle: string, rssMirrorBase?: string): Promise<ParsedXPost[]> {
  const mirror = parseSafeMirrorBase(rssMirrorBase);
  if (mirror) {
    try {
      const mirrorUrl = `${mirror.base}/${encodeURIComponent(handle)}/rss`;
      const res = await fetch(mirrorUrl, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml,application/xml,text/xml,*/*' },
        signal: AbortSignal.timeout(MIRROR_TIMEOUT_MS),
      });
      if (res.ok) {
        const body = await res.text();
        const mirrorHosts: string[] = [mirror.host];
        if (res.url) {
          try {
            const finalHost = new URL(res.url).hostname.toLowerCase();
            if (finalHost) mirrorHosts.push(finalHost);
          } catch {
            // Ignore unparseable res.url
          }
        }
        const parsed = parseXRssTimeline(body, handle, mirrorHosts);
        if (parsed.length > 0) return parsed;
      }
    } catch {
      // Optional RSS mirror unavailable; fall through to syndication
    }
  }

  // Only syndication.twitter.com is attempted (cdn.syndication.twimg.com returns
  // 200 with empty 0B body and was removed to avoid wasted subrequests).
  const syndicationUrl = `https://syndication.twitter.com/srv/timeline-profile/screen-name/${encodeURIComponent(handle)}`;
  try {
    const res = await fetch(syndicationUrl, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.ok) {
      const body = await res.text();
      if (body.trim()) {
        const parsed = parseNextDataTimeline(body, handle);
        if (parsed.length > 0) return parsed;
      }
    }
  } catch {
    // Expected failure on X syndication endpoint; degrade cleanly
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

    const relevantPosts = [...newPosts]
      .sort((a, b) => b.postedAt - a.postedAt || compareSnowflakeIds(b.idStr, a.idStr))
      .map(post => ({ post, parsed: parseDropPost(post.text, post.urls, sourceParseCtx) }))
      .filter(entry => entry.parsed.isRelevantDrop)
      .slice(0, MAX_POSTS_PER_POLL);

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
  fetcher?: (handle: string) => Promise<ParsedXPost[]>,
  rssMirrorBase?: string,
): Promise<XPollSummary> {
  const effectiveFetcher = fetcher ?? (handle => fetchXTimelineBestEffort(handle, rssMirrorBase));
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
    ({ projectDomains, platformDomains } = await loadKnownDomains(db, nowMs));
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
          return await pollSingleXSource(
            db,
            src,
            parseCtx,
            surfIndex,
            projectDomains,
            platformDomains,
            nowMs,
            effectiveFetcher,
          );
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
