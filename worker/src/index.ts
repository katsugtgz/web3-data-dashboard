import { MARKET_SECTIONS_ORDER } from '../../shared/constants';
import type {
  AirdropFeed,
  HealthResponse,
  MarketSection,
  MarketSectionId,
  MarketSector,
  MarketsResponse,
} from '../../shared/types';
import { runIfDue } from './lib/cronGate';
import {
  listSnapshotMeta,
  listSnapshotsByPrefix,
  markSnapshotError,
  readSnapshot,
  readSnapshotMeta,
  sha1Hex,
  toHealthMap,
  upsertSnapshot,
  type SnapshotMetaWithLenRow,
  type SnapshotRow,
} from './lib/db';
import {
  buildFeedLogoIndex,
  queryFeed,
  querySourcesHealth,
  type FeedLogoIndex,
  type IngestPostResult,
} from './normalize/cluster';
import { decayClusterScores } from './normalize/score';
import {
  AI_MAX_ATTEMPTS,
  hasAiQuotaRemaining,
  summarizeClusterWithAi,
  type AiBindingLike,
} from './normalize/summarize';
import { loadKnownDomains, seedKnownDomains } from './safety';
import { buildCuratedAirdropFeed, type CuratedSourceOutcome } from './sources/curated';
import { extractCandidateHandles, getTopCandidates, recordCandidates } from './sources/discover';
import { computeFeedBackoff, pollFeedBatch } from './sources/feeds';
import {
  enrichYieldRowIcons,
  fetchCryptoSection,
  fetchGithubSection,
  fetchPredictionsSection,
  fetchTrendingSection,
  type MarketUrls,
} from './sources/markets';
import { SEED_SOURCES, syncSources } from './sources/registry';
import { pollTelegramBatch, pruneOldPosts } from './sources/telegram';
import { pollXBatch } from './sources/x';

export interface Env {
  DB: D1Database;
  AI?: AiBindingLike;
  TG_BATCH_SIZE?: string;
  X_BATCH_SIZE?: string;
  FEED_BATCH_SIZE?: string;
  X_RSS_MIRROR_BASE?: string;
  AI_DAILY_MAX?: string;
  AI_SUMMARY_CHUNK?: string;
  SURF_AIRDROPS_URL?: string;
  ASSO7878_SHEET_URL?: string;
  ARNDXT_SHEET_URL?: string;
  PENDLE_POINTS_URL?: string;
  MERKL_OPPORTUNITIES_URL?: string;
  AIRDROPALERT_CALENDAR_URL?: string;
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
  'Access-Control-Max-Age': '86400',
};

const utf8Encoder = new TextEncoder();

const THIRTY_MIN_MS = 30 * 60_000;
const SIXTY_MIN_MS = 60 * 60_000;
const SIX_H_MS = 6 * 3_600_000;
const FIVE_MIN_STALE_MS = 15 * 60_000;
const THIRTY_MIN_STALE_MS = 90 * 60_000;

const syncedDbs = new WeakSet<D1Database>();

/** Syncs static seed sources once per D1 instance; retries on transient failure. */
export async function ensureSourcesSynced(db: D1Database): Promise<void> {
  if (syncedDbs.has(db)) return;
  await syncSources(db, SEED_SOURCES);
  syncedDbs.add(db);
}

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
      'Content-Length': String(utf8Encoder.encode(body).byteLength),
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
      Vary: 'Accept-Encoding',
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

function parseSnapshotJson<T>(row: SnapshotRow | null): T | null {
  if (!row?.body || row.body === '{}') return null;
  try {
    return JSON.parse(row.body) as T;
  } catch {
    return null;
  }
}

async function loadCachedSurf(db: D1Database): Promise<AirdropFeed | null> {
  try {
    return parseSnapshotJson<AirdropFeed>(await readSnapshot(db, 'airdrops'));
  } catch (err) {
    console.error('cron-error:loadCachedSurf', err);
    return null;
  }
}

async function loadCachedAirdrops(db: D1Database): Promise<{ feed: AirdropFeed | null; fetchedAt: number }> {
  let row: SnapshotRow | null = null;
  try {
    row = await readSnapshot(db, 'airdrops');
  } catch (err) {
    console.error('cron-error:loadCachedAirdrops', err);
  }
  const feed = parseSnapshotJson<AirdropFeed>(row);
  return { feed, fetchedAt: feed && row ? row.fetched_at : 0 };
}

