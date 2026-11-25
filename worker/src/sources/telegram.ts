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
  extractSuspiciousRawIpUrls,
  extractUrls,
  getRegistrableDomain,
  isAlwaysHttpsDomain,
  isBareDomainAutoLink,
  isRawIpHost,
} from '../normalize/domains';
import { parseDropPost, type ParseContext } from '../normalize/parse';
import { loadKnownDomains, URL_SHORTENERS } from '../safety';

export interface ParsedTelegramPost {
  msgId: string;
  msgNum: number;
  postUrl: string;
  postedAt: number;
  text: string;
  urls: string[];
  forwardedFrom: string | null;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos|nbsp);/g, (m, code: string) => {
    // Range-check before fromCodePoint: an out-of-range numeric entity
    // (e.g. &#x110000;) must not throw and fail the whole channel parse.
    if (code.startsWith('#x') || code.startsWith('#X')) {
      const cp = Number.parseInt(code.slice(2), 16);
      return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    if (code.startsWith('#')) {
      const cp = Number.parseInt(code.slice(1), 10);
      return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return NAMED_ENTITIES[code] ?? m;
  });
}

function extractTelegramHandleFromUrl(href: string | null): string | null {
  if (!href) return null;
  try {
    const u = new URL(href, 'https://t.me');
    if (!/^(?:www\.)?t\.me$/i.test(u.hostname)) return null;
    const segs = u.pathname.split('/').filter(Boolean);
    const first = segs[0] === 's' ? segs[1] : segs[0];
    if (!first || !/^[A-Za-z0-9_]{4,32}$/.test(first)) return null;
    return first;
  } catch {
    return null;
  }
}

function normalizeTelegramAnchorUrl(decodedHref: string, rawAnchorText: string, channelHandle: string): string | null {
  const anchorText = rawAnchorText.trim();
  // Skip whitespace-only hidden anchors (e.g. Cointelegraph footer `<a href="..."> </a>`).
  if (!anchorText) return null;

  let href = decodedHref.trim();
  if (!/^https?:\/\//i.test(href)) return null;

  try {
    const parsed = new URL(href);
    const host = parsed.hostname.toLowerCase();
    // Skip benign DNS IPs auto-linked by Telegram (e.g. `http://1.1.1.1/`),
    // while preserving non-DNS raw IP URLs so parseDropPost/evaluateSafety flag them as risk.
    if (isRawIpHost(host)) {
      return BENIGN_DNS_IPS.has(host) ? null : href;
    }

    const reg = getRegistrableDomain(href);
    // Drop channel boost links and exact self-home footer links.
    if (reg === 't.me' || reg === 'telegram.me') {
      if (parsed.searchParams.has('boost') || anchorText.toLowerCase() === 'boost') return null;
      const segs = parsed.pathname.split('/').filter(Boolean);
      if (segs.length === 1 && segs[0].toLowerCase() === channelHandle.toLowerCase()) return null;
    }

    // Upgrade Telegram's server-side bare-domain `http://` auto-links
    // (`<a href="http://rgbstone.com/">rgbstone.com</a>`) and always-HTTPS
    // platforms (`http://t.me/atoms_chat`) to `https://`. Genuine explicit
    // plain-HTTP links (`http://sketchy.xyz` or disguised `<a href="http://...">Claim</a>`)
    // remain `http://` so evaluateSafety still flags Insecure transport.
    if (parsed.protocol === 'http:' && (isBareDomainAutoLink(href, anchorText) || isAlwaysHttpsDomain(reg))) {
      parsed.protocol = 'https:';
      href = parsed.toString();
    }
    return href;
  } catch {
    return null;
  }
}

/**
 * When Telegram renders a shortened link (e.g. `<a href="https://t.co/xyz">jrny.club/token-hub/claim</a>`),
 * recover any valid destination URL or bare domain+path shown in the anchor text.
 */
function extractShortenerAnchorUrls(href: string, anchorText: string): string[] {
  const reg = getRegistrableDomain(href);
  if (!reg || !URL_SHORTENERS[reg]) return [];
  const extracted = extractUrls(anchorText);
  const rawIps = extractSuspiciousRawIpUrls(anchorText);
  return [...extracted, ...rawIps];
}

interface DraftPost {
  msgId: string;
  msgNum: number;
  postedAt: number;
  textParts: string[];
  urls: string[];
  forwardedFrom: string | null;
}

interface ActiveLink {
  href: string | null;
  textParts: string[];
}

const MAX_FUTURE_SKEW_MS = 15 * 60_000;
const TG_FETCH_CONCURRENCY = 6;

function endsWithWhitespace(parts: string[]): boolean {
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (!part) continue;
    return /\s$/.test(part);
  }
  return true;
}

