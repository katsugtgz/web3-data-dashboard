import { MARKET_SECTIONS_ORDER } from '../../shared/constants';
import type {
  AirdropFeed,
  HealthResponse,
  MarketSection,
  MarketSectionId,
  MarketSector,
  MarketsResponse,
} from '../../shared/types';
import {
  listSnapshotMeta,
  listSnapshots,
  markSnapshotError,
  readSnapshot,
  sha1Hex,
  toHealthMap,
  upsertSnapshot,
  type SnapshotRow,
} from './lib/db';
import { queryFeed, querySourcesHealth, type IngestPostResult } from './normalize/cluster';
import { decayClusterScores } from './normalize/score';
import { summarizeClusterWithAi, type AiBindingLike } from './normalize/summarize';
import { loadKnownDomains, seedKnownDomains } from './safety';
import { extractCandidateHandles, getTopCandidates, recordCandidates } from './sources/discover';
import {
  fetchCryptoSection,
  fetchGithubSection,
  fetchPredictionsSection,
  fetchTrendingSection,
  type MarketUrls,
} from './sources/markets';
import { SEED_SOURCES, syncSources } from './sources/registry';
import { fetchSurfAirdrops } from './sources/surf';
import { pollTelegramBatch, pruneOldPosts } from './sources/telegram';
import { pollXBatch } from './sources/x';

export interface Env {
  DB: D1Database;
  AI?: AiBindingLike;
  TG_BATCH_SIZE?: string;
  X_BATCH_SIZE?: string;
  AI_DAILY_MAX?: string;
  AI_SUMMARY_CHUNK?: string;
  SURF_AIRDROPS_URL?: string;
  POLYMARKET_URL?: string;
  COINGECKO_MARKETS_URL?: string;
  DEX_BOOSTS_URL?: string;
  GITHUB_SEARCH_URL?: string;
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'If-None-Match',
  'Access-Control-Expose-Headers': 'ETag',
};

const THIRTY_MIN_MS = 30 * 60_000;
const FIVE_MIN_STALE_MS = 15 * 60_000;
const THIRTY_MIN_STALE_MS = 90 * 60_000;

const REGISTERED_TG_HANDLES = new Set(
  SEED_SOURCES.filter(s => s.platform === 'telegram').map(s => s.handle.toLowerCase()),
);

/**
 * Parses a non-negative integer env var; falls back to `fallback` when unset,
 * non-numeric, or negative. Unlike `parseInt(...) || fallback`, an explicit
 * `0` is honored (0 is a real cap, not a missing value).
 */
function parseNonNegativeInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

interface CryptoSnapshotBody {
  section: MarketSection;
  sectors: MarketSector[];
}

/**
 * Digest over the *exact response body*, so cache-miss requests produce the
 * same ETag as the stored 200 (and across isolates) whenever the payload is
 * unchanged. Loaders therefore exclude volatile clock fields from the body
 * itself (content-derived `generatedAt` for the feed; per-section
 * `fetchedAt` for markets) instead of omitting fields at digest time.
 */
async function bodyEtag(body: string): Promise<string> {
  return `"${await sha1Hex(body)}"`;
}
export { bodyEtag };