const FEED_LOGO_INDEX_TTL_MS = 5 * 60_000;
const feedLogoIndexCache = new WeakMap<D1Database, { value: FeedLogoIndex; expiresAt: number }>();

async function loadFeedLogoIndex(db: D1Database, nowMs = Date.now()): Promise<FeedLogoIndex> {
  const cached = feedLogoIndexCache.get(db);
  if (cached && nowMs < cached.expiresAt) return cached.value;

  const [airdropsLoaded, defiLoaded] = await Promise.all([loadCachedAirdrops(db), loadCachedDefi(db)]);
  const value = buildFeedLogoIndex(airdropsLoaded.feed, defiLoaded.defi);
  feedLogoIndexCache.set(db, { value, expiresAt: nowMs + FEED_LOGO_INDEX_TTL_MS });
  return value;
}

async function loadCachedDefi(db: D1Database): Promise<{ defi: MarketSection | null; fetchedAt: number }> {
  let row: SnapshotRow | null = null;
  try {
    row = await readSnapshot(db, 'markets:defi');
  } catch (err) {
    console.error('cron-error:loadCachedDefi', err);
  }
  const defi = parseSnapshotJson<MarketSection>(row);
  return { defi, fetchedAt: defi && row ? row.fetched_at : 0 };
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
  // The clusters table itself is the single-source-of-truth priority queue:
  // a cluster still on its rule summary (summary_source = 'rule', non-risk,
  // below AI_MAX_ATTEMPTS, past ai_retry_after, has posts) is eligible, and
  // each tick drains up to AI_SUMMARY_CHUNK highest-priority clusters first
  // (score DESC, last_seen DESC) while persisting the remainder.
  const dailyMax = parseNonNegativeInt(env.AI_DAILY_MAX, 300);
  const chunk = Math.min(100, parseNonNegativeInt(env.AI_SUMMARY_CHUNK, 6));
  if (!env.AI || dailyMax <= 0 || chunk <= 0) return;
  if (!(await hasAiQuotaRemaining(env.DB, dailyMax, nowMs))) return;

  // Priority by score DESC, last_seen DESC; literal attempt cap and drop filter
  // match partial index clusters_ai_backlog.
  const backlog = await env.DB.prepare(
    `SELECT c.id, c.project, c.risk_level FROM clusters c
     WHERE c.summary_source = 'rule'
       AND c.risk_level != 'risk'
       AND c.ai_attempts < ${AI_MAX_ATTEMPTS}
       AND c.ai_retry_after <= ?1
       AND (c.is_drop IS NULL OR c.is_drop = 1)
       AND EXISTS (SELECT 1 FROM posts p JOIN sources s ON s.id = p.source_id WHERE p.cluster_id = c.id AND s.enabled = 1)
     ORDER BY c.score DESC, c.last_seen DESC
     LIMIT ?2`,
  )
    .bind(nowMs, chunk)
    .all<{ id: string; project: string; risk_level: 'ok' | 'warn' | 'risk' }>();

  if (!backlog.results?.length) return;

  // One windowed fetch instead of one query per backlog cluster (N+1):
  // results partitioned in JS preserves the 3-newest-per-cluster cap while
  // issuing a single D1 round trip.
  const placeholders = backlog.results.map((_, i) => `?${i + 1}`).join(', ');
  const texts = await env.DB.prepare(
    `SELECT cluster_id, text,
            ROW_NUMBER() OVER (PARTITION BY cluster_id ORDER BY posted_at DESC) AS rn
     FROM posts WHERE cluster_id IN (${placeholders})`,
  )
    .bind(...backlog.results.map(r => r.id))
    .all<{ cluster_id: string; text: string; rn: number }>();
  const textsByCluster = new Map<string, string[]>();
  for (const t of texts.results ?? []) {
    if (t.rn > 3) continue;
    let arr = textsByCluster.get(t.cluster_id);
    if (!arr) textsByCluster.set(t.cluster_id, (arr = []));
    arr.push(t.text);
  }

  await Promise.all(
    backlog.results.map(row =>
      summarizeClusterWithAi(env.AI, env.DB, {
        clusterId: row.id,
        project: row.project,
        rawTexts: (textsByCluster.get(row.id) ?? []).slice(0, 3),
        // Eligibility was already decided by the backlog filter; these flags
        // only open the gate inside summarizeClusterWithAi.
        isNewCluster: true,
        isNonLatinSource: true,
        riskLevel: row.risk_level,
        dailyMax,
        nowMs,
      }),
    ),
  );
}