export async function parseTelegramHtml(
  html: string,
  handle: string,
  nowMs = Date.now(),
): Promise<ParsedTelegramPost[]> {
  const posts: DraftPost[] = [];
  let current: DraftPost | null = null;
  let textDepth = 0;
  let replyDepth = 0;
  const activeLinks: ActiveLink[] = [];

  const rewriter = new HTMLRewriter()
    .on('div.tgme_widget_message', {
      element(el) {
        const cls = el.getAttribute('class') ?? '';
        if (/\bservice_message\b/.test(cls)) return;
        const dataPost = el.getAttribute('data-post');
        if (!dataPost) return;
        const slash = dataPost.lastIndexOf('/');
        const msgId = slash >= 0 ? dataPost.slice(slash + 1) : dataPost;
        const msgNum = Number.parseInt(msgId, 10);
        if (!Number.isFinite(msgNum) || msgNum <= 0) return;

        const draft: DraftPost = {
          msgId,
          msgNum,
          postedAt: 0,
          textParts: [],
          urls: [],
          forwardedFrom: null,
        };
        posts.push(draft);
        current = draft;
        textDepth = 0;
        replyDepth = 0;
        activeLinks.length = 0;

        el.onEndTag(() => {
          if (current === draft) {
            current = null;
            textDepth = 0;
            replyDepth = 0;
            activeLinks.length = 0;
          }
        });
      },
    })
    // Exclude Telegram's quoted reply preview (`a.tgme_widget_message_reply` and
    // its child `div.tgme_widget_message_text.js-message_reply_text`): concatenating
    // reply previews onto the main message glued URLs to prose (`...status/123Update`,
    // `pixelateids.comthe/`), duplicated posts, and leaked stale URLs.
    .on('a.tgme_widget_message_reply, div.js-message_reply_text', {
      element(el) {
        if (!current) return;
        const owner = current;
        replyDepth++;
        el.onEndTag(() => {
          if (current === owner && replyDepth > 0) replyDepth--;
        });
      },
    })
    .on('div.tgme_widget_message_text', {
      element(el) {
        if (!current || replyDepth > 0) return;
        const cls = el.getAttribute('class') ?? '';
        if (cls.includes('js-message_reply_text')) return;
        const owner = current;
        if (textDepth === 0 && !endsWithWhitespace(owner.textParts)) {
          owner.textParts.push('\n');
        }
        textDepth++;
        el.onEndTag(() => {
          if (current === owner && textDepth > 0) textDepth--;
        });
      },
      text(chunk) {
        if (!current || textDepth <= 0 || replyDepth > 0) return;
        if (chunk.text) current.textParts.push(chunk.text);
      },
    })
    .on(
      'div.tgme_widget_message_text blockquote, div.tgme_widget_message_text p, div.tgme_widget_message_text pre, div.tgme_widget_message_text li, div.tgme_widget_message_text div',
      {
        element(el) {
          if (!current || textDepth <= 0 || replyDepth > 0) return;
          const cls = el.getAttribute('class') ?? '';
          if (cls.includes('js-message_reply_text')) return;
          const owner = current;
          if (!endsWithWhitespace(owner.textParts)) owner.textParts.push('\n');
          el.onEndTag(() => {
            if (current === owner && textDepth > 0 && replyDepth === 0 && !endsWithWhitespace(owner.textParts)) {
              owner.textParts.push('\n');
            }
          });
        },
      },
    )
    .on('div.tgme_widget_message_text br', {
      element() {
        if (current && textDepth > 0 && replyDepth === 0) current.textParts.push('\n');
      },
    })
    .on('div.tgme_widget_message_text a', {
      element(el) {
        if (!current || textDepth <= 0 || replyDepth > 0) return;
        const rawHref = el.getAttribute('href');
        const decodedHref = rawHref ? decodeHtmlEntities(rawHref).trim() : '';
        const href = /^https?:\/\//i.test(decodedHref) ? decodedHref : null;
        const owner = current;
        const linkState: ActiveLink = { href, textParts: [] };
        activeLinks.push(linkState);
        el.onEndTag(() => {
          const idx = activeLinks.lastIndexOf(linkState);
          if (idx >= 0) activeLinks.splice(idx, 1);
          if (current !== owner) return;
          const anchorText = decodeHtmlEntities(linkState.textParts.join(''));
          if (linkState.href) {
            const normalized = normalizeTelegramAnchorUrl(linkState.href, anchorText, handle);
            if (normalized) {
              owner.urls.push(normalized);
              for (const extra of extractShortenerAnchorUrls(normalized, anchorText)) {
                owner.urls.push(extra);
              }
            }
          }
          if (anchorText.trim() && !endsWithWhitespace(owner.textParts)) {
            owner.textParts.push(' ');
          }
        });
      },
      text(chunk) {
        if (!current || textDepth <= 0 || replyDepth > 0 || activeLinks.length === 0) return;
        if (chunk.text) activeLinks[activeLinks.length - 1].textParts.push(chunk.text);
      },
    })
    .on('a.tgme_widget_message_date time', {
      element(el) {
        if (!current) return;
        const dt = el.getAttribute('datetime');
        if (dt) {
          const parsed = Date.parse(dt);
          if (Number.isFinite(parsed)) current.postedAt = parsed;
        }
      },
    })
    .on('a.tgme_widget_message_forwarded_from_name', {
      element(el) {
        if (!current) return;
        const fwd = extractTelegramHandleFromUrl(el.getAttribute('href'));
        if (fwd) current.forwardedFrom = fwd;
      },
    });

  await rewriter.transform(new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })).text();

  const seenIds = new Set<string>();
  const maxAllowedTs = nowMs + MAX_FUTURE_SKEW_MS;
  const out: ParsedTelegramPost[] = [];
  for (const p of posts) {
    if (seenIds.has(p.msgId)) continue;
    seenIds.add(p.msgId);
    const decoded = decodeHtmlEntities(p.textParts.join('')).replace(/\u00a0/g, ' ').trim();
    if (!decoded && p.urls.length === 0) continue;
    // Keep missing/invalid/future-skewed <time> invalid so poll filters drop the post:
    // stamping Date.now() would defeat the 14-day cutoff for undated pages.
    if (!p.postedAt || !Number.isFinite(p.postedAt) || p.postedAt > maxAllowedTs) continue;
    out.push({
      msgId: p.msgId,
      msgNum: p.msgNum,
      postUrl: `https://t.me/${handle}/${p.msgId}`,
      postedAt: p.postedAt,
      text: decoded,
      urls: [...new Set(p.urls)],
      forwardedFrom: p.forwardedFrom,
    });
  }

  return out;
}

