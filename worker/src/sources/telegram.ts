import type { AirdropFeed } from '../../../shared/types';
import { FETCH_TIMEOUT_MS, USER_AGENT } from '../lib/format';
import {
  buildSurfIndex,
  ingestPostIntoCluster,
  type IngestPostResult,
  type SurfIndex,
} from '../normalize/cluster';
import type { ParseContext } from '../normalize/parse';
import { loadKnownDomains } from '../safety';

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
    if (code.startsWith('#x') || code.startsWith('#X')) {
      const cp = Number.parseInt(code.slice(2), 16);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    if (code.startsWith('#')) {
      const cp = Number.parseInt(code.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
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

interface DraftPost {
  msgId: string;
  msgNum: number;
  postedAt: number;
  textParts: string[];
  urls: string[];
  forwardedFrom: string | null;
}

export async function parseTelegramHtml(html: string, handle: string): Promise<ParsedTelegramPost[]> {
  const posts: DraftPost[] = [];
  let current: DraftPost | null = null;
  let textDepth = 0;

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

        el.onEndTag(() => {
          if (current === draft) {
            current = null;
            textDepth = 0;
          }
        });
      },
    })
    .on('div.tgme_widget_message_text', {
      element(el) {
        if (!current) return;
        const owner = current;
        textDepth++;
        el.onEndTag(() => {
          if (current === owner && textDepth > 0) textDepth--;
        });
      },
      text(chunk) {
        if (!current || textDepth <= 0) return;
        if (chunk.text) current.textParts.push(chunk.text);
      },
    })
    .on('div.tgme_widget_message_text br', {
      element() {
        if (current && textDepth > 0) current.textParts.push('\n');
      },
    })
    .on('div.tgme_widget_message_text a', {
      element(el) {
        if (!current || textDepth <= 0) return;
        const href = el.getAttribute('href');
        if (href && /^https?:\/\//i.test(href)) {
          current.urls.push(href);
        }
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
    out.push({
      msgId: p.msgId,
      msgNum: p.msgNum,
      postUrl: `https://t.me/${handle}/${p.msgId}`,
      postedAt: p.postedAt || Date.now(),
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

async function pollSingleTelegramSource(
  db: D1Database,
  src: SourceRow,
  parseCtx: ParseContext,
  surfIndex: SurfIndex,
  projectDomains: Map<string, string>,
  nowMs: number,
  fetcher: (handle: string) => Promise<string>,
): Promise<{ insertedPosts: number; error: boolean; ingestedResults: IngestPostResult[] }> {
  const cutoffMs = nowMs - FOURTEEN_DAYS_MS;
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

    const ingestedResults = await Promise.all(
      newPosts.map(post =>
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
          },
          parseCtx,
          surfIndex,
          projectDomains,
          nowMs,
        ),
      ),
    );

    await db
      .prepare(
        `UPDATE sources
         SET last_seen_id = ?2, last_ok_at = ?3, last_polled_at = ?3, status = 'ok', fail_count = 0
         WHERE id = ?1`,
      )
      .bind(src.id, maxSeenNum > 0 ? String(maxSeenNum) : src.last_seen_id, nowMs)
      .run();

    return { insertedPosts: ingestedResults.length, error: false, ingestedResults };
  } catch (err) {
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
      `SELECT id, handle, trust, last_seen_id, fail_count
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

  const { projectDomains } = await loadKnownDomains(db);
  const surfIndex: SurfIndex = buildSurfIndex(surfFeed);
  const parseCtx: ParseContext = { knownDomains: projectDomains };

  const results = await Promise.all(
    sources.map(src => pollSingleTelegramSource(db, src, parseCtx, surfIndex, projectDomains, nowMs, fetcher)),
  );

  let insertedPosts = 0;
  let errors = 0;
  const ingestedResults: IngestPostResult[] = [];
  for (const r of results) {
    insertedPosts += r.insertedPosts;
    if (r.error) errors++;
    ingestedResults.push(...r.ingestedResults);
  }

  return { polled: sources.length, insertedPosts, errors, ingestedResults };
}

export async function pruneOldPosts(db: D1Database, nowMs = Date.now()): Promise<void> {
  const cutoff = nowMs - THIRTY_DAYS_MS;
  await db.prepare('DELETE FROM posts WHERE posted_at < ?1').bind(cutoff).run();
  await db
    .prepare('DELETE FROM clusters WHERE id NOT IN (SELECT DISTINCT cluster_id FROM posts WHERE cluster_id IS NOT NULL)')
    .run();
}