async function runOneMinCron(env: Env, nowMs: number): Promise<void> {
  await ensureSourcesSynced(env.DB);
  const batchSize = parseNonNegativeInt(env.TG_BATCH_SIZE, 4);
  const summary =
    batchSize > 0
      ? await pollTelegramBatch(env.DB, batchSize, nowMs, () => loadCachedSurf(env.DB))
      : { polled: 0, insertedPosts: 0, errors: 0, ingestedResults: [] };
  try {
    await postProcessIngest(env, summary.ingestedResults, nowMs);
  } catch (err) {
    console.error('cron-error:postProcessIngest:1m', err);
  }
}

async function loadCachedDefiLlamaAirdrops(db: D1Database, nowMs: number): Promise<AirdropFeed | null> {
  try {
    const row = await readSnapshot(db, 'airdrops:defillama');
    if (!row?.body || row.body === '{}') return null;
    if (nowMs - row.fetched_at > SIX_H_MS) return null;
    const parsed = JSON.parse(row.body) as AirdropFeed;
    return Array.isArray(parsed?.cards) ? parsed : null;
  } catch (err) {
    console.error('cron-error:loadCachedDefiLlamaAirdrops', err);
    return null;
  }
}

async function loadFreshCachedSheetFeed(
  db: D1Database,
  key: string,
  nowMs: number,
): Promise<{ feed: AirdropFeed; fetchedAt: number } | null> {
  try {
    const row = await readSnapshot(db, key);
    if (!row || row.ok !== 1 || !row.body || row.body === '{}') return null;
    if (nowMs - row.fetched_at > SIX_H_MS) return null;
    const parsed = JSON.parse(row.body) as AirdropFeed;
    const hasCards = Array.isArray(parsed?.cards) && parsed.cards.length > 0;
    const hasTge = Array.isArray(parsed?.tge) && parsed.tge.length > 0;
    return hasCards || hasTge ? { feed: parsed, fetchedAt: row.fetched_at } : null;
  } catch (err) {
    console.error(`cron-error:loadFreshCachedSheetFeed:${key}`, err);
    return null;
  }
}

async function recordCachedSheetHealth(
  db: D1Database,
  entries: { sourceId: string; fetchedAt: number }[],
): Promise<void> {
  if (entries.length === 0) return;
  await Promise.all(
    entries.map(async ({ sourceId, fetchedAt }) => {
      try {
        await db
          .prepare(
            `UPDATE sources
             SET last_ok_at = MAX(COALESCE(last_ok_at, 0), ?2),
                 last_polled_at = MAX(COALESCE(last_polled_at, 0), ?2),
                 status = 'ok',
                 fail_count = 0,
                 first_fail_at = NULL,
                 next_poll_at = NULL
             WHERE id = ?1`,
          )
          .bind(sourceId, fetchedAt)
          .run();
      } catch (err) {
        console.error(`cron-error:cached-sheet-health:${sourceId}`, err);
      }
    }),
  );
}

async function recordCuratedSourceOutcomes(
  db: D1Database,
  outcomes: CuratedSourceOutcome[],
  nowMs: number,
): Promise<void> {
  // Update health for sheet:* and curated-only feed:* sources (airdropalert_calendar
  // is owned by pollFeedBatch so its cursor and TTL stay independent).
  const tracked = outcomes.filter(o => o.sourceId && o.sourceId !== 'feed:airdropalert_calendar');
  if (tracked.length === 0) return;

  await Promise.all(
    tracked.map(async o => {
      try {
        if (o.ok) {
          await db
            .prepare(
              `UPDATE sources
               SET last_ok_at = ?2, last_polled_at = ?2, status = 'ok',
                   fail_count = 0, first_fail_at = NULL, next_poll_at = ?3
               WHERE id = ?1`,
            )
            .bind(o.sourceId!, nowMs, nowMs + THIRTY_MIN_MS)
            .run();
        } else {
          const prev = await db
            .prepare('SELECT fail_count, first_fail_at FROM sources WHERE id = ?1')
            .bind(o.sourceId!)
            .first<{ fail_count: number; first_fail_at: number | null }>();
          const backoff = computeFeedBackoff(prev?.fail_count ?? 0, prev?.first_fail_at ?? null, nowMs);
          await db
            .prepare(
              `UPDATE sources
               SET last_polled_at = ?2, fail_count = ?3, first_fail_at = ?4, status = ?5, next_poll_at = ?6
               WHERE id = ?1`,
            )
            .bind(o.sourceId!, nowMs, backoff.failCount, backoff.firstFailAt, backoff.status, backoff.nextPollAt)
            .run();
        }
      } catch (err) {
        console.error(`cron-error:curated-health:${o.sourceId}`, err);
      }
    }),
  );
}