function jsonResponse(body: string, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

function notModified(etag: string, cacheControl: string): Response {
  return new Response(null, {
    status: 304,
    headers: {
      ...CORS_HEADERS,
      ETag: etag,
      'Cache-Control': cacheControl,
    },
  });
}

function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const norm = (v: string) => v.trim().replace(/^W\//i, '');
  const target = norm(etag);
  return ifNoneMatch.split(',').some(part => norm(part) === target || part.trim() === '*');
}

async function runIsolated(db: D1Database, key: string, nowMs: number, fn: () => Promise<unknown>): Promise<void> {
  try {
    const data = await fn();
    await upsertSnapshot(db, key, data, nowMs);
  } catch (err) {
    console.error(`cron-error:${key}`, err);
    await markSnapshotError(db, key, err, nowMs);
  }
}

async function loadCachedSurfAndDefi(db: D1Database): Promise<{
  surf: AirdropFeed | null;
  defi: MarketSection | null;
}> {
  // A transient D1 read failure here must not abort the rest of the cron
  // (X polling, domain seeding, pruning, decay all follow). Degrade to nulls.
  let surfRow: SnapshotRow | null = null;
  let defiRow: SnapshotRow | null = null;
  try {
    [surfRow, defiRow] = await Promise.all([readSnapshot(db, 'airdrops'), readSnapshot(db, 'markets:defi')]);
  } catch (err) {
    console.error('cron-error:loadCachedSurfAndDefi', err);
  }
  let surf: AirdropFeed | null = null;
  let defi: MarketSection | null = null;
  if (surfRow?.body && surfRow.body !== '{}') {
    try {
      surf = JSON.parse(surfRow.body) as AirdropFeed;
    } catch {
      surf = null;
    }
  }
  if (defiRow?.body && defiRow.body !== '{}') {
    try {
      defi = JSON.parse(defiRow.body) as MarketSection;
    } catch {
      defi = null;
    }
  }
  return { surf, defi };
}

/** Exported for behavior tests: the AI-summary chunk/backlog seam. */
export async function postProcessIngest(env: Env, ingested: IngestPostResult[], nowMs: number): Promise<void> {
  // 1. Source auto-discovery from forwards + t.me/<handle> links
  if (ingested.length > 0) {
    const candidateJobs: Promise<void>[] = [];
    for (const res of ingested) {
      const selfHandle = res.sourceId.split(':')[1] ?? '';
      const handles = extractCandidateHandles(res.forwardedFrom, res.parsed.urls, selfHandle, REGISTERED_TG_HANDLES);
      if (handles.length > 0) {
        candidateJobs.push(recordCandidates(env.DB, handles, res.sourceId, nowMs));
      }
    }
    await Promise.all(candidateJobs);
  }

  // 2. Workers AI summaries for eligible non-RISK clusters.
  // Group by cluster first: several posts of one cluster in the same tick must
  // produce ONE summary call (one quota slot, no concurrent writes racing on
  // the same cluster row), not one call per post.
  //
  // Deferred clusters: the clusters table itself is the queue — a cluster
  // still on its rule summary (summary_source = 'rule', non-risk, has posts)
  // is pending, so beyond this tick's AI_SUMMARY_CHUNK bound the remainder
  // stays queued and the next tick drains the oldest first (FIFO by
  // first_seen). New clusters are therefore always reconsidered later (the
  // one-off isNewCluster flag no longer gates them out), with no extra queue
  // table or migration.
  const dailyMax = parseNonNegativeInt(env.AI_DAILY_MAX, 300);
  const chunk = Math.max(1, Number.parseInt(env.AI_SUMMARY_CHUNK ?? '6', 10) || 6);
  const byCluster = new Map<string, IngestPostResult[]>();
  for (const r of ingested) {
    if (r.riskLevel === 'risk') continue;
    const group = byCluster.get(r.clusterId);
    if (group) group.push(r);
    else byCluster.set(r.clusterId, [r]);
  }

  // Backlog first (oldest rule-only clusters), then this tick's new groups;
  // only the first `chunk` jobs run, the rest persist as pending.
  const backlog = await env.DB.prepare(
    `SELECT c.id, c.project, c.risk_level FROM clusters c
     WHERE c.summary_source = 'rule' AND c.risk_level != 'risk'
       AND EXISTS (SELECT 1 FROM posts p WHERE p.cluster_id = c.id)
     ORDER BY c.first_seen ASC
     LIMIT ?1`,
  )
    .bind(chunk)
    .all<{ id: string; project: string; risk_level: 'ok' | 'warn' | 'risk' }>();

  const jobs: {
    clusterId: string;
    project: string;
    riskLevel: 'ok' | 'warn' | 'risk';
    rawTexts: string[];
    isNewCluster: boolean;
    isNonLatinSource: boolean;
  }[] = [];
  const claimed = new Set<string>();
  for (const row of backlog.results ?? []) {
    claimed.add(row.id);
    const texts = await env.DB
      .prepare('SELECT text FROM posts WHERE cluster_id = ?1 ORDER BY posted_at DESC LIMIT 3')
      .bind(row.id)
      .all<{ text: string }>();
    jobs.push({
      clusterId: row.id,
      project: row.project,
      riskLevel: row.risk_level,
      rawTexts: (texts.results ?? []).map(t => t.text),
      // Eligibility was already decided by the summary_source = 'rule' filter;
      // these flags only open the quota gate inside summarizeClusterWithAi.
      isNewCluster: true,
      isNonLatinSource: true,
    });
  }
  for (const [clusterId, group] of byCluster) {
    if (claimed.has(clusterId)) continue;
    claimed.add(clusterId);
    jobs.push({
      clusterId,
      project: group[0].parsed.project,
      riskLevel: group[0].riskLevel,
      rawTexts: group.map(g => g.rawText),
      isNewCluster: group[0].isNewCluster,
      isNonLatinSource: group[0].isNonLatinSource,
    });
  }

  await Promise.all(
    jobs.slice(0, chunk).map(job =>
      summarizeClusterWithAi(env.AI, env.DB, {
        clusterId: job.clusterId,
        project: job.project,
        rawTexts: job.rawTexts,
        isNewCluster: job.isNewCluster,
        isNonLatinSource: job.isNonLatinSource,
        riskLevel: job.riskLevel,
        dailyMax,
        nowMs,
      }),
    ),
  );
}

async function runOneMinCron(env: Env, nowMs: number): Promise<void> {
  await syncSources(env.DB, SEED_SOURCES);
  const { surf } = await loadCachedSurfAndDefi(env.DB);
  const batchSize = Math.max(1, Number.parseInt(env.TG_BATCH_SIZE ?? '4', 10) || 4);
  const summary = await pollTelegramBatch(env.DB, batchSize, nowMs, surf);
  await postProcessIngest(env, summary.ingestedResults, nowMs);
}

async function runFiveMinCron(env: Env, nowMs: number): Promise<void> {
  await syncSources(env.DB, SEED_SOURCES);
  const urls: MarketUrls = {
    coingeckoMarkets: env.COINGECKO_MARKETS_URL,
    polymarket: env.POLYMARKET_URL,
    dexBoosts: env.DEX_BOOSTS_URL,
    github: env.GITHUB_SEARCH_URL,
  };

  await Promise.all([
    runIsolated(env.DB, 'airdrops', nowMs, () => fetchSurfAirdrops(env.SURF_AIRDROPS_URL, nowMs)),
    runIsolated(env.DB, 'markets:crypto', nowMs, () => fetchCryptoSection(nowMs, urls)),
    runIsolated(env.DB, 'markets:predictions', nowMs, () => fetchPredictionsSection(nowMs, urls)),
    runIsolated(env.DB, 'markets:trending', nowMs, () => fetchTrendingSection(nowMs, urls)),
    (async () => {
      // Transient D1 read failure must not abort the cron (domain seeding, X
      // polling, pruning, decay all follow). On failure, fall through and
      // refresh github this tick.
      let prev: SnapshotRow | null = null;
      try {
        prev = await readSnapshot(env.DB, 'markets:github');
      } catch (err) {
        console.error('cron-error:readSnapshot:markets:github', err);
      }
      if (prev && prev.ok === 1 && nowMs - prev.fetched_at < THIRTY_MIN_MS) return;
      await runIsolated(env.DB, 'markets:github', nowMs, () => fetchGithubSection(nowMs, urls));
    })(),
  ]);

  const { surf, defi } = await loadCachedSurfAndDefi(env.DB);
  await seedKnownDomains(env.DB, surf, defi);

  // Best-effort X polling (never throws unhandled errors)
  const xBatch = Math.max(1, Number.parseInt(env.X_BATCH_SIZE ?? '3', 10) || 3);
  const xSummary = await pollXBatch(env.DB, xBatch, nowMs, surf);
  await postProcessIngest(env, xSummary.ingestedResults, nowMs);

  await pruneOldPosts(env.DB, nowMs);
  await decayClusterScores(env.DB, nowMs);
}

function isSectionStale(id: MarketSectionId, ok: number, fetchedAt: number, nowMs: number): boolean {
  if (ok !== 1) return true;
  const maxAge = id === 'defi' || id === 'yields' || id === 'github' ? THIRTY_MIN_STALE_MS : FIVE_MIN_STALE_MS;
  return nowMs - fetchedAt > maxAge;
}

async function buildMarketsPayload(db: D1Database, nowMs: number): Promise<{ body: string; etag?: string } | null> {
  const rows = await listSnapshots(db);
  const byKey = new Map(rows.map(r => [r.key, r]));
  const sections: MarketSection[] = [];
  let sectors: MarketSector[] = [];

  for (const id of MARKET_SECTIONS_ORDER) {
    const row = byKey.get(`markets:${id}`);
    if (!row || !row.body || row.body === '{}') continue;
    try {
      const parsed = JSON.parse(row.body) as MarketSection | CryptoSnapshotBody;
      const stale = isSectionStale(id, row.ok, row.fetched_at, nowMs);
      if (id === 'crypto' && 'section' in parsed) {
        sections.push({ ...parsed.section, stale });
        sectors = parsed.sectors ?? [];
      } else {
        sections.push({ ...(parsed as MarketSection), stale });
      }
    } catch {
      // Ignore malformed stored row
    }
  }

  if (sections.length === 0) return null;

  // generatedAt = newest source fetchedAt: content-derived, so the exact body
  // (and its ETag) is stable across cache misses while no section updates.
  const generatedAt = sections.reduce((m, s) => Math.max(m, s.fetchedAt), 0);
  const payload: MarketsResponse = { generatedAt, sections, sectors };
  const body = JSON.stringify(payload);
  return { body, etag: await bodyEtag(body) };
}

async function handleCachedJson(
  request: Request,
  ctx: ExecutionContext,
  cacheControl: string,
  loader: () => Promise<{ body: string; etag?: string } | null>,
): Promise<Response> {
  const cache = caches.default;
  const cacheKey = new Request(request.url, { method: 'GET' });
  const ifNoneMatch = request.headers.get('If-None-Match');

  const cached = await cache.match(cacheKey);
  if (cached) {
    const cachedEtag = cached.headers.get('ETag');
    if (cachedEtag && etagMatches(ifNoneMatch, cachedEtag)) {
      return notModified(cachedEtag, cacheControl);
    }
    const headers = new Headers(cached.headers);
    for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
    return new Response(cached.body, { status: cached.status, headers });
  }

  const loaded = await loader();
  if (!loaded) {
    return jsonResponse(JSON.stringify({ error: 'Snapshot not ready yet' }), 503, {
      'Cache-Control': 'no-store',
    });
  }

  const etag = loaded.etag ?? (await bodyEtag(loaded.body));

  if (etagMatches(ifNoneMatch, etag)) {
    return notModified(etag, cacheControl);
  }

  const res = jsonResponse(loaded.body, 200, {
    ETag: etag,
    'Cache-Control': cacheControl,
  });
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

export default {
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const nowMs = controller.scheduledTime || Date.now();
    if (controller.cron === '* * * * *') {
      await runOneMinCron(env, nowMs);
      return;
    }
    await runFiveMinCron(env, nowMs);
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return jsonResponse(JSON.stringify({ error: 'Method not allowed' }), 405, { 'Cache-Control': 'no-store' });
    }

    const stripBodyIfHead = (res: Response): Response =>
      request.method === 'HEAD' && res.status !== 304 ? new Response(null, { status: res.status, headers: res.headers }) : res;

    const url = new URL(request.url);
    const cacheControl = 'public, max-age=15, s-maxage=30';

    if (url.pathname === '/health') {
      // Metadata-only: /health is no-store and must not read full snapshot bodies.
      const rows = await listSnapshotMeta(env.DB);
      const body: HealthResponse = {
        ok: true,
        snapshots: toHealthMap(rows),
      };
      return stripBodyIfHead(jsonResponse(JSON.stringify(body), 200, { 'Cache-Control': 'no-store' }));
    }

    if (url.pathname === '/airdrops.json') {
      return stripBodyIfHead(
        await handleCachedJson(request, ctx, cacheControl, async () => {
          const row = await readSnapshot(env.DB, 'airdrops');
          if (!row || !row.body || row.body === '{}') return null;
          return { body: row.body, etag: row.etag };
        }),
      );
    }

    if (url.pathname === '/markets.json') {
      return stripBodyIfHead(
        await handleCachedJson(request, ctx, cacheControl, () => buildMarketsPayload(env.DB, Date.now())),
      );
    }

    if (url.pathname === '/feed.json') {
      return stripBodyIfHead(
        await handleCachedJson(request, ctx, 'public, max-age=15, s-maxage=15', async () => {
          const sinceParam = url.searchParams.get('since');
          const limitParam = url.searchParams.get('limit');
          const riskParam = url.searchParams.get('risk') === 'exclude' ? 'exclude' : 'include';
          const sortParam = url.searchParams.get('sort') === 'new' ? 'new' : 'score';
          const { allKnownDomains } = await loadKnownDomains(env.DB);
          // queryFeed clamps non-finite limits to the default itself.
          const feed = await queryFeed(env.DB, allKnownDomains, {
            since: sinceParam ? Number(sinceParam) || 0 : 0,
            limit: limitParam ? Number(limitParam) : 100,
            risk: riskParam,
            sort: sortParam,
          });
          const body = JSON.stringify(feed);
          return { body };
        }),
      );
    }

    if (url.pathname === '/sources.json') {
      return stripBodyIfHead(
        await handleCachedJson(request, ctx, cacheControl, async () => {
          const list = await querySourcesHealth(env.DB);
          const body = JSON.stringify(list);
          return { body };
        }),
      );
    }

    if (url.pathname === '/sources/candidates.json') {
      return stripBodyIfHead(
        await handleCachedJson(request, ctx, cacheControl, async () => {
          const list = await getTopCandidates(env.DB, 50);
          const body = JSON.stringify(list);
          return { body };
        }),
      );
    }

    return jsonResponse(JSON.stringify({ error: 'Not found' }), 404, { 'Cache-Control': 'no-store' });
  },
};
