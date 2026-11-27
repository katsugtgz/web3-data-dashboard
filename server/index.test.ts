import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { upsertSnapshot } from '../worker/src/lib/db';
import { openDb } from './db';
import { API_PATHS, buildEnv, createApp, startServer } from './index';
import { JOB, createScheduler, type JobStatus } from './scheduler';

const T0 = 1_800_000_000_000;
const SHELL = '<!doctype html><html><body>radar</body></html>';

function makeDist(): string {
  const dir = mkdtempSync(join(tmpdir(), 'radar-dist-'));
  mkdirSync(join(dir, 'assets'));
  mkdirSync(join(dir, 'data'));
  writeFileSync(join(dir, 'index.html'), SHELL);
  writeFileSync(join(dir, 'assets', 'app.abc123.js'), 'console.log(1)');
  writeFileSync(join(dir, 'data', 'feed.json'), '{"items":[]}');
  writeFileSync(join(dir, 'icon.svg'), '<svg/>');
  return dir;
}

function fakeApi() {
  const calls: { method: string; path: string; etag: string | null }[] = [];
  return {
    calls,
    api: async (request: Request) => {
      calls.push({ method: request.method, path: new URL(request.url).pathname, etag: request.headers.get('if-none-match') });
      // Same HEAD contract as the Worker handler: headers only.
      return new Response(request.method === 'HEAD' ? null : JSON.stringify({ path: new URL(request.url).pathname, limit: new URL(request.url).searchParams.get('limit') }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ETag: '"v1"', 'Access-Control-Allow-Origin': '*' },
      });
    },
  };
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// One fake Vite build per run; removal retries because Windows releases file handles late.
let distDir = '';
beforeAll(() => {
  distDir = makeDist();
});
afterAll(async () => {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      rmSync(distDir, { recursive: true, force: true });
      return;
    } catch {
      await sleep(50);
    }
  }
});

function makeApp(overrides: Partial<Parameters<typeof createApp>[0]> = {}) {
  const db = openDb(':memory:');
  const { api, calls } = fakeApi();
  const scheduler = createScheduler([{ name: JOB.heavy, everyMs: 60_000, run: async () => {} }]);
  let clock = T0;
  const handle = createApp({
    db: db.d1,
    env: { DB: db.d1 },
    distDir,
    scheduler,
    api,
    startedAt: T0,
    now: () => clock,
    ...overrides,
  });
  return { db, handle, calls, scheduler, advance: (ms: number) => (clock += ms) };
}

interface HealthBody {
  ok: boolean;
  snapshots: Record<string, unknown>;
  uptimeSec: number;
  ready: boolean;
  scheduler: { running: boolean; jobs: Record<string, JobStatus> };
}
const healthOf = async (res: Response): Promise<HealthBody> => (await res.json()) as HealthBody;