async function runFiveMinCron(env: Env, nowMs: number): Promise<void> {
  await ensureSourcesSynced(env.DB);
  const urls: MarketUrls = {
    coingeckoMarkets: env.COINGECKO_MARKETS_URL,
    polymarket: env.POLYMARKET_URL,
    dexBoosts: env.DEX_BOOSTS_URL,
    github: env.GITHUB_SEARCH_URL,
  };

  let inMemoryAirdrops: AirdropFeed | null = null;
  let airdropsLoaded = false;
  let airdropsFetchedAt = 0;
  let airdropsHasBody = false;

  await Promise.all([
    (async () => {
      // Throttle curated multi-source refresh via metadata-only snapshots lookup
      // (30-min TTL), avoiding full 600KB body reads on sub-interval ticks.
      let prevMeta: SnapshotMetaWithLenRow | null = null;
      try {
        prevMeta = await readSnapshotMeta(env.DB, 'airdrops');
      } catch (err) {
        console.error('cron-error:readSnapshotMeta:airdrops', err);
      }
      if (prevMeta && prevMeta.body_len > 2) {
        airdropsHasBody = true;
        airdropsFetchedAt = prevMeta.fetched_at;
        if (prevMeta.ok === 1 && nowMs - prevMeta.fetched_at < THIRTY_MIN_MS) return;
      }

      const [prevLoaded, defiLlamaFeed, cachedAsso, cachedArndxt, sourceStates] = await Promise.all([
        !prevMeta || prevMeta.body_len > 2 ? loadCachedAirdrops(env.DB) : Promise.resolve({ feed: null, fetchedAt: 0 }),
        loadCachedDefiLlamaAirdrops(env.DB, nowMs),
        loadFreshCachedSheetFeed(env.DB, 'airdrops:asso7878', nowMs),
        loadFreshCachedSheetFeed(env.DB, 'airdrops:arndxt', nowMs),
        (async () => {
          const disabledSourceIds = new Set<string>();
          const deferredSourceIds = new Set<string>();
          try {
            const res = await env.DB.prepare(
              `SELECT id, enabled, status, next_poll_at
               FROM sources
               WHERE platform IN ('sheet', 'feed')`,
            ).all<{ id: string; enabled: number; status: string | null; next_poll_at: number | null }>();
            for (const row of res.results ?? []) {
              const lowerId = row.id.toLowerCase();
              if (row.enabled === 0) {
                disabledSourceIds.add(lowerId);
              } else if (
                row.next_poll_at != null &&
                row.next_poll_at > nowMs &&
                (lowerId !== 'feed:airdropalert_calendar' || row.status !== 'ok')
              ) {
                deferredSourceIds.add(lowerId);
              }
            }
          } catch (err) {
            console.error('cron-error:curated-sources-state', err);
          }
          return { disabledSourceIds, deferredSourceIds };
        })(),
      ]);

      // Fresh offloaded sheet snapshots bypass live CSV parsing (keeping Worker
      // CPU well under 10 ms) and should never be blocked by prior live backoff.
      const cachedSheetHealth: { sourceId: string; fetchedAt: number }[] = [];
      if (cachedAsso && !sourceStates.disabledSourceIds.has('sheet:asso7878_sheet')) {
        sourceStates.deferredSourceIds.delete('sheet:asso7878_sheet');
        cachedSheetHealth.push({ sourceId: 'sheet:asso7878_sheet', fetchedAt: cachedAsso.fetchedAt });
      }
      if (cachedArndxt && !sourceStates.disabledSourceIds.has('sheet:arndxt_sheet')) {
        sourceStates.deferredSourceIds.delete('sheet:arndxt_sheet');
        cachedSheetHealth.push({ sourceId: 'sheet:arndxt_sheet', fetchedAt: cachedArndxt.fetchedAt });
      }

      const prevFeed = prevLoaded.feed;
      try {
        const res = await buildCuratedAirdropFeed({
          nowMs,
          surfUrl: env.SURF_AIRDROPS_URL,
          asso7878Url: env.ASSO7878_SHEET_URL,
          arndxtUrl: env.ARNDXT_SHEET_URL,
          pendleUrl: env.PENDLE_POINTS_URL,
          merklUrl: env.MERKL_OPPORTUNITIES_URL,
          airdropAlertUrl: env.AIRDROPALERT_CALENDAR_URL,
          defiLlamaFeed,
          cachedAsso7878Feed: cachedAsso?.feed ?? null,
          cachedArndxtFeed: cachedArndxt?.feed ?? null,
          prevFeed,
          disabledSourceIds: sourceStates.disabledSourceIds,
          deferredSourceIds: sourceStates.deferredSourceIds,
          onOutcomes: async outcomes => {
            await Promise.all([
              recordCuratedSourceOutcomes(env.DB, outcomes, nowMs),
              recordCachedSheetHealth(env.DB, cachedSheetHealth),
            ]);
          },
        });
        await upsertSnapshot(env.DB, 'airdrops', res.feed, nowMs);
        feedLogoIndexCache.delete(env.DB);
        inMemoryAirdrops = res.feed;
        airdropsLoaded = true;
        airdropsHasBody = true;
        airdropsFetchedAt = nowMs;
      } catch (err) {
        console.error('cron-error:airdrops', err);
        await markSnapshotError(env.DB, 'airdrops', err, nowMs);
        inMemoryAirdrops = prevFeed;
        airdropsLoaded = true;
        airdropsHasBody = Boolean(prevFeed);
        airdropsFetchedAt = prevFeed ? prevLoaded.fetchedAt : 0;
      }
    })(),
    runIsolated(env.DB, 'markets:crypto', nowMs, () => fetchCryptoSection(nowMs, urls)),
    runIsolated(env.DB, 'markets:predictions', nowMs, () => fetchPredictionsSection(nowMs, urls)),
    runIsolated(env.DB, 'markets:trending', nowMs, () => fetchTrendingSection(nowMs, urls)),
    (async () => {
      // Transient D1 read failure must not abort the cron (domain seeding, X
      // polling, pruning, decay all follow). On failure, fall through and
      // refresh github this tick.
      let prev: SnapshotMetaWithLenRow | null = null;
      try {
        prev = await readSnapshotMeta(env.DB, 'markets:github');
      } catch (err) {
        console.error('cron-error:readSnapshotMeta:markets:github', err);
      }
      if (prev && prev.ok === 1 && prev.body_len > 2 && nowMs - prev.fetched_at < THIRTY_MIN_MS) return;
      await runIsolated(env.DB, 'markets:github', nowMs, () => fetchGithubSection(nowMs, urls));
    })(),
  ]);

  // Gate seedKnownDomains on actual airdrops or markets:defi snapshot updates
  // (tracked via cron_state 'known_domains_seed') to avoid full 5-min rescans.
  let defiMeta: SnapshotMetaWithLenRow | null = null;
  let lastSeededAt = 0;
  try {
    const [dm, seedRow] = await Promise.all([
      readSnapshotMeta(env.DB, 'markets:defi'),
      env.DB.prepare(`SELECT last_run_at FROM cron_state WHERE key = 'known_domains_seed'`).first<{
        last_run_at: number;
      }>(),
    ]);
    defiMeta = dm;
    lastSeededAt = seedRow?.last_run_at ?? 0;
  } catch (err) {
    console.error('cron-error:known_domains_seed_meta', err);
  }

  const airdropsValidTs = airdropsHasBody ? airdropsFetchedAt : 0;
  const defiValidTs = defiMeta && defiMeta.body_len > 2 ? defiMeta.fetched_at : 0;
  const latestDomainSourceTs = Math.max(airdropsValidTs, defiValidTs);

  const xBatch = parseNonNegativeInt(env.X_BATCH_SIZE, 3);
  const feedBatch = parseNonNegativeInt(env.FEED_BATCH_SIZE, 3);

  let surf: AirdropFeed | null = inMemoryAirdrops;
  if (latestDomainSourceTs > lastSeededAt) {
    const [loadedSurf, loadedDefi] = await Promise.all([
      !airdropsLoaded && airdropsHasBody ? loadCachedAirdrops(env.DB) : Promise.resolve({ feed: surf, fetchedAt: airdropsFetchedAt }),
      defiValidTs > 0 ? loadCachedDefi(env.DB) : Promise.resolve({ defi: null, fetchedAt: 0 }),
    ]);
    surf = loadedSurf.feed;
    airdropsLoaded = true;
    await seedKnownDomains(env.DB, surf, loadedDefi.defi);
    await env.DB.prepare(
      `INSERT INTO cron_state (key, last_run_at) VALUES ('known_domains_seed', ?1)
       ON CONFLICT(key) DO UPDATE SET last_run_at = excluded.last_run_at
       WHERE excluded.last_run_at > cron_state.last_run_at`,
    )
      .bind(latestDomainSourceTs)
      .run();
  } else if (!airdropsLoaded && airdropsHasBody && (xBatch > 0 || feedBatch > 0)) {
    surf = (await loadCachedAirdrops(env.DB)).feed;
    airdropsLoaded = true;
  }

  // Best-effort X polling + chronological keyless drop feeds (both throttled via sources.next_poll_at)
  const [xRes, feedRes] = await Promise.allSettled([
    xBatch > 0
      ? pollXBatch(env.DB, xBatch, nowMs, surf, undefined, env.X_RSS_MIRROR_BASE)
      : Promise.resolve({ polled: 0, insertedPosts: 0, degraded: 0, ingestedResults: [] }),
    feedBatch > 0
      ? pollFeedBatch(env.DB, feedBatch, nowMs, surf)
      : Promise.resolve({ polled: 0, insertedPosts: 0, degraded: 0, ingestedResults: [] }),
  ]);
  if (xRes.status === 'rejected') console.error('cron-error:pollXBatch', xRes.reason);
  if (feedRes.status === 'rejected') console.error('cron-error:pollFeedBatch', feedRes.reason);
  const xIngested = xRes.status === 'fulfilled' ? xRes.value.ingestedResults : [];
  const feedIngested = feedRes.status === 'fulfilled' ? feedRes.value.ingestedResults : [];
  try {
    await postProcessIngest(env, [...xIngested, ...feedIngested], nowMs);
  } catch (err) {
    console.error('cron-error:postProcessIngest', err);
  }

  await runIfDue(env.DB, 'prune', SIXTY_MIN_MS, nowMs, async () => {
    await pruneOldPosts(env.DB, nowMs);
  });
  await runIfDue(env.DB, 'decay', SIXTY_MIN_MS, nowMs, () => decayClusterScores(env.DB, nowMs));
}

