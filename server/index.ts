import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import workerApp, { type Env } from '../worker/src/index';
import { listSnapshotMeta, toHealthMap } from '../worker/src/lib/db';
import { openDb, type RadarDb } from './db';
import { createRadarScheduler, WARMUP_JOBS, type Scheduler } from './scheduler';

/**
 * Bun has no Cache API. The Worker's fetch handler reads `caches.default` for edge caching; a no-op
 * cache keeps its ETag / If-None-Match handling and leaves caching to the Cache-Control headers.
 */
const globalScope = globalThis as { caches?: unknown };
if (typeof globalScope.caches === 'undefined') {
  globalScope.caches = { default: { match: async () => undefined, put: async () => {}, delete: async () => false } };
}

export const API_PATHS = [
  '/feed.json',
  '/airdrops.json',
  '/markets.json',
  '/sources.json',
  '/sources/candidates.json',
] as const;

const API_ROUTES = new Set<string>(API_PATHS);
const DEFAULT_DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
const SHORT_CACHE = 'public, max-age=300';
const NUL = String.fromCharCode(0);
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

/** Worker env keys read from the environment (everything else in process.env stays out). */
const ENV_KEYS = [
  'TG_BATCH_SIZE',
  'X_BATCH_SIZE',
  'FEED_BATCH_SIZE',
  'X_RSS_MIRROR_BASE',
  'AI_DAILY_MAX',
  'AI_SUMMARY_CHUNK',
  'SURF_AIRDROPS_URL',
  'ASSO7878_SHEET_URL',
  'ARNDXT_SHEET_URL',
  'PENDLE_POINTS_URL',
  'MERKL_OPPORTUNITIES_URL',
  'AIRDROPALERT_CALENDAR_URL',
  'POLYMARKET_URL',
  'COINGECKO_MARKETS_URL',
  'DEX_BOOSTS_URL',
  'GITHUB_SEARCH_URL',
  'LLM_BASE_URL',
  'LLM_API_KEY',
  'LLM_MODEL',
  'CF_ACCOUNT_ID',
  'CF_API_TOKEN',
] as const;

/** Builds the Worker env from process.env: only the listed keys, trimmed, empty values dropped. */
export function buildEnv(db: D1Database, source: Record<string, string | undefined> = process.env): Env {
  const env: Record<string, string | D1Database> = { DB: db };
  for (const key of ENV_KEYS) {
    const value = source[key]?.trim();
    if (value) env[key] = value;
  }
  return env as unknown as Env;
}

export interface AppDeps {
  db: D1Database;
  env: Env;
  distDir: string;
  scheduler: Pick<Scheduler, 'status'> | null;
  /** Worker fetch handler for API paths; defaults to `workerApp.fetch`. */
  api?: (request: Request) => Promise<Response>;
  startedAt?: number;
  now?: () => number;
}

const notFound = () =>
  new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });

