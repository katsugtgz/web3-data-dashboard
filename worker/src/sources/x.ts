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

const MAX_FUTURE_SKEW_MS = 15 * 60_000;

export function parseNextDataTimeline(html: string, handle: string, nowMs = Date.now()): ParsedXPost[] {
  const m = html.match(/<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return [];
  const maxAllowedTs = nowMs + MAX_FUTURE_SKEW_MS;
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
      // Undated/invalid/future-skewed timestamps must be REJECTED, not stamped as now:
      // the 14-day cutoff would otherwise admit stale undated tweets forever.
      const parsedTime = tweet.created_at ? Date.parse(tweet.created_at) : NaN;
      if (!Number.isFinite(parsedTime) || parsedTime > maxAllowedTs) continue;
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

export function parseCdnSyndication(body: string, handle: string, nowMs = Date.now()): ParsedXPost[] {
  const trimmed = body.trim();
  if (!trimmed) return [];
  const maxAllowedTs = nowMs + MAX_FUTURE_SKEW_MS;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const data = JSON.parse(trimmed) as { entries?: NextTweet[] } | NextTweet[];
      const list = Array.isArray(data) ? data : (data.entries ?? []);
      return list
        .map(tweet => {
          const idStr = String(tweet.id_str ?? tweet.id ?? '');
          const text = (tweet.full_text ?? tweet.text ?? '').trim();
          if (!idStr || !text) return null;
          // Same rejection as the __NEXT_DATA__ path: no valid non-future timestamp, no post.
          const parsedTime = tweet.created_at ? Date.parse(tweet.created_at) : NaN;
          if (!Number.isFinite(parsedTime) || parsedTime > maxAllowedTs) return null;
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
  return parseNextDataTimeline(trimmed, handle, nowMs);
}

const TWENTY_FOUR_H_MS = 24 * 3_600_000;
const SIX_H_MS = 6 * 3_600_000;
const FOURTEEN_DAYS_MS = 14 * 86_400_000;
const MAX_POSTS_PER_POLL = 10;
const MIRROR_TIMEOUT_MS = Math.min(FETCH_TIMEOUT_MS, 7000);

const MAX_MIRROR_REDIRECTS = 3;

function validateSafeMirrorUrl(u: URL): { host: string; reg: string } | null {
  if (u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
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
  return { host, reg };
}

function parseSafeMirrorBase(rssMirrorBase?: string): { base: string; host: string; reg: string } | null {
  const trimmed = rssMirrorBase?.trim();
  if (!trimmed) return null;
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return null;
  }
  if (u.search || u.hash) return null;
  const valid = validateSafeMirrorUrl(u);
  if (!valid) return null;
  const pathname = u.pathname.replace(/\/+$/, '');
  return { base: `${u.origin}${pathname}`, host: valid.host, reg: valid.reg };
}

function parseSafeMirrorRedirectUrl(location: string, currentUrl: string): { url: string; host: string } | null {
  const trimmed = location.trim();
  if (!trimmed) return null;
  let u: URL;
  try {
    u = new URL(trimmed, currentUrl);
  } catch {
    return null;
  }
  const valid = validateSafeMirrorUrl(u);
  if (!valid) return null;
  u.hash = '';
  return { url: u.toString(), host: valid.host };
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

export function parseXRssTimeline(
  xml: string,
  handle: string,
  mirrorHost?: string | string[],
  nowMs = Date.now(),
): ParsedXPost[] {
  const items = xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) ?? [];
  const out: ParsedXPost[] = [];
  const seenIds = new Set<string>();
  const maxAllowedTs = nowMs + MAX_FUTURE_SKEW_MS;
  const rawMirrorHosts = Array.isArray(mirrorHost) ? mirrorHost : mirrorHost ? [mirrorHost] : [];
  const mirrorHostsLower = new Set<string>();
  const mirrorRegs = new Set<string>();
  for (const h of rawMirrorHosts) {
    const lower = h.trim().toLowerCase().replace(/\.+$/, '');
    if (!lower) continue;
    mirrorHostsLower.add(lower);
    const reg = getRegistrableDomain(`https://${lower}`);
    if (reg) mirrorRegs.add(reg);
  }

  const isMirrorHost = (hostRaw: string): boolean => {
    if (mirrorHostsLower.size === 0) return false;
    const host = hostRaw.trim().toLowerCase().replace(/\.+$/, '');
    if (!host) return false;
    if (mirrorHostsLower.has(host)) return true;
    const reg = getRegistrableDomain(`https://${host}`);
    return Boolean(reg && mirrorRegs.has(reg));
  };

  const isMirrorUrl = (u: string): boolean => {
    if (mirrorHostsLower.size === 0) return false;
    try {
      return isMirrorHost(new URL(u).hostname);
    } catch {
      return true;
    }
  };

  const stripMirrorTokens = (input: string): string => {
    if (!input || mirrorHostsLower.size === 0) return input;
    const stripped = input.replace(
      /https?:\/\/[^\s<>"'`]+|(?<![:/@.\w=-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})(?::\d{1,5})?(?:[/?][^\s<>"'`]*|(?![a-z0-9_-]|\.[a-z0-9]|:[a-z0-9]))/gi,
      token => {
        const candidate = token.replace(/[),.;!?\]}>]+$/g, '');
        if (!candidate) return token;
        const withScheme = /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`;
        try {
          const host = new URL(withScheme).hostname;
          if (isMirrorHost(host)) {
            return token.slice(candidate.length);
          }
        } catch {
          // Leave unparseable token intact so non-mirror text is never stripped
        }
        return token;
      },
    );
    return stripped
      .replace(/[ \t]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{2,}/g, '\n')
      .trim();
  };

  for (const block of items) {
    const getTag = (name: string): string => {
      const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
      return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1').trim() : '';
    };

    const rawDate = getTag('pubDate');
    const postedAt = rawDate ? Date.parse(decodeHtmlEntities(rawDate)) : NaN;
    if (!Number.isFinite(postedAt) || postedAt > maxAllowedTs) continue;

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
    const rawIpSourceText = (plainDesc || rawTitle).trim();
    const rawIpUrls = extractSuspiciousRawIpUrls(rawIpSourceText, rawIpHrefs);

    const cleanedDesc = stripMirrorTokens(plainDesc);
    const cleanedTitle = stripMirrorTokens(rawTitle);
    const text = (cleanedDesc || cleanedTitle).trim();
    if (!text) continue;

    const allRawIpUrls =
      !cleanedDesc && plainDesc
        ? [...new Set([...rawIpUrls, ...extractSuspiciousRawIpUrls(rawTitle)])]
        : rawIpUrls;
    const cleanUrls = extractUrls(text, hrefs).filter(u => !isMirrorUrl(u));
    const urls = [...cleanUrls, ...allRawIpUrls];

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

export async function fetchXTimelineBestEffort(
  handle: string,
  rssMirrorBaseOrNowMs?: string | number,
  nowMsArg?: number,
): Promise<ParsedXPost[]> {
  const rssMirrorBase = typeof rssMirrorBaseOrNowMs === 'string' ? rssMirrorBaseOrNowMs : undefined;
  const nowMs =
    typeof rssMirrorBaseOrNowMs === 'number' ? rssMirrorBaseOrNowMs : (nowMsArg ?? Date.now());
  const cutoffMs = nowMs - FOURTEEN_DAYS_MS;
  const mirror = parseSafeMirrorBase(rssMirrorBase);
  let staleMirrorPosts: ParsedXPost[] | null = null;
  if (mirror) {
    try {
      let currentUrl = `${mirror.base}/${encodeURIComponent(handle)}/rss`;
      const mirrorHosts: string[] = [mirror.host];
      let res: Response | null = null;
      for (let hop = 0; hop <= MAX_MIRROR_REDIRECTS; hop++) {
        const candidate = await fetch(currentUrl, {
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml,application/xml,text/xml,*/*' },
          redirect: 'manual',
          signal: AbortSignal.timeout(MIRROR_TIMEOUT_MS),
        });
        if (candidate.status >= 300 && candidate.status < 400) {
          const location = candidate.headers.get('location');
          await candidate.body?.cancel();
          if (!location || hop === MAX_MIRROR_REDIRECTS) {
            res = null;
            break;
          }
          const nextTarget = parseSafeMirrorRedirectUrl(location, currentUrl);
          if (!nextTarget) {
            res = null;
            break;
          }
          mirrorHosts.push(nextTarget.host);
          currentUrl = nextTarget.url;
          continue;
        }
        res = candidate;
        break;
      }
      if (res?.ok) {
        const body = await res.text();
        if (res.url) {
          try {
            const finalHost = new URL(res.url).hostname.toLowerCase();
            if (finalHost) mirrorHosts.push(finalHost);
          } catch {
            // Ignore unparseable res.url
          }
        }
        const parsed = parseXRssTimeline(body, handle, mirrorHosts, nowMs);
        if (parsed.some(p => p.postedAt >= cutoffMs)) return parsed;
        if (parsed.length > 0) staleMirrorPosts = parsed;
      } else if (res) {
        await res.body?.cancel();
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
        const parsed = parseNextDataTimeline(body, handle, nowMs);
        if (parsed.length > 0) return parsed;
      }
    } else {
      await res.body?.cancel();
    }
  } catch {
    // Expected failure on X syndication endpoint; degrade cleanly
  }

  if (staleMirrorPosts) return staleMirrorPosts;
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
  fetcher: (handle: string, nowMs?: number) => Promise<ParsedXPost[]>,
): Promise<{ insertedPosts: number; degraded: boolean; ingestedResults: IngestPostResult[] }> {
  const cutoffMs = nowMs - FOURTEEN_DAYS_MS;
  const maxAllowedTs = nowMs + MAX_FUTURE_SKEW_MS;
  let committedId = src.last_seen_id ?? '';
  const ingestedResults: IngestPostResult[] = [];
  try {
    const posts = await fetcher(src.handle, nowMs);
    const validPosts = posts.filter(p => Number.isFinite(p.postedAt) && p.postedAt <= maxAllowedTs);
    if (validPosts.length === 0) throw new Error(`0 tweets parsed for @${src.handle}`);

    let maxSeen = src.last_seen_id ?? '';
    const newPosts = validPosts.filter(p => {
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

    let capped = false;
    const orderedPosts = [...newPosts].sort((a, b) => compareSnowflakeIds(a.idStr, b.idStr));
    for (const p of orderedPosts) {
      const parsed = parseDropPost(p.text, p.urls, sourceParseCtx);
      if (parsed.isRelevantDrop) {
        if (ingestedResults.length >= MAX_POSTS_PER_POLL) {
          capped = true;
          break;
        }
        const res = await ingestPostIntoCluster(
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
        );
        ingestedResults.push(res);
      }
      if (!committedId || compareSnowflakeIds(p.idStr, committedId) > 0) {
        committedId = p.idStr;
      }
    }

    const finalSeen = capped
      ? committedId
      : committedId && (!maxSeen || compareSnowflakeIds(committedId, maxSeen) > 0)
        ? committedId
        : maxSeen;
    await db
      .prepare(
        `UPDATE sources
         SET last_seen_id = CASE
               WHEN ?2 IS NOT NULL AND ?2 != '' AND (
                 last_seen_id IS NULL
                 OR length(?2) > length(last_seen_id)
                 OR (length(?2) = length(last_seen_id) AND ?2 > last_seen_id)
               )
               THEN ?2
               ELSE last_seen_id
             END,
             last_ok_at = ?3,
             last_polled_at = ?3,
             status = 'ok',
             fail_count = 0,
             first_fail_at = NULL,
             next_poll_at = NULL
         WHERE id = ?1`,
      )
      .bind(src.id, finalSeen || src.last_seen_id, nowMs)
      .run();

    return { insertedPosts: ingestedResults.length, degraded: false, ingestedResults };
  } catch (err) {
    console.error(`x-poll-error:${src.id}`, err);
    const backoff = computeXBackoff(src.fail_count ?? 0, src.first_fail_at ?? null, nowMs);
    await db
      .prepare(
        `UPDATE sources
         SET last_polled_at = ?2,
             fail_count = ?3,
             first_fail_at = ?4,
             status = ?5,
             next_poll_at = ?6,
             last_seen_id = CASE
               WHEN ?7 IS NOT NULL AND ?7 != '' AND (
                 last_seen_id IS NULL
                 OR length(?7) > length(last_seen_id)
                 OR (length(?7) = length(last_seen_id) AND ?7 > last_seen_id)
               )
               THEN ?7
               ELSE last_seen_id
             END
         WHERE id = ?1`,
      )
      .bind(src.id, nowMs, backoff.failCount, backoff.firstFailAt, backoff.status, backoff.nextPollAt, committedId || null)
      .run();
    return { insertedPosts: ingestedResults.length, degraded: true, ingestedResults };
  }
}

export async function pollXBatch(
  db: D1Database,
  batchSize = 3,
  nowMs = Date.now(),
  surfFeed?: AirdropFeed | null,
  fetcher?: (handle: string, nowMs?: number) => Promise<ParsedXPost[]>,
  rssMirrorBase?: string,
): Promise<XPollSummary> {
  const effectiveFetcher =
    fetcher ?? ((handle: string, ts?: number) => fetchXTimelineBestEffort(handle, rssMirrorBase, ts));
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