function isSectionStale(id: MarketSectionId, ok: number, fetchedAt: number, nowMs: number): boolean {
  if (ok !== 1) return true;
  const maxAge = id === 'defi' || id === 'yields' || id === 'github' ? THIRTY_MIN_STALE_MS : FIVE_MIN_STALE_MS;
  return nowMs - fetchedAt > maxAge;
}

async function buildMarketsPayload(db: D1Database, nowMs: number): Promise<{ body: string; etag?: string } | null> {
  const rows = await listSnapshotsByPrefix(db, 'markets:');
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

  const defiSection = sections.find(s => s.id === 'defi');
  const yieldsIdx = sections.findIndex(s => s.id === 'yields');
  if (defiSection && yieldsIdx >= 0) {
    sections[yieldsIdx] = enrichYieldRowIcons(sections[yieldsIdx], defiSection);
  }

  // generatedAt = newest source fetchedAt: content-derived, so the exact body
  // (and its ETag) is stable across cache misses while no section updates.
  const generatedAt = sections.reduce((m, s) => Math.max(m, s.fetchedAt), 0);
  const payload: MarketsResponse = { generatedAt, sections, sectors };
  const body = JSON.stringify(payload);
  return { body, etag: await bodyEtag(body) };
}

interface CanonicalFeedParams {
  since: number;
  limit: number;
  risk: 'include' | 'exclude';
  sort: 'score' | 'new';
  cursor?: string;
}