/** Request handler: /health here, API paths to the Worker, everything else from the Vite build. */
export function createApp(deps: AppDeps): (request: Request) => Promise<Response> {
  const distRoot = resolve(deps.distDir);
  const indexPath = join(distRoot, 'index.html');
  const startedAt = deps.startedAt ?? deps.now?.() ?? Date.now();
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  const api = deps.api ?? ((request: Request) => workerApp.fetch(request, deps.env, ctx));

  const json = (body: unknown, request: Request, status = 200) =>
    new Response(request.method === 'HEAD' ? null : JSON.stringify(body), {
      status,
      headers: { ...JSON_HEADERS, 'Access-Control-Allow-Origin': '*' },
    });

  async function health(request: Request): Promise<Response> {
    const rows = await listSnapshotMeta(deps.db);
    const scheduler = deps.scheduler?.status() ?? null;
    return json(
      {
        ok: rows.length > 0 && rows.every(r => r.ok === 1),
        snapshots: toHealthMap(rows),
        uptimeSec: Math.max(0, Math.floor(((deps.now?.() ?? Date.now()) - startedAt) / 1000)),
        ready: Boolean(scheduler?.jobs.heavy?.lastFinishedAt),
        scheduler,
      },
      request,
    );
  }

  /** Serves a file under dist; extension-less paths fall back to the SPA shell. */
  async function serveStatic(pathname: string): Promise<Response> {
    let relative = pathname;
    try {
      relative = decodeURIComponent(pathname);
    } catch {
      return notFound();
    }
    const target = resolve(distRoot, `.${relative}`);
    if (relative.includes(NUL) || (target !== distRoot && !target.startsWith(distRoot + sep))) return notFound();

    const asset = relative.startsWith('/assets/');
    const shell = target === distRoot || target === indexPath;
    const file = Bun.file(shell ? indexPath : target);
    const missing = !shell && !(await file.exists());
    if (missing && (asset || relative.split('/').pop()!.includes('.'))) return notFound();

    const cacheControl = asset
      ? IMMUTABLE_CACHE
      : shell || missing
        ? 'no-cache'
        : SHORT_CACHE;
    return new Response(missing ? Bun.file(indexPath) : file, {
      headers: { 'Cache-Control': cacheControl, 'X-Content-Type-Options': 'nosniff' },
    });
  }

  return async function handle(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    try {
      if (pathname === '/health') return await health(request);
      if (API_ROUTES.has(pathname) || request.method === 'OPTIONS') return await api(request);
      return await serveStatic(pathname);
    } catch (err) {
      console.error(`request-error:${request.method} ${pathname}`, err);
      return json({ error: 'Internal error' }, request, 500);
    }
  };
}

export interface ServerOptions {
  dbPath?: string;
  env?: Env;
  distDir?: string;
  port?: number;
  hostname?: string;
  /** Jobs to run once right after the server starts; defaults to WARMUP_JOBS. Pass [] to skip. */
  warmup?: readonly string[];
  scheduler?: Scheduler;
}

export interface RadarServer {
  server: ReturnType<typeof Bun.serve>;
  db: RadarDb;
  scheduler: Scheduler;
  /** Idempotent: stops the schedule, drains requests, closes SQLite. */
  stop(): Promise<void>;
}

export async function startServer(opts: ServerOptions = {}): Promise<RadarServer> {
  const db = openDb(opts.dbPath);
  const env = opts.env ?? buildEnv(db.d1);
  const scheduler = opts.scheduler ?? createRadarScheduler(db.d1, env);
  const server = Bun.serve({
    port: opts.port ?? (Number(process.env.PORT) || 3000),
    hostname: opts.hostname ?? (process.env.HOST || '0.0.0.0'),
    fetch: createApp({ db: db.d1, env, distDir: opts.distDir ?? DEFAULT_DIST, scheduler }),
    error: () => new Response(JSON.stringify({ error: 'Internal error' }), { status: 500, headers: JSON_HEADERS }),
  });
  // Warmup runs in the background so /health answers immediately.
  scheduler.start(opts.warmup ?? WARMUP_JOBS);

  let stopping: Promise<void> | null = null;
  const stop = () =>
    (stopping ??= (async () => {
      await scheduler.stop();
      await server.stop();
      db.close();
    })());
  return { server, db, scheduler, stop };
}

if (import.meta.main) {
  const app = await startServer();
  console.log(
    `web3-radar listening on http://${app.server.hostname}:${app.server.port} (db: ${app.db.path}, ` +
      `migrations applied: ${app.db.migrations.length})`,
  );
  let exiting = false;
  const shutdown = (signal: string) => {
    if (exiting) return;
    exiting = true;
    console.log(`received ${signal}, shutting down`);
    void app.stop().then(
      () => process.exit(0),
      err => {
        console.error('shutdown-error', err);
        process.exit(1);
      },
    );
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => shutdown(signal));
}
