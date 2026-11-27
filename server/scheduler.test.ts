import { describe, expect, test } from 'bun:test';
import type { AirdropFeed } from '../shared/types';
import { upsertSnapshot } from '../worker/src/lib/db';
import { extractDefiLlamaTokenlessAirdrops } from '../worker/src/sources/curated';
import { openDb } from './db';
import {
  CRON_FIVE_MIN,
  CRON_TWO_MIN,
  DEFILLAMA_PROTOCOLS_URL,
  DEFILLAMA_YIELDS_URL,
  JOB,
  WARMUP_JOBS,
  createRadarScheduler,
  createScheduler,
  runHeavyIngest,
  type SchedulerJob,
} from './scheduler';

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const PROTOCOLS = [
  { name: 'Zap', slug: 'zap', url: 'https://app.zap.example', logo: 'https://icons.llama.fi/zap.png', tvl: 500_000_000, category: 'Dexes', symbol: 'ZAP' },
  { name: 'Tokenless', slug: 'tokenless', url: 'https://tokenless.example', tvl: 40_000_000, category: 'Lending', symbol: '-', listedAt: NOW / 1000 },
  { name: 'Tiny', slug: 'tiny', url: 'https://tiny.example', tvl: 10, category: 'Lending', symbol: '-' },
];
const POOLS = {
  status: true,
  data: [
    { pool: 'p1', symbol: 'USDC', project: 'Zap', chain: 'Ethereum', tvlUsd: 500_000_000, apy: 3.2, ilRisk: 'no' },
    { pool: 'p2', symbol: 'WETH', project: 'Tiny', chain: 'Ethereum', tvlUsd: 500, apy: 1, ilRisk: 'yes' },
  ],
};

function payloadJson(url: string): Promise<unknown> {
  if (url === DEFILLAMA_PROTOCOLS_URL) return Promise.resolve(PROTOCOLS);
  if (url === DEFILLAMA_YIELDS_URL) return Promise.resolve(POOLS);
  return Promise.reject(new Error(`unexpected url ${url}`));
}

const sheetFeed = (): AirdropFeed => extractDefiLlamaTokenlessAirdrops(PROTOCOLS, NOW);
const emptyFeed = (): AirdropFeed => ({ cards: [], tge: [], counts: { active: 0, preToken: 0 }, fetchedAt: NOW });

describe('createScheduler', () => {
  function counters() {
    const state = { runs: 0, running: 0, maxRunning: 0 };
    return {
      state,
      job: (name: string, everyMs: number, ms = 0): SchedulerJob => ({
        name,
        everyMs,
        run: async () => {
          state.runs++;
          state.running++;
          state.maxRunning = Math.max(state.maxRunning, state.running);
          await sleep(ms);
          state.running--;
        },
      }),
    };
  }

  test('run() executes a job once and refuses unknown names', async () => {
    const seen: number[] = [];
    const scheduler = createScheduler([
      { name: 'once', everyMs: MINUTE, run: async nowMs => void seen.push(nowMs) },
    ]);
    expect(await scheduler.run('nope')).toBe(false);
    expect(await scheduler.run('once')).toBe(true);
    expect(await scheduler.run('once')).toBe(true);
    expect(seen).toHaveLength(2);
    expect(scheduler.status().jobs.once).toMatchObject({ everyMs: MINUTE, runs: 2, errors: 0, inFlight: false, lastError: null });
  });

  test('a job that is still running is not started again', async () => {
    const c = counters();
    const scheduler = createScheduler([c.job('slow', MINUTE, 30)]);
    const first = scheduler.run('slow');
    const skipped = scheduler.run('slow');
    expect(await skipped).toBe(false);
    expect(await first).toBe(true);
    expect(c.state).toMatchObject({ runs: 1, maxRunning: 1, running: 0 });
    expect(await scheduler.run('slow')).toBe(true);
    expect(c.state.runs).toBe(2);
  });

  test('start() runs each job on its interval without overlap, with the schedule stamped by now()', async () => {
    const c = counters();
    const scheduler = createScheduler([c.job('tick', 10, 35)], { now: () => NOW });
    scheduler.start();
    await sleep(220);
    expect(scheduler.status()).toMatchObject({ running: true, startedAt: NOW });
    await scheduler.stop();
    const { runs, maxRunning } = c.state;
    // A tick is skipped while the previous 35 ms run is still going, so runs stay
    // far below the 22 ticks the interval fires in that window.
    expect(runs).toBeGreaterThanOrEqual(3);
    expect(runs).toBeLessThanOrEqual(8);
    expect(maxRunning).toBe(1);
    expect(scheduler.status().jobs.tick).toMatchObject({ inFlight: false, lastStartedAt: NOW, lastDurationMs: 0 });
  });

  test('start(warmup) runs the named jobs sequentially in the given order', async () => {
    const events: string[] = [];
    const scheduler = createScheduler(
      ['a', 'b', 'c'].map(name => ({
        name,
        everyMs: MINUTE,
        run: async () => {
          events.push(`start:${name}`);
          await sleep(15);
          events.push(`end:${name}`);
        },
      })),
    );
    scheduler.start(['c', 'a', 'missing']);
    await sleep(60);
    expect(events).toEqual(['start:c', 'end:c', 'start:a', 'end:a']);
    await scheduler.stop();
  });

  test('stop() cancels the timers and waits for the job in flight', async () => {
    const c = counters();
    const scheduler = createScheduler([c.job('j', 5, 40)]);
    scheduler.start(['j']);
    let stopped = false;
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });
    await sleep(15);
    expect(stopped).toBe(false);
    await stopping;
    expect(c.state).toMatchObject({ runs: 1, running: 0 });
    expect(scheduler.status().running).toBe(false);
    await sleep(40);
    expect(c.state.runs).toBe(1);
  });

  test('stop() stops waiting after stopTimeoutMs so shutdown cannot hang', async () => {
    const scheduler = createScheduler([{ name: 'stuck', everyMs: MINUTE, run: () => new Promise(() => {}) }], {
      stopTimeoutMs: 15,
    });
    scheduler.start(['stuck']);
    const t0 = Date.now();
    await scheduler.stop();
    expect(Date.now() - t0).toBeLessThan(500);
    expect(scheduler.status().jobs.stuck).toMatchObject({ inFlight: true, runs: 1 });
  });

  test('a failing job is logged and counted, and never stops the schedule', async () => {
    const logs: string[] = [];
    let good = 0;
    const scheduler = createScheduler(
      [
        { name: 'bad', everyMs: 10, run: async () => { throw new Error('boom'); } },
        { name: 'good', everyMs: 10, run: async () => void good++ },
      ],
      { log: line => logs.push(line) },
    );
    scheduler.start();
    await sleep(120);
    await scheduler.stop();
    const bad = scheduler.status().jobs.bad!;
    expect(bad.errors).toBe(bad.runs);
    expect(bad.runs).toBeGreaterThan(1);
    expect(bad.lastError).toBe('boom');
    expect(good).toBeGreaterThan(0);
    expect(logs.filter(l => l === 'scheduler-error:bad boom')).toHaveLength(bad.errors);
    expect(await scheduler.run('bad')).toBe(true);
  });
});