function parseFeedParams(url: URL): CanonicalFeedParams {
  const sinceParam = url.searchParams.get('since');
  const parsedSince = sinceParam ? Number(sinceParam) : 0;
  const since = Number.isFinite(parsedSince) ? parsedSince : 0;

  const limitParam = url.searchParams.get('limit');
  const parsedLimit = limitParam ? Number(limitParam) : 100;
  const limit = Number.isFinite(parsedLimit) ? Math.min(100, Math.max(1, Math.floor(parsedLimit))) : 100;

  const risk = url.searchParams.get('risk') === 'exclude' ? 'exclude' : 'include';
  const sort = url.searchParams.get('sort') === 'new' ? 'new' : 'score';
  const cursor = url.searchParams.get('cursor') || undefined;

  return { since, limit, risk, sort, cursor };
}

export function buildCacheKey(requestUrl: string | URL): Request {
  const url = typeof requestUrl === 'string' ? new URL(requestUrl) : requestUrl;
  const base = `${url.origin}${url.pathname}`;
  if (url.pathname !== '/feed.json') {
    return new Request(base, { method: 'GET' });
  }
  const p = parseFeedParams(url);
  const canonical = new URLSearchParams();
  if (p.cursor) canonical.set('cursor', p.cursor);
  if (p.limit !== 100) canonical.set('limit', String(p.limit));
  if (p.risk !== 'include') canonical.set('risk', p.risk);
  if (p.since !== 0) canonical.set('since', String(p.since));
  if (p.sort !== 'score') canonical.set('sort', p.sort);
  const qs = canonical.toString();
  return new Request(qs ? `${base}?${qs}` : base, { method: 'GET' });
}

