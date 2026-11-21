import { MARKET_SECTIONS_ORDER } from '../../shared/constants';
import type { HealthResponse, MarketSection, MarketSectionId, MarketSector, MarketsResponse } from '../../shared/types';
import {
  listSnapshots,
  markSnapshotError,
  readSnapshot,
  sha1Hex,
  toHealthMap,
  upsertSnapshot,
} from './lib/db';
import {
  fetchCryptoSection,
  fetchGithubSection,
  fetchPredictionsSection,
  fetchTrendingSection,
  type MarketUrls,
} from './sources/markets';
import { fetchSurfAirdrops } from './sources/surf';

export interface Env {
  DB: D1Database;
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

interface CryptoSnapshotBody {
  section: MarketSection;
  sectors: MarketSector[];
}

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

async function runIsolated(db: D1Database, key: string, nowMs: number, fn: () => Promise<unknown>): Promise<void> {
  try {
    const data = await fn();
    await upsertSnapshot(db, key, data, nowMs);
  } catch (err) {
    console.error(`cron-error:${key}`, err);
    await markSnapshotError(db, key, err, nowMs);
  }
}

async function runFiveMinCron(env: Env, nowMs: number): Promise<void> {
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
      const prev = await readSnapshot(env.DB, 'markets:github');
      if (prev && prev.ok === 1 && nowMs - prev.fetched_at < THIRTY_MIN_MS) return;
      await runIsolated(env.DB, 'markets:github', nowMs, () => fetchGithubSection(nowMs, urls));
    })(),
  ]);
}

function isSectionStale(id: MarketSectionId, ok: number, fetchedAt: number, nowMs: number): boolean {
  if (ok !== 1) return true;
  const maxAge = id === 'defi' || id === 'yields' || id === 'github' ? THIRTY_MIN_STALE_MS : FIVE_MIN_STALE_MS;
  return nowMs - fetchedAt > maxAge;
}

function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const norm = (v: string) => v.trim().replace(/^W\//i, '');
  const target = norm(etag);
  return ifNoneMatch.split(',').some(part => norm(part) === target || part.trim() === '*');
}

async function buildMarketsPayload(db: D1Database, nowMs: number): Promise<{ body: string; etag: string } | null> {
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

  const payload: MarketsResponse = { generatedAt: nowMs, sections, sectors };
  const body = JSON.stringify(payload);
  const etag = `"${await sha1Hex(body)}"`;
  return { body, etag };
}

async function handleCachedJson(
  request: Request,
  ctx: ExecutionContext,
  cacheControl: string,
  loader: () => Promise<{ body: string; etag: string } | null>,
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

  if (etagMatches(ifNoneMatch, loaded.etag)) {
    return notModified(loaded.etag, cacheControl);
  }

  const res = jsonResponse(loaded.body, 200, {
    ETag: loaded.etag,
    'Cache-Control': cacheControl,
  });
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

export default {
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const nowMs = controller.scheduledTime || Date.now();
    if (controller.cron === '* * * * *') {
      // 1-min Telegram batch handler is wired in Phase 2 (#5).
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
      const rows = await listSnapshots(env.DB);
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

    return jsonResponse(JSON.stringify({ error: 'Not found' }), 404, { 'Cache-Control': 'no-store' });
  },
};