describe('static site', () => {
  test('serves the SPA shell without caching it, on / and client-side routes', async () => {
    const { handle } = makeApp();
    for (const path of ['/', '/airdrops', '/some/client/route']) {
      const res = await handle(new Request(`http://radar.test${path}`));
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(SHELL);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(res.headers.get('cache-control')).toBe('no-cache');
    }
  });

  test('caches hashed assets as immutable', async () => {
    const { handle } = makeApp();
    const res = await handle(new Request('http://radar.test/assets/app.abc123.js'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('console.log(1)');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  test('serves bundled snapshots and other files with a short cache', async () => {
    const { handle } = makeApp();
    const snapshot = await handle(new Request('http://radar.test/data/feed.json'));
    expect(await snapshot.json()).toEqual({ items: [] });
    expect(snapshot.headers.get('cache-control')).toBe('public, max-age=300');
    const icon = await handle(new Request('http://radar.test/icon.svg'));
    expect(icon.headers.get('content-type')).toContain('image/svg+xml');
    expect(icon.headers.get('cache-control')).toBe('public, max-age=300');
  });

  test.each([
    '/assets/missing.js',
    '/missing.css',
    '/package.json',
    '/server/db.ts',
    '/%2e%2e/package.json',
    '/..%2f..%2fpackage.json',
    '/data/../../package.json',
    '/index.html%00.txt',
  ])('%s is a 404, never the SPA shell or a file outside dist', async path => {
    const { handle } = makeApp();
    const res = await handle(new Request(`http://radar.test${path}`));
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('radar');
  });
});

describe('API routing', () => {
  test('routes every API path to the worker fetch handler with method, query and headers', async () => {
    const { handle, calls } = makeApp();
    for (const path of API_PATHS) {
      const res = await handle(new Request(`http://radar.test${path}?limit=7`, { headers: { 'If-None-Match': '"v1"' } }));
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      expect(await res.json()).toEqual({ path, limit: '7' });
    }
    expect(calls).toEqual(
      [...API_PATHS].map(path => ({ method: 'GET', path, etag: '"v1"' })),
    );

    const head = await handle(new Request('http://radar.test/feed.json', { method: 'HEAD' }));
    expect(head.status).toBe(200);
    expect(head.headers.get('etag')).toBe('"v1"');
    expect(await head.text()).toBe('');
    expect(calls.at(-1)?.method).toBe('HEAD');

    await handle(new Request('http://radar.test/feed.json', { method: 'POST' }));
    await handle(new Request('http://radar.test/anything', { method: 'OPTIONS' }));
    expect(calls.slice(-2).map(c => c.method)).toEqual(['POST', 'OPTIONS']);
  });

  test('answers 500 with JSON when the worker fetch handler throws', async () => {
    const { handle } = makeApp({
      api: async () => {
        throw new Error('D1 is down');
      },
    });
    const res = await handle(new Request('http://radar.test/markets.json'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal error' });
  });
});

describe('/health', () => {
  test('reports ok, snapshots, uptime and scheduler status', async () => {
    const { db, handle, advance } = makeApp();
    const cold = await healthOf(await handle(new Request('http://radar.test/health')));
    expect(cold).toMatchObject({ ok: false, snapshots: {}, uptimeSec: 0, ready: false, scheduler: { running: false } });
    expect(cold.scheduler.jobs.heavy.everyMs).toBe(60_000);

    await upsertSnapshot(db.d1, 'markets:defi', { rows: [] }, T0);
    advance(65_000);
    const warm = await healthOf(await handle(new Request('http://radar.test/health')));
    expect(warm.ok).toBe(true);
    expect(Object.keys(warm.snapshots)).toEqual(['markets:defi']);
    expect(warm.uptimeSec).toBe(65);
    expect(warm.scheduler.jobs.heavy).toMatchObject({ runs: 0 });
  });

  test('is ready once the heavy ingest job has finished in this process', async () => {
    const { handle, scheduler } = makeApp();
    await scheduler.run(JOB.heavy);
    const health = await healthOf(await handle(new Request('http://radar.test/health')));
    expect(health).toMatchObject({ ready: true, scheduler: { jobs: { heavy: { runs: 1, lastError: null } } } });
  });

  test('HEAD returns headers only', async () => {
    const { handle } = makeApp();
    const res = await handle(new Request('http://radar.test/health', { method: 'HEAD' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe('');
  });
});

describe('buildEnv', () => {
  test('copies the documented keys (trimmed) next to the database binding', () => {
    const { db } = makeApp();
    const env = buildEnv(db.d1, {
      DB: 'ignored',
      TG_BATCH_SIZE: ' 8 ',
      X_RSS_MIRROR_BASE: 'http://rsshub:1200/twitter/user',
      LLM_BASE_URL: '',
      LLM_API_KEY: ' secret ',
      LLM_MODEL: 'glm-4.6',
      PORT: '3000',
      PATH: '/usr/bin',
    });
    expect(env).toEqual({
      DB: db.d1,
      TG_BATCH_SIZE: '8',
      X_RSS_MIRROR_BASE: 'http://rsshub:1200/twitter/user',
      LLM_API_KEY: 'secret',
      LLM_MODEL: 'glm-4.6',
    });
    db.close();
  });
});

describe('startServer', () => {
  test('serves the real worker API, then shuts down cleanly', async () => {
    const app = await startServer({ dbPath: ':memory:', hostname: '127.0.0.1', port: 0, warmup: [], distDir });
    const base = `http://127.0.0.1:${app.server.port}`;
    try {
      const shell = await fetch(base, { method: 'HEAD' });
      expect(shell.status).toBe(200);
      expect(shell.headers.get('content-type')).toContain('text/html');
      expect(await shell.text()).toBe('');
      expect(await (await fetch(`${base}/assets/app.abc123.js`)).text()).toBe('console.log(1)');

      const cold = await fetch(`${base}/markets.json`);
      expect(cold.status).toBe(503);
      expect(await cold.json()).toEqual({ error: 'Snapshot not ready yet' });

      const section = { id: 'defi', title: 'DeFi TVL', blurb: '', cols: [], rows: [], source: 'DefiLlama', sourceUrl: 'https://defillama.com', fetchedAt: T0, stale: false };
      await upsertSnapshot(app.db.d1, 'markets:defi', section, T0);
      const live = await fetch(`${base}/markets.json`);
      expect(live.status).toBe(200);
      const etag = live.headers.get('etag');
      expect(etag).toMatch(/^"[0-9a-f]{40}"$/);
      const markets = (await live.json()) as { sections: { id: string }[] };
      expect(markets.sections.map(s => s.id)).toEqual(['defi']);
      const revalidated = await fetch(`${base}/markets.json`, { headers: { 'If-None-Match': etag! } });
      expect(revalidated.status).toBe(304);

      const head = await fetch(`${base}/feed.json`, { method: 'HEAD' });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe('');
      const feed = await fetch(`${base}/feed.json?limit=5`);
      expect(feed.status).toBe(200);
      expect(await feed.json()).toMatchObject({ items: [] });

      const health = await healthOf(await fetch(`${base}/health`));
      expect(health).toMatchObject({ ok: true, ready: false });
      expect(health.uptimeSec).toBeGreaterThanOrEqual(0);
      expect(Object.keys(health.scheduler.jobs)).toEqual(['tick2m', 'tick5m', 'heavy', 'enrich']);
    } finally {
      await app.stop();
    }
    await expect(fetch(`${base}/health`)).rejects.toThrow();
    expect(() => app.db.sqlite.query('SELECT 1').get()).toThrow();
    expect(app.scheduler.status().running).toBe(false);
  });

  test('ignores a foreign DB passed via opts.env and keeps API, health, and scheduler on the server DB', async () => {
    const foreign = openDb(':memory:');
    await upsertSnapshot(foreign.d1, 'markets:defi', { id: 'defi', title: 'Foreign', blurb: '', cols: [], rows: [], source: 'DefiLlama', sourceUrl: 'https://defillama.com', fetchedAt: T0, stale: false }, T0);
    const app = await startServer({
      dbPath: ':memory:',
      hostname: '127.0.0.1',
      port: 0,
      warmup: [],
      distDir,
      env: { DB: foreign.d1, TG_BATCH_SIZE: '0' } as unknown as NonNullable<Parameters<typeof startServer>[0]>['env'],
    });
    const base = `http://127.0.0.1:${app.server.port}`;
    try {
      const markets = await fetch(`${base}/markets.json`);
      expect(markets.status).toBe(503);
    } finally {
      await app.stop();
      foreign.close();
    }
  });

  test('propagates cancellation on stop() and does not close SQLite while a job is still in flight', async () => {
    let sawAbort = false;
    let releaseStuck!: () => void;
    const stuckDone = new Promise<void>(resolve => {
      releaseStuck = resolve;
    });
    const stuckScheduler = createScheduler(
      [
        {
          name: JOB.heavy,
          everyMs: 60_000,
          run: async (_nowMs, signal) => {
            signal.addEventListener('abort', () => {
              sawAbort = true;
            });
            await stuckDone;
          },
        },
      ],
      { stopTimeoutMs: 15 },
    );
    const app = await startServer({
      dbPath: ':memory:',
      hostname: '127.0.0.1',
      port: 0,
      warmup: [JOB.heavy],
      distDir,
      scheduler: stuckScheduler,
    });
    await expect(app.stop()).rejects.toThrow(/in flight/i);
    expect(sawAbort).toBe(true);
    // SQLite stays usable while the stuck job has not settled.
    expect(app.db.sqlite.query('SELECT 1 AS n').get()).toEqual({ n: 1 });
    releaseStuck();
    await stuckScheduler.whenIdle();
    // Wait one microtask for deferred db.close() in finally().
    await sleep(10);
    expect(() => app.db.sqlite.query('SELECT 1').get()).toThrow();
  });
});
