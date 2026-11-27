import type { AirdropFeed, DomainMeta, MarketSection } from '../shared/types';
import workerApp, { type Env } from '../worker/src/index';
import { markSnapshotError, upsertSnapshot } from '../worker/src/lib/db';
import { FETCH_TIMEOUT_MS, USER_AGENT } from '../worker/src/lib/format';
import { extractDefiLlamaTokenlessAirdrops } from '../worker/src/sources/curated';
import { normalizeDefiProtocols, normalizeDefiYields } from '../worker/src/sources/markets';
import { resolveCuratedSourceUrl } from '../worker/src/sources/registry';
import { ARNDXT_SHEET_URL, ASSO7878_SHEET_URL, fetchArndxtSheet, fetchAsso7878Sheet } from '../worker/src/sources/sheets';
import { enrichActiveClusters, enrichAirdropsSnapshot, seedDefiLlamaDomains, type EnrichOptions } from './enricher';

const MINUTE = 60_000;
const DEFAULT_STOP_TIMEOUT_MS = 8_000;

export const CRON_TWO_MIN = '*/2 * * * *';
export const CRON_FIVE_MIN = '*/5 * * * *';
export const ENRICH_LIMIT = 40;
export const ENRICH_CARDS_LIMIT = 45;
export const DEFILLAMA_PROTOCOLS_URL = 'https://api.llama.fi/protocols';
export const DEFILLAMA_YIELDS_URL = 'https://yields.llama.fi/pools';

export const JOB = { twoMin: 'tick2m', fiveMin: 'tick5m', heavy: 'heavy', enrich: 'enrich' } as const;
/** Boot warmup order: heavy (DefiLlama/sheets) -> 5m (airdrops/domains/X/feeds) -> 2m (TG/AI) -> enrich. */
export const WARMUP_JOBS: readonly string[] = [JOB.heavy, JOB.fiveMin, JOB.twoMin, JOB.enrich];

export interface SchedulerJob {
  name: string;
  everyMs: number;
  run: (nowMs: number, signal: AbortSignal) => Promise<unknown> | unknown;
}

export interface JobStatus {
  everyMs: number;
  inFlight: boolean;
  runs: number;
  errors: number;
  lastStartedAt: number | null;
  lastFinishedAt: number | null;
  lastDurationMs: number | null;
  lastError: string | null;
}

export interface SchedulerStatus {
  running: boolean;
  startedAt: number | null;
  jobs: Record<string, JobStatus>;
}

export interface Scheduler {
  /** Runs one job now; false when the name is unknown or that job is already running. */
  run(name: string): Promise<boolean>;
  /** Starts every job on its interval and runs `warmup` jobs once, without waiting for them. */
  start(warmup?: readonly string[]): void;
  /** Cancels timers, signals running jobs to abort, and waits (at most `stopTimeoutMs`) for them. */
  stop(): Promise<void>;
  /** Resolves once every currently in-flight job has settled (never times out). */
  whenIdle(): Promise<void>;
  status(): SchedulerStatus;
}

export interface SchedulerOptions {
  log?: (message: string) => void;
  now?: () => number;
  stopTimeoutMs?: number;
  setIntervalFn?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (timer: ReturnType<typeof setInterval>) => void;
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 400);
}