const FOURTEEN_DAYS_MS = 14 * 86_400_000;
const THIRTY_DAYS_MS = 30 * 86_400_000;

interface SourceRow {
  id: string;
  handle: string;
  lang: string | null;
  trust: number;
  last_seen_id: string | null;
  fail_count: number;
}

export interface TelegramPollSummary {
  polled: number;
  insertedPosts: number;
  errors: number;
  ingestedResults: IngestPostResult[];
}

export type SurfFeedInput = AirdropFeed | null | (() => Promise<AirdropFeed | null>);

export async function fetchTelegramChannelHtml(handle: string): Promise<string> {
  const res = await fetch(`https://t.me/s/${encodeURIComponent(handle)}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`t.me/s/${handle} HTTP ${res.status}`);
  }
  return res.text();
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIdx = 0;
  const workerCount = Math.min(Math.max(1, limit), items.length);
  const runWorker = async (): Promise<void> => {
    if (nextIdx >= items.length) return;
    const idx = nextIdx++;
    results[idx] = await fn(items[idx]);
    return runWorker();
  };
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

type TelegramFetchOutcome =
  | { ok: true; src: SourceRow; newPosts: ParsedTelegramPost[]; maxSeenNum: number }
  | { ok: false; src: SourceRow; err: unknown };

async function fetchAndParseTelegramSource(
  src: SourceRow,
  cutoffMs: number,
  nowMs: number,
  fetcher: (handle: string) => Promise<string>,
): Promise<TelegramFetchOutcome> {
  try {
    const html = await fetcher(src.handle);
    const parsedPosts = await parseTelegramHtml(html, src.handle, nowMs);
    if (parsedPosts.length === 0) {
      throw new Error(`0 messages parsed for ${src.handle}`);
    }

    const lastSeenNum = src.last_seen_id ? Number.parseInt(src.last_seen_id, 10) : 0;
    let maxSeenNum = Number.isFinite(lastSeenNum) ? lastSeenNum : 0;
    const newPosts = parsedPosts.filter(post => {
      if (post.msgNum > maxSeenNum) maxSeenNum = post.msgNum;
      if (lastSeenNum > 0 && post.msgNum <= lastSeenNum) return false;
      return post.postedAt >= cutoffMs;
    });

    return { ok: true, src, newPosts, maxSeenNum };
  } catch (err) {
    return { ok: false, src, err };
  }
}

function computeTelegramBackoffMs(failCount: number): number {
  return Math.min(120, 4 * 2 ** Math.min(5, Math.max(0, failCount - 1))) * 60_000;
}

async function markTelegramSourceError(
  db: D1Database,
  src: SourceRow,
  err: unknown,
  nowMs: number,
  committedNum = 0,
): Promise<void> {
  const nextFails = (src.fail_count ?? 0) + 1;
  const nextStatus = nextFails >= 10 ? 'down' : nextFails >= 3 ? 'degraded' : 'ok';
  const nextPollAt = nowMs + computeTelegramBackoffMs(nextFails);
  console.error(`tg-poll-error:${src.handle}`, err);
  await db
    .prepare(
      `UPDATE sources
       SET last_polled_at = ?2,
           fail_count = ?3,
           status = ?4,
           next_poll_at = ?5,
           last_seen_id = CASE
             WHEN ?6 > 0 AND (last_seen_id IS NULL OR CAST(last_seen_id AS INTEGER) < ?6)
             THEN CAST(?6 AS TEXT)
             ELSE last_seen_id
           END
       WHERE id = ?1`,
    )
    .bind(src.id, nowMs, nextFails, nextStatus, nextPollAt, committedNum)
    .run();
}

async function markTelegramSourceOk(db: D1Database, src: SourceRow, maxSeenNum: number, nowMs: number): Promise<void> {
  await db
    .prepare(
      `UPDATE sources
       SET last_seen_id = CASE
             WHEN ?2 > 0 AND (last_seen_id IS NULL OR CAST(last_seen_id AS INTEGER) < ?2)
             THEN CAST(?2 AS TEXT)
             ELSE COALESCE(last_seen_id, ?4)
           END,
           last_ok_at = ?3,
           last_polled_at = ?3,
           status = 'ok',
           fail_count = 0,
           next_poll_at = NULL
       WHERE id = ?1`,
    )
    .bind(src.id, maxSeenNum, nowMs, src.last_seen_id)
    .run();
}

async function ingestTelegramSourcePosts(
  db: D1Database,
  outcome: Extract<TelegramFetchOutcome, { ok: true }>,
  parseCtx: ParseContext,
  surfIndex: SurfIndex,
  projectDomains: Map<string, string>,
  platformDomains: Set<string> | undefined,
  nowMs: number,
): Promise<{ insertedPosts: number; error: boolean; ingestedResults: IngestPostResult[] }> {
  const { src, newPosts, maxSeenNum } = outcome;
  const prevSeenNum = src.last_seen_id ? Number.parseInt(src.last_seen_id, 10) : 0;
  let committedNum = Number.isFinite(prevSeenNum) ? prevSeenNum : 0;
  const ingestedResults: IngestPostResult[] = [];

  try {
    const sourceParseCtx: ParseContext = {
      ...parseCtx,
      sourceLang: src.lang ?? undefined,
      surfByDomain: surfIndex.byDomain,
      surfByTicker: surfIndex.byTicker,
    };

    const orderedPosts = [...newPosts].sort((a, b) => a.msgNum - b.msgNum);
    for (const post of orderedPosts) {
      const parsed = parseDropPost(post.text, post.urls, sourceParseCtx);
      if (parsed.isRelevantDrop) {
        const res = await ingestPostIntoCluster(
          db,
          {
            postId: `telegram:${src.handle}:${post.msgId}`,
            sourceId: src.id,
            sourceTrust: src.trust,
            postUrl: post.postUrl,
            postedAt: post.postedAt,
            text: post.text,
            htmlUrls: post.urls,
            forwardedFrom: post.forwardedFrom,
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
      if (post.msgNum > committedNum) committedNum = post.msgNum;
    }

    await markTelegramSourceOk(db, src, Math.max(committedNum, maxSeenNum), nowMs);
    return { insertedPosts: ingestedResults.length, error: false, ingestedResults };
  } catch (err) {
    await markTelegramSourceError(db, src, err, nowMs, committedNum);
    return { insertedPosts: ingestedResults.length, error: true, ingestedResults };
  }
}

export async function pollTelegramBatch(
  db: D1Database,
  batchSize = 4,
  nowMs = Date.now(),
  surfFeed?: SurfFeedInput,
  fetcher: (handle: string) => Promise<string> = fetchTelegramChannelHtml,
): Promise<TelegramPollSummary> {
  const batchRes = await db
    .prepare(
      `SELECT id, handle, lang, trust, last_seen_id, fail_count
       FROM sources
       WHERE platform = 'telegram' AND enabled = 1 AND (next_poll_at IS NULL OR next_poll_at <= ?1)
       ORDER BY last_polled_at ASC NULLS FIRST
       LIMIT ?2`,
    )
    .bind(nowMs, batchSize)
    .all<SourceRow>();

  const sources = batchRes.results ?? [];
  if (sources.length === 0) {
    return { polled: 0, insertedPosts: 0, errors: 0, ingestedResults: [] };
  }

  const cutoffMs = nowMs - FOURTEEN_DAYS_MS;
  const fetchOutcomes = await mapWithConcurrency(sources, TG_FETCH_CONCURRENCY, src =>
    fetchAndParseTelegramSource(src, cutoffMs, nowMs, fetcher),
  );
  const failedOutcomes = fetchOutcomes.filter((o): o is Extract<TelegramFetchOutcome, { ok: false }> => !o.ok);
  const okOutcomes = fetchOutcomes.filter((o): o is Extract<TelegramFetchOutcome, { ok: true }> => o.ok);

  if (failedOutcomes.length > 0) {
    await Promise.all(failedOutcomes.map(o => markTelegramSourceError(db, o.src, o.err, nowMs)));
  }

  if (!okOutcomes.some(o => o.newPosts.length > 0)) {
    await Promise.all(okOutcomes.map(o => markTelegramSourceOk(db, o.src, o.maxSeenNum, nowMs)));
    return { polled: sources.length, insertedPosts: 0, errors: failedOutcomes.length, ingestedResults: [] };
  }

  const [{ projectDomains, platformDomains }, resolvedSurf] = await Promise.all([
    loadKnownDomains(db, nowMs),
    typeof surfFeed === 'function'
      ? surfFeed().catch(err => {
          console.error('tg-surf-load-error', err);
          return null;
        })
      : Promise.resolve(surfFeed ?? null),
  ]);
  const surfIndex: SurfIndex = buildSurfIndex(resolvedSurf);
  const parseCtx: ParseContext = { knownDomains: projectDomains };

  const ingestOutcomes = await Promise.all(
    okOutcomes.map(o =>
      ingestTelegramSourcePosts(db, o, parseCtx, surfIndex, projectDomains, platformDomains, nowMs),
    ),
  );

  let insertedPosts = 0;
  let errors = failedOutcomes.length;
  const ingestedResults: IngestPostResult[] = [];
  for (const r of ingestOutcomes) {
    insertedPosts += r.insertedPosts;
    if (r.error) errors++;
    ingestedResults.push(...r.ingestedResults);
  }

  return { polled: sources.length, insertedPosts, errors, ingestedResults };
}

export interface PruneOldPostsResult {
  deletedPosts: number;
  deletedClusters: number;
}

const PRUNE_ORPHANS_STATE_KEY = 'prune:orphans';

export async function pruneOldPosts(db: D1Database, nowMs = Date.now()): Promise<PruneOldPostsResult> {
  const cutoff = nowMs - THIRTY_DAYS_MS;
  // Persist the pending-orphan marker in the same D1 batch transaction as the
  // posts DELETE (guarded by EXISTS on covering index posts_posted so 0-row
  // runs perform zero marker writes).
  const [, del] = await db.batch([
    db
      .prepare(
        `INSERT INTO cron_state (key, last_run_at)
         SELECT ?1, ?2
         WHERE EXISTS (SELECT 1 FROM posts WHERE posted_at < ?3)
         ON CONFLICT(key) DO UPDATE SET last_run_at = excluded.last_run_at`,
      )
      .bind(PRUNE_ORPHANS_STATE_KEY, nowMs, cutoff),
    db.prepare('DELETE FROM posts WHERE posted_at < ?1').bind(cutoff),
  ]);
  const deletedPosts = del.meta?.changes ?? 0;
  if (deletedPosts === 0) {
    const pending = await db
      .prepare('SELECT 1 AS pending FROM cron_state WHERE key = ?1')
      .bind(PRUNE_ORPHANS_STATE_KEY)
      .first<{ pending: number }>();
    if (!pending) {
      return { deletedPosts: 0, deletedClusters: 0 };
    }
  }

  const [clDel] = await db.batch([
    db.prepare('DELETE FROM clusters WHERE id NOT IN (SELECT DISTINCT cluster_id FROM posts WHERE cluster_id IS NOT NULL)'),
    db.prepare('DELETE FROM fallback_windows WHERE cluster_id NOT IN (SELECT id FROM clusters)'),
    db.prepare('DELETE FROM cron_state WHERE key = ?1').bind(PRUNE_ORPHANS_STATE_KEY),
  ]);
  return { deletedPosts, deletedClusters: clDel.meta?.changes ?? 0 };
}