describe('runHeavyIngest', () => {
  const sheets = { fetchAsso7878: async () => sheetFeed(), fetchArndxt: async () => sheetFeed() };

  test('writes defi, yields, tokenless and sheet snapshots and seeds Layer 1 domains', async () => {
    const db = openDb(':memory:');
    const result = await runHeavyIngest(db.d1, {}, { ...sheets, fetchJson: payloadJson, nowMs: NOW });
    expect(result).toEqual({
      ok: ['markets:defi', 'airdrops:defillama', 'markets:yields', 'airdrops:asso7878', 'airdrops:arndxt'],
      failed: [],
      seededDomains: 3,
    });
    const snapshots = db.sqlite.query('SELECT key, ok, error FROM snapshots ORDER BY key').all();
    expect(snapshots).toEqual(
      ['airdrops:arndxt', 'airdrops:asso7878', 'airdrops:defillama', 'markets:defi', 'markets:yields'].map(key => ({
        key,
        ok: 1,
        error: null,
      })),
    );
    const body = (key: string) =>
      JSON.parse((db.sqlite.query('SELECT body FROM snapshots WHERE key = ?1').get(key) as { body: string }).body) as {
      rows: { id: string }[];
      cards: { n: string }[];
    };
    expect(body('markets:defi').rows.map((r: { id: string }) => r.id)).toEqual(['zap', 'tokenless', 'tiny']);
    expect(body('markets:yields').rows).toHaveLength(1);
    expect(body('airdrops:defillama').cards.map((c: { n: string }) => c.n)).toEqual(['Tokenless']);
    expect(db.sqlite.query('SELECT domain, tvl_usd FROM domain_meta ORDER BY domain').all()).toEqual([
      { domain: 'tiny.example', tvl_usd: 10 },
      { domain: 'tokenless.example', tvl_usd: 40_000_000 },
      { domain: 'zap.example', tvl_usd: 500_000_000 },
    ]);
    db.close();
  });

  test('a failing section records its error and keeps the last good body; sheets are optional', async () => {
    const db = openDb(':memory:');
    await upsertSnapshot(db.d1, 'markets:yields', { previous: true }, NOW - 1000);
    const result = await runHeavyIngest(db.d1, {}, {
      fetchJson: async url => {
        if (url === DEFILLAMA_YIELDS_URL) throw new Error('HTTP 503');
        return PROTOCOLS;
      },
      fetchAsso7878: async () => {
        throw new Error('sheet down');
      },
      fetchArndxt: async () => emptyFeed(),
      nowMs: NOW,
      log: () => {},
    });
    expect(result).toEqual({ ok: ['markets:defi', 'airdrops:defillama'], failed: [{ key: 'markets:yields', error: 'HTTP 503' }], seededDomains: 3 });
    expect(db.sqlite.query("SELECT body, ok, error FROM snapshots WHERE key = 'markets:yields'").get()).toEqual({
      body: JSON.stringify({ previous: true }),
      ok: 0,
      error: 'HTTP 503',
    });
    expect(db.sqlite.query("SELECT count(*) AS n FROM snapshots WHERE key LIKE 'airdrops:%'").get()).toEqual({ n: 1 });
    db.close();
  });

  test('an empty section is refused instead of overwriting a good snapshot', async () => {
    const db = openDb(':memory:');
    await upsertSnapshot(db.d1, 'markets:defi', { previous: true }, NOW - 1000);
    const result = await runHeavyIngest(db.d1, {}, {
      ...sheets,
      fetchJson: async url => (url === DEFILLAMA_PROTOCOLS_URL ? [] : POOLS),
      nowMs: NOW,
      log: () => {},
    });
    expect(result.failed).toEqual([{ key: 'markets:defi', error: 'Empty DeFi section (0 rows)' }]);
    expect(db.sqlite.query("SELECT body, ok FROM snapshots WHERE key = 'markets:defi'").get()).toEqual({
      body: JSON.stringify({ previous: true }),
      ok: 0,
    });
    expect(result.seededDomains).toBe(0);
    db.close();
  });

  test('stores bodies larger than the 100KB D1 statement limit', async () => {
    const db = openDb(':memory:');
    const big = Array.from({ length: 50 }, (_, i) => ({
      name: `${'P'.repeat(10_000)}${i}`,
      slug: `p${i}`,
      url: `https://p${i}.example`,
      tvl: 1_000_000_000 - i,
      category: 'Dexes',
      symbol: 'X',
    }));
    const result = await runHeavyIngest(db.d1, {}, {
      ...sheets,
      fetchJson: async url => (url === DEFILLAMA_PROTOCOLS_URL ? big : POOLS),
      nowMs: NOW,
      log: () => {},
    });
    expect(result.failed).toEqual([]);
    const { len } = db.sqlite
      .query("SELECT length(body) AS len FROM snapshots WHERE key = 'markets:defi'")
      .get() as { len: number };
    expect(len).toBeGreaterThan(1_000_000);
    db.close();
  });
});