/** In-process scheduler: one interval per job, a per-job lock so a slow run is never overlapped. */
export function createScheduler(jobs: SchedulerJob[], opts: SchedulerOptions = {}): Scheduler {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (message => console.error(message));
  const scheduleInterval = opts.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
  const cancelInterval = opts.clearIntervalFn ?? (timer => clearInterval(timer));
  const byName = new Map(jobs.map(job => [job.name, job]));
  const state = new Map<string, JobStatus>(
    jobs.map(job => [
      job.name,
      { everyMs: job.everyMs, inFlight: false, runs: 0, errors: 0, lastStartedAt: null, lastFinishedAt: null, lastDurationMs: null, lastError: null },
    ]),
  );
  const timers: ReturnType<typeof setInterval>[] = [];
  const inFlight = new Map<string, Promise<void>>();
  let startedAt: number | null = null;
  let stopController = new AbortController();

  async function execute(job: SchedulerJob, signal: AbortSignal): Promise<void> {
    const status = state.get(job.name)!;
    const started = now();
    status.inFlight = true;
    status.runs++;
    status.lastStartedAt = started;
    try {
      await job.run(started, signal);
      status.lastError = null;
    } catch (err) {
      status.errors++;
      status.lastError = errorText(err);
      log(`scheduler-error:${job.name} ${status.lastError}`);
    } finally {
      status.inFlight = false;
      status.lastFinishedAt = now();
      status.lastDurationMs = status.lastFinishedAt - started;
    }
  }

  function run(name: string): Promise<boolean> {
    const job = byName.get(name);
    if (!job || inFlight.has(name)) return Promise.resolve(false);
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    // Reserve the slot before execute() synchronously invokes job.run().
    inFlight.set(name, gate);
    const done = execute(job, stopController.signal).finally(() => {
      inFlight.delete(name);
      release();
    });
    return done.then(() => true);
  }

  function start(warmup: readonly string[] = []): void {
    if (startedAt !== null) return;
    if (stopController.signal.aborted) stopController = new AbortController();
    startedAt = now();
    for (const job of jobs) {
      const timer = scheduleInterval(() => void run(job.name), job.everyMs);
      (timer as { unref?: () => void } | undefined)?.unref?.();
      timers.push(timer);
    }
    const queue = warmup.filter(name => byName.has(name));
    if (queue.length > 0) {
      let chain: Promise<unknown> = run(queue[0]!);
      for (let i = 1; i < queue.length; i++) {
        const name = queue[i]!;
        chain = chain.then(() => (startedAt === null ? undefined : run(name)));
      }
      void chain;
    }
  }

  async function whenIdle(): Promise<void> {
    while (inFlight.size > 0) {
      await Promise.all([...inFlight.values()]);
    }
  }

  async function stop(): Promise<void> {
    startedAt = null;
    for (const timer of timers) cancelInterval(timer);
    timers.length = 0;
    if (!stopController.signal.aborted) {
      stopController.abort(new Error('scheduler stopped'));
    }
    const pending = [...inFlight.values()];
    if (pending.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(pending),
        new Promise<void>(resolve => {
          timer = setTimeout(resolve, opts.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  function status(): SchedulerStatus {
    return {
      running: startedAt !== null,
      startedAt,
      jobs: Object.fromEntries([...state].map(([name, job]) => [name, { ...job }])),
    };
  }

  return { run, start, stop, whenIdle, status };
}

// ---------------------------------------------------------------------------
// Heavy ingest (replaces the ingest-heavy GitHub Actions cron)
// ---------------------------------------------------------------------------

export type HeavyEnv = Pick<Env, 'ASSO7878_SHEET_URL' | 'ARNDXT_SHEET_URL'>;

export interface HeavyIngestDeps {
  fetchJson?: (url: string, signal?: AbortSignal) => Promise<unknown>;
  fetchAsso7878?: (url: string, nowMs: number) => Promise<AirdropFeed>;
  fetchArndxt?: (url: string, nowMs: number) => Promise<AirdropFeed>;
  seedDomains?: (db: D1Database, protocolsRaw: unknown, nowMs: number) => Promise<number>;
  nowMs?: number;
  signal?: AbortSignal;
  log?: (message: string) => void;
}

export interface HeavyIngestResult {
  ok: string[];
  failed: { key: string; error: string }[];
  seededDomains: number;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('job aborted');
  }
}

async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS * 2);
  const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: combined,
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return res.json();
}

/**
 * Fetches DefiLlama protocols + yields and the ASSO7878 / arndxt sheets, writes the snapshots straight
 * into SQLite (no D1 statement size limit), and seeds `domain_meta` from the protocols payload.
 * Sheet failures are optional and only logged; a failed or empty DefiLlama section marks its snapshot
 * with the error and leaves the last good body in place.
 */
export async function runHeavyIngest(db: D1Database, env: HeavyEnv, deps: HeavyIngestDeps = {}): Promise<HeavyIngestResult> {
  const nowMs = deps.nowMs ?? Date.now();
  const signal = deps.signal;
  const log = deps.log ?? (message => console.log(message));
  const getJson = deps.fetchJson ?? fetchJson;
  const fetchAsso = deps.fetchAsso7878 ?? fetchAsso7878Sheet;
  const fetchArndxt = deps.fetchArndxt ?? fetchArndxtSheet;
  const seedDomains = deps.seedDomains ?? seedDefiLlamaDomains;
  throwIfAborted(signal);
  const [protocols, pools, asso, arndxt] = await Promise.allSettled([
    getJson(DEFILLAMA_PROTOCOLS_URL, signal),
    getJson(DEFILLAMA_YIELDS_URL, signal),
    fetchAsso(resolveCuratedSourceUrl(env.ASSO7878_SHEET_URL, 'sheet:asso7878_sheet', ASSO7878_SHEET_URL), nowMs),
    fetchArndxt(resolveCuratedSourceUrl(env.ARNDXT_SHEET_URL, 'sheet:arndxt_sheet', ARNDXT_SHEET_URL), nowMs),
  ]);
  throwIfAborted(signal);

  const result: HeavyIngestResult = { ok: [], failed: [], seededDomains: 0 };
  const section = async (
    key: string,
    label: string,
    outcome: PromiseSettledResult<unknown>,
    normalize: (raw: unknown, nowMs: number) => MarketSection,
  ): Promise<unknown | null> => {
    throwIfAborted(signal);
    try {
      if (outcome.status === 'rejected') throw outcome.reason;
      const normalized = normalize(outcome.value, nowMs);
      if (normalized.rows.length === 0) throw new Error(`Empty ${label} section (0 rows)`);
      await upsertSnapshot(db, key, normalized, nowMs);
      result.ok.push(key);
      return outcome.value;
    } catch (err) {
      throwIfAborted(signal);
      const error = errorText(err);
      result.failed.push({ key, error });
      await markSnapshotError(db, key, err, nowMs);
      return null;
    }
  };

  const rawProtocols = await section('markets:defi', 'DeFi', protocols, normalizeDefiProtocols);
  if (rawProtocols !== null) {
    throwIfAborted(signal);
    const tokenless = extractDefiLlamaTokenlessAirdrops(rawProtocols, nowMs);
    if (tokenless.cards.length > 0) {
      await upsertSnapshot(db, 'airdrops:defillama', tokenless, nowMs);
      result.ok.push('airdrops:defillama');
    }
    try {
      throwIfAborted(signal);
      result.seededDomains = await seedDomains(db, rawProtocols, nowMs);
    } catch (err) {
      throwIfAborted(signal);
      const error = errorText(err);
      result.failed.push({ key: 'domain_meta:defillama', error });
      log(`heavy-ingest: domain_meta seed failed: ${error}`);
    }
  }
  await section('markets:yields', 'Yields', pools, normalizeDefiYields);

  const sheets: [string, PromiseSettledResult<AirdropFeed>][] = [
    ['airdrops:asso7878', asso],
    ['airdrops:arndxt', arndxt],
  ];
  const validSheets: [string, AirdropFeed][] = [];
  for (const [key, outcome] of sheets) {
    if (outcome.status === 'rejected') {
      log(`heavy-ingest: optional ${key} failed: ${errorText(outcome.reason)}`);
      continue;
    }
    if (outcome.value.cards.length === 0 && outcome.value.tge.length === 0) continue;
    validSheets.push([key, outcome.value]);
  }
  throwIfAborted(signal);
  await Promise.all(validSheets.map(([key, feed]) => upsertSnapshot(db, key, feed, nowMs)));
  for (const [key] of validSheets) result.ok.push(key);
  return result;
}

// ---------------------------------------------------------------------------
// Web3 Radar jobs
// ---------------------------------------------------------------------------

export interface RadarDeps extends HeavyIngestDeps {
  /** Worker `scheduled` handler; the default calls `workerApp.scheduled` with the given cron string. */
  scheduled?: (cron: string, nowMs: number, signal: AbortSignal) => Promise<void>;
  heavyIngest?: (nowMs: number, signal: AbortSignal) => Promise<unknown>;
  enrich?: (nowMs: number, signal: AbortSignal) => Promise<unknown>;
  enrichClusters?: typeof enrichActiveClusters;
  enrichCards?: typeof enrichAirdropsSnapshot;
  enrichOpts?: EnrichOptions;
  now?: () => number;
  stopTimeoutMs?: number;
}

/** The four production jobs: 2 and 5 minute worker crons, 30 minute heavy ingest, 60 minute enricher. */
export function createRadarScheduler(db: D1Database, env: Omit<Env, 'DB'> = {}, deps: RadarDeps = {}): Scheduler {
  const log = deps.log ?? (message => console.log(message));
  // The scheduler's own database always backs the worker, whatever `env` carried.
  const workerEnv: Env = { ...env, DB: db };
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  const scheduled =
    deps.scheduled ??
    ((cron: string, nowMs: number) =>
      workerApp.scheduled({ cron, scheduledTime: nowMs } as ScheduledController, workerEnv, ctx));
  const heavyIngest =
    deps.heavyIngest ??
    (async (nowMs: number, signal: AbortSignal) => {
      const result = await runHeavyIngest(db, workerEnv, { ...deps, nowMs, signal });
      log(`heavy-ingest ok=${result.ok.length} failed=${result.failed.length} seededDomains=${result.seededDomains}`);
      if (result.failed.length > 0) {
        throw new Error(result.failed.map(f => `${f.key}: ${f.error}`).join('; '));
      }
    });
  const runClusterEnrich = deps.enrichClusters ?? enrichActiveClusters;
  const runCardEnrich = deps.enrichCards ?? enrichAirdropsSnapshot;
  const enrich =
    deps.enrich ??
    (async (nowMs: number, signal: AbortSignal) => {
      const inFlight = new Map<string, Promise<DomainMeta>>();
      const sharedOpts: EnrichOptions = { ...deps.enrichOpts, inFlight, signal };
      const [clustersOutcome, cardsOutcome] = await Promise.allSettled([
        runClusterEnrich(db, nowMs, ENRICH_LIMIT, sharedOpts),
        runCardEnrich(db, nowMs, ENRICH_CARDS_LIMIT, sharedOpts),
      ]);
      const errors: string[] = [];
      const clusters =
        clustersOutcome.status === 'fulfilled'
          ? clustersOutcome.value
          : (errors.push(`clusters: ${errorText(clustersOutcome.reason)}`), null);
      const cards =
        cardsOutcome.status === 'fulfilled'
          ? cardsOutcome.value
          : (errors.push(`cards: ${errorText(cardsOutcome.reason)}`), null);
      if (clusters && cards) {
        log(
          `enrich clusters=${clusters.selected} clusterErrors=${clusters.errors} cardsEnriched=${cards.enriched} cardsFetched=${cards.fetched}`,
        );
      }
      if (errors.length > 0) {
        throw new Error(errors.join('; '));
      }
    });

  return createScheduler(
    [
      { name: JOB.twoMin, everyMs: 2 * MINUTE, run: (nowMs, signal) => scheduled(CRON_TWO_MIN, nowMs, signal) },
      { name: JOB.fiveMin, everyMs: 5 * MINUTE, run: (nowMs, signal) => scheduled(CRON_FIVE_MIN, nowMs, signal) },
      { name: JOB.heavy, everyMs: 30 * MINUTE, run: heavyIngest },
      { name: JOB.enrich, everyMs: 60 * MINUTE, run: enrich },
    ],
    { log, now: deps.now, stopTimeoutMs: deps.stopTimeoutMs },
  );
}