async function handleCachedJson(
  request: Request,
  ctx: ExecutionContext,
  cacheControl: string,
  loader: () => Promise<{ body: string; etag?: string } | null>,
): Promise<Response> {
  const cache = caches.default;
  const cacheKey = buildCacheKey(request.url);
  const ifNoneMatch = request.headers.get('If-None-Match');

  const cached = await cache.match(cacheKey);
  if (cached) {
    const cachedEtag = cached.headers.get('ETag');
    if (cachedEtag && etagMatches(ifNoneMatch, cachedEtag)) {
      void cached.body?.cancel();
      return notModified(cachedEtag, cacheControl);
    }
    const headers = new Headers(cached.headers);
    for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
    headers.set('Vary', 'Accept-Encoding');
    if (request.method === 'HEAD') {
      void cached.body?.cancel();
      return new Response(null, { status: cached.status, headers });
    }
    return new Response(cached.body, { status: cached.status, headers });
  }

  const loaded = await loader();
  if (!loaded) {
    return jsonResponse(JSON.stringify({ error: 'Snapshot not ready yet' }), 503, {
      'Cache-Control': 'no-store',
    });
  }

  const etag = loaded.etag ?? (await bodyEtag(loaded.body));
  const res = jsonResponse(loaded.body, 200, {
    ETag: etag,
    'Cache-Control': cacheControl,
    Vary: 'Accept-Encoding',
  });

  if (etagMatches(ifNoneMatch, etag)) {
    ctx.waitUntil(cache.put(cacheKey, res));
    return notModified(etag, cacheControl);
  }

  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

export default {
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const nowMs = controller.scheduledTime || Date.now();
    if (controller.cron !== '*/5 * * * *') {
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
      return jsonResponse(JSON.stringify({ error: 'Method not allowed' }), 405, {
        Allow: 'GET, HEAD, OPTIONS',
        'Cache-Control': 'no-store',
      });
    }

    const stripBodyIfHead = (res: Response): Response => {
      if (request.method !== 'HEAD' || res.status === 304) return res;
      void res.body?.cancel();
      return new Response(null, { status: res.status, headers: res.headers });
    };

    const url = new URL(request.url);
    const cacheControl = 'public, max-age=60, s-maxage=120';

    if (url.pathname === '/health') {
      // Metadata-only: /health is no-store and must not read full snapshot bodies.
      const rows = await listSnapshotMeta(env.DB);
      const body: HealthResponse = {
        ok: rows.length > 0 && rows.every(r => r.ok === 1),
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
        await handleCachedJson(request, ctx, 'public, max-age=30, s-maxage=60', async () => {
          const feedParams = parseFeedParams(url);
          const [{ allKnownDomains }, logoIndex] = await Promise.all([
            loadKnownDomains(env.DB),
            loadFeedLogoIndex(env.DB),
          ]);
          const feed = await queryFeed(env.DB, allKnownDomains, { ...feedParams, logoIndex });
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

    return stripBodyIfHead(
      jsonResponse(JSON.stringify({ error: 'Not found' }), 404, { 'Cache-Control': 'no-store' }),
    );
  },
};
