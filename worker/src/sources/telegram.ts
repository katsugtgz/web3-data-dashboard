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

function normalizeTelegramAnchorUrl(rawHref: string, rawAnchorText: string, channelHandle: string): string | null {
  const anchorText = rawAnchorText.trim();
  // Skip whitespace-only hidden anchors (e.g. Cointelegraph footer `<a href="..."> </a>`).
  if (!anchorText) return null;

  let href = decodeHtmlEntities(rawHref).trim();
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
  href: string;
  textParts: string[];
}

export async function parseTelegramHtml(html: string, handle: string): Promise<ParsedTelegramPost[]> {
  const posts: DraftPost[] = [];
  let current: DraftPost | null = null;
  let textDepth = 0;
  let replyDepth = 0;
  const activeLinks: ActiveLink[] = [];

  const rewriter = new HTMLRewriter()
    .on('div.tgme_widget_message', {
      element(el) {
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
        if (textDepth === 0 && owner.textParts.length > 0) {
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
    .on('div.tgme_widget_message_text br', {
      element() {
        if (current && textDepth > 0 && replyDepth === 0) current.textParts.push('\n');
      },
    })
    .on('div.tgme_widget_message_text a', {
      element(el) {
        if (!current || textDepth <= 0 || replyDepth > 0) return;
        const href = el.getAttribute('href');
        if (!href || !/^https?:\/\//i.test(href)) return;
        const owner = current;
        const linkState: ActiveLink = { href, textParts: [] };
        activeLinks.push(linkState);
        el.onEndTag(() => {
          const idx = activeLinks.lastIndexOf(linkState);
          if (idx >= 0) activeLinks.splice(idx, 1);
          if (current !== owner) return;
          const anchorText = decodeHtmlEntities(linkState.textParts.join(''));
          const normalized = normalizeTelegramAnchorUrl(linkState.href, anchorText, handle);
          if (normalized) {
            owner.urls.push(normalized);
            for (const extra of extractShortenerAnchorUrls(normalized, anchorText)) {
              owner.urls.push(extra);
            }
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
  const out: ParsedTelegramPost[] = [];
  for (const p of posts) {
    if (seenIds.has(p.msgId)) continue;
    seenIds.add(p.msgId);
    const decoded = decodeHtmlEntities(p.textParts.join('')).replace(/\u00a0/g, ' ').trim();
    if (!decoded && p.urls.length === 0) continue;
    // Keep missing/invalid <time> invalid so poll filters drop the post:
    // stamping Date.now() would defeat the 14-day cutoff for undated pages.
    if (!p.postedAt || !Number.isFinite(p.postedAt)) continue;
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

export async function fetchTelegramChannelHtml(handle: string): Promise<string> {
  const res = await fetch(`https://t.me/s/${encodeURIComponent(handle)}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`t.me/s/${handle} HTTP ${res.status}`);
  return res.text();
}

type TelegramFetchOutcome =
  | { ok: true; src: SourceRow; newPosts: ParsedTelegramPost[]; maxSeenNum: number }
  | { ok: false; src: SourceRow; err: unknown };

async function fetchAndParseTelegramSource(
  src: SourceRow,
  cutoffMs: number,
  fetcher: (handle: string) => Promise<string>,
): Promise<TelegramFetchOutcome> {
  try {
    const html = await fetcher(src.handle);
    const parsedPosts = await parseTelegramHtml(html, src.handle);
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

async function markTelegramSourceError(db: D1Database, src: SourceRow, err: unknown, nowMs: number): Promise<void> {
  const nextFails = (src.fail_count ?? 0) + 1;
  const nextStatus = nextFails >= 10 ? 'down' : nextFails >= 3 ? 'degraded' : 'ok';
  console.error(`tg-poll-error:${src.handle}`, err);
  await db
    .prepare(
      `UPDATE sources
       SET last_polled_at = ?2, fail_count = ?3, status = ?4
       WHERE id = ?1`,
    )
    .bind(src.id, nowMs, nextFails, nextStatus)
    .run();
}

async function markTelegramSourceOk(db: D1Database, src: SourceRow, maxSeenNum: number, nowMs: number): Promise<void> {
  await db
    .prepare(
      `UPDATE sources
       SET last_seen_id = ?2, last_ok_at = ?3, last_polled_at = ?3, status = 'ok', fail_count = 0
       WHERE id = ?1`,
    )
    .bind(src.id, maxSeenNum > 0 ? String(maxSeenNum) : src.last_seen_id, nowMs)
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
  try {
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
      relevantPosts.map(({ post, parsed }) =>
        ingestPostIntoCluster(
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
        ),
      ),
    );

    await markTelegramSourceOk(db, src, maxSeenNum, nowMs);
    return { insertedPosts: ingestedResults.length, error: false, ingestedResults };
  } catch (err) {
    await markTelegramSourceError(db, src, err, nowMs);
    return { insertedPosts: 0, error: true, ingestedResults: [] };
  }
}

export async function pollTelegramBatch(
  db: D1Database,
  batchSize = 4,
  nowMs = Date.now(),
  surfFeed?: AirdropFeed | null,
  fetcher: (handle: string) => Promise<string> = fetchTelegramChannelHtml,
): Promise<TelegramPollSummary> {
  const batchRes = await db
    .prepare(
      `SELECT id, handle, lang, trust, last_seen_id, fail_count
       FROM sources
       WHERE platform = 'telegram' AND enabled = 1
       ORDER BY last_polled_at ASC NULLS FIRST
       LIMIT ?1`,
    )
    .bind(batchSize)
    .all<SourceRow>();

  const sources = batchRes.results ?? [];
  if (sources.length === 0) {
    return { polled: 0, insertedPosts: 0, errors: 0, ingestedResults: [] };
  }

  const cutoffMs = nowMs - FOURTEEN_DAYS_MS;
  const fetchOutcomes = await Promise.all(sources.map(src => fetchAndParseTelegramSource(src, cutoffMs, fetcher)));
  const failedOutcomes = fetchOutcomes.filter((o): o is Extract<TelegramFetchOutcome, { ok: false }> => !o.ok);
  const okOutcomes = fetchOutcomes.filter((o): o is Extract<TelegramFetchOutcome, { ok: true }> => o.ok);

  if (failedOutcomes.length > 0) {
    await Promise.all(failedOutcomes.map(o => markTelegramSourceError(db, o.src, o.err, nowMs)));
  }

  if (!okOutcomes.some(o => o.newPosts.length > 0)) {
    await Promise.all(okOutcomes.map(o => markTelegramSourceOk(db, o.src, o.maxSeenNum, nowMs)));
    return { polled: sources.length, insertedPosts: 0, errors: failedOutcomes.length, ingestedResults: [] };
  }

  const { projectDomains, platformDomains } = await loadKnownDomains(db, nowMs);
  const surfIndex: SurfIndex = buildSurfIndex(surfFeed);
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
    db.prepare('DELETE FROM cron_state WHERE key = ?1').bind(PRUNE_ORPHANS_STATE_KEY),
  ]);
  return { deletedPosts, deletedClusters: clDel.meta?.changes ?? 0 };
}