describe('createRadarScheduler', () => {
  test('runs the worker crons under their Cloudflare cron strings', async () => {
    const db = openDb(':memory:');
    const calls: [string, number][] = [];
    const scheduler = createRadarScheduler(db.d1, {}, {
      scheduled: async (cron, nowMs) => void calls.push([cron, nowMs]),
      heavyIngest: async () => {},
      enrich: async () => {},
      now: () => NOW,
      log: () => {},
    });
    expect(await scheduler.run(JOB.twoMin)).toBe(true);
    expect(await scheduler.run(JOB.fiveMin)).toBe(true);
    expect(calls).toEqual([
      [CRON_TWO_MIN, NOW],
      [CRON_FIVE_MIN, NOW],
    ]);
    db.close();
  });

  test('schedules 2 and 5 minute ticks, a 30 minute heavy ingest and a 60 minute enricher', () => {
    const db = openDb(':memory:');
    const scheduler = createRadarScheduler(db.d1, {}, { log: () => {} });
    const everyMs = Object.fromEntries(Object.entries(scheduler.status().jobs).map(([name, job]) => [name, job.everyMs]));
    expect(everyMs).toEqual({ [JOB.twoMin]: 2 * MINUTE, [JOB.fiveMin]: 5 * MINUTE, [JOB.heavy]: 30 * MINUTE, [JOB.enrich]: 60 * MINUTE });
    expect(WARMUP_JOBS).toEqual(['heavy', 'tick5m', 'tick2m', 'enrich']);
    db.close();
  });

  test('the default enricher pass runs without network on an empty database', async () => {
    const db = openDb(':memory:');
    const scheduler = createRadarScheduler(db.d1, {}, { log: () => {} });
    expect(await scheduler.run(JOB.enrich)).toBe(true);
    expect(scheduler.status().jobs[JOB.enrich]).toMatchObject({ runs: 1, errors: 0 });
    db.close();
  });

  test('the real worker 2-minute cron runs on the SQLite adapter', async () => {
    const db = openDb(':memory:');
    const scheduler = createRadarScheduler(db.d1, { TG_BATCH_SIZE: '0' }, { log: () => {} });
    expect(await scheduler.run(JOB.twoMin)).toBe(true);
    expect(scheduler.status().jobs[JOB.twoMin]).toMatchObject({ errors: 0 });
    const sources = db.sqlite.query('SELECT count(*) AS n FROM sources').get();
    expect((sources as { n: number }).n).toBeGreaterThan(10);
    db.close();
  });
});
