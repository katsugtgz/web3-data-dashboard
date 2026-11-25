import { rmSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AirdropFeed, MarketSection } from '../shared/types';
import { FETCH_TIMEOUT_MS, USER_AGENT } from '../worker/src/lib/format';
import { sha1Hex } from '../worker/src/lib/hash';
import { extractDefiLlamaTokenlessAirdrops } from '../worker/src/sources/curated';
import { normalizeDefiProtocols, normalizeDefiYields } from '../worker/src/sources/markets';
import { resolveCuratedSourceUrl } from '../worker/src/sources/registry';
import {
  ARNDXT_SHEET_URL,
  ASSO7878_SHEET_URL,
  fetchArndxtSheet,
  fetchAsso7878Sheet,
} from '../worker/src/sources/sheets';

export const DEFILLAMA_PROTOCOLS_URL = 'https://api.llama.fi/protocols';
export const DEFILLAMA_YIELDS_URL = 'https://yields.llama.fi/pools';

export interface HeavyIngestDeps {
  fetchJson?: (url: string) => Promise<unknown>;
  fetchAsso7878?: (url: string, nowMs: number) => Promise<AirdropFeed>;
  fetchArndxt?: (url: string, nowMs: number) => Promise<AirdropFeed>;
  includeSheets?: boolean;
  executeSqlFile?: (sqlPath: string) => Promise<void>;
  nowMs?: number;
  dryRun?: boolean;
  log?: (msg: string) => void;
}

export interface HeavyIngestResult {
  statements: string[];
  okKeys: string[];
  failedKeys: { key: string; error: string }[];
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS * 2),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function defaultExecuteSqlFile(sqlPath: string): Promise<void> {
  await Bun.$`npx wrangler d1 execute DB --remote --file ${sqlPath}`.cwd('worker');
}

function sqlQuote(str: string): string {
  return `'${str.replace(/\0/g, '').replace(/'/g, "''")}'`;
}

function formatErrorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 400);
}

function buildErrorTelemetrySql(key: string, errMsg: string, nowMs: number): string {
  const safeNowMs = Number.isFinite(nowMs) ? Math.trunc(nowMs) : 0;
  return `INSERT INTO snapshots (key, body, etag, fetched_at, ok, error) VALUES (${sqlQuote(key)}, '{}', '"empty"', 0, 0, ${sqlQuote(errMsg)})
ON CONFLICT(key) DO UPDATE SET
  ok = 0,
  error = excluded.error
WHERE ${safeNowMs} >= snapshots.fetched_at;`;
}

async function buildSuccessSql(key: string, section: unknown, nowMs: number): Promise<string> {
  const body = JSON.stringify(section);
  const etag = `"${await sha1Hex(body)}"`;
  // Same fetched_at guard as the Worker's upsertSnapshot (worker/src/lib/db.ts):
  // completion order != schedule order, so a delayed overlapping heavy run must
  // never regress a newer snapshot. `fetched_at` is fixed per run, so older run
  // loses, newer wins.
  return `INSERT INTO snapshots (key, body, etag, fetched_at, ok, error) VALUES (${sqlQuote(key)}, ${sqlQuote(body)}, ${sqlQuote(etag)}, ${nowMs}, 1, NULL)
ON CONFLICT(key) DO UPDATE SET
  body = excluded.body,
  etag = excluded.etag,
  fetched_at = excluded.fetched_at,
  ok = 1,
  error = NULL
WHERE excluded.fetched_at >= snapshots.fetched_at;`;
}

type SectionSpec = {
  key: 'markets:defi' | 'markets:yields';
  label: string;
  url: string;
  normalize: (raw: unknown, nowMs: number) => MarketSection;
};

const SECTION_SPECS: readonly SectionSpec[] = [
  {
    key: 'markets:defi',
    label: 'DeFi',
    url: DEFILLAMA_PROTOCOLS_URL,
    normalize: normalizeDefiProtocols,
  },
  {
    key: 'markets:yields',
    label: 'Yields',
    url: DEFILLAMA_YIELDS_URL,
    normalize: normalizeDefiYields,
  },
];

export async function runHeavyIngest(deps: HeavyIngestDeps = {}): Promise<HeavyIngestResult> {
  const fetchJson = deps.fetchJson ?? defaultFetchJson;
  const executeSqlFile = deps.executeSqlFile ?? defaultExecuteSqlFile;
  const nowMs = deps.nowMs ?? Date.now();
  const dryRun = deps.dryRun ?? process.argv.includes('--dry-run');
  const log = deps.log ?? ((msg: string) => console.log(msg));
  const includeSheets =
    deps.includeSheets ?? (deps.fetchJson === undefined || deps.fetchAsso7878 !== undefined || deps.fetchArndxt !== undefined);

  const assoSheetUrl = resolveCuratedSourceUrl(
    process.env.ASSO7878_SHEET_URL,
    'sheet:asso7878_sheet',
    ASSO7878_SHEET_URL,
  );
  const arndxtSheetUrl = resolveCuratedSourceUrl(
    process.env.ARNDXT_SHEET_URL,
    'sheet:arndxt_sheet',
    ARNDXT_SHEET_URL,
  );
  const fetchAsso = deps.fetchAsso7878 ?? fetchAsso7878Sheet;
  const fetchArndxt = deps.fetchArndxt ?? fetchArndxtSheet;

  // Fetch heavy DefiLlama payloads and optional Google Sheets concurrently
  // outside the Worker's 10 ms free-tier CPU budget; sheet failures are
  // non-fatal so DefiLlama snapshots still refresh.
  const [settled, asso7878Feed, arndxtFeed] = await Promise.all([
    Promise.allSettled(
      SECTION_SPECS.map(async spec => {
        const raw = await fetchJson(spec.url);
        const section = spec.normalize(raw, nowMs);
        if (section.rows.length === 0) {
          throw new Error(`Empty ${spec.label} section (0 rows) — refusing to overwrite D1 snapshot`);
        }
        return { raw, section };
      }),
    ),
    includeSheets
      ? fetchAsso(assoSheetUrl, nowMs).catch(err => {
          console.warn('Optional ASSO7878 sheet fetch failed (continuing with other snapshots):', err);
          return null;
        })
      : Promise.resolve(null),
    includeSheets
      ? fetchArndxt(arndxtSheetUrl, nowMs).catch(err => {
          console.warn('Optional arndxt sheet fetch failed (continuing with other snapshots):', err);
          return null;
        })
      : Promise.resolve(null),
  ]);

  const statements: string[] = [];
  const okKeys: string[] = [];
  const failedKeys: { key: string; error: string }[] = [];
  const summaryParts: string[] = [];

  for (let i = 0; i < SECTION_SPECS.length; i++) {
    const spec = SECTION_SPECS[i];
    const outcome = settled[i];
    if (outcome.status === 'fulfilled') {
      statements.push(await buildSuccessSql(spec.key, outcome.value.section, nowMs));
      okKeys.push(spec.key);
      summaryParts.push(`${spec.label}: ${outcome.value.section.rows.length} rows`);
      if (spec.key === 'markets:defi') {
        // Zero extra requests: reuse protocolsRaw to extract tokenless protocols (symbol === "-", TVL >= $5M).
        const defiLlamaAirdrops = extractDefiLlamaTokenlessAirdrops(outcome.value.raw, nowMs);
        if (defiLlamaAirdrops.cards.length > 0) {
          statements.push(await buildSuccessSql('airdrops:defillama', defiLlamaAirdrops, nowMs));
          okKeys.push('airdrops:defillama');
          summaryParts.push(`Tokenless Airdrops: ${defiLlamaAirdrops.cards.length} cards`);
        }
      }
    } else {
      const errMsg = formatErrorMessage(outcome.reason);
      statements.push(buildErrorTelemetrySql(spec.key, errMsg, nowMs));
      failedKeys.push({ key: spec.key, error: errMsg });
      summaryParts.push(`${spec.label}: FAILED (${errMsg})`);
    }
  }

  if (asso7878Feed && (asso7878Feed.cards.length > 0 || asso7878Feed.tge.length > 0)) {
    statements.push(await buildSuccessSql('airdrops:asso7878', asso7878Feed, nowMs));
    okKeys.push('airdrops:asso7878');
    summaryParts.push(`ASSO7878: ${asso7878Feed.cards.length} cards/${asso7878Feed.tge.length} tge`);
  }
  if (arndxtFeed && (arndxtFeed.cards.length > 0 || arndxtFeed.tge.length > 0)) {
    statements.push(await buildSuccessSql('airdrops:arndxt', arndxtFeed, nowMs));
    okKeys.push('airdrops:arndxt');
    summaryParts.push(`arndxt: ${arndxtFeed.cards.length} cards/${arndxtFeed.tge.length} tge`);
  }
  // Note: Dune snapshot ingestion (worker/src/sources/dune.ts) is deferred until
  // a Worker/frontend response consumer reads the airdrops:dune snapshot body.

  log(`Heavy ingest summary — ${summaryParts.join(', ')}`);

  if (dryRun) {
    log(
      `Dry-run complete (skipping D1 remote write; would execute ${statements.length} statements: ok=[${okKeys.join(', ')}], failed=[${failedKeys.map(f => f.key).join(', ')}]).`,
    );
  } else {
    // known_domains is NOT touched here: without the surf input this loop
    // relabelled surf-owned domains (origin surf -> defi) every 30 minutes;
    // the Worker's 5-minute cron reseeds the table from both feeds.
    const tmpDir = await mkdtemp(join(tmpdir(), 'web3-radar-heavy-'));
    const sqlPath = join(tmpDir, 'ingest.sql');
    const cleanupSync = () => {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup on signal
      }
    };
    const onSigInt = () => {
      cleanupSync();
      process.exit(130);
    };
    const onSigTerm = () => {
      cleanupSync();
      process.exit(143);
    };
    process.once('SIGINT', onSigInt);
    process.once('SIGTERM', onSigTerm);

    try {
      await writeFile(sqlPath, statements.join('\n'), 'utf8');
      await executeSqlFile(sqlPath);
      log(`Updated snapshots in remote D1 (ok=${okKeys.length}, errorTelemetry=${failedKeys.length}).`);
    } finally {
      process.off('SIGINT', onSigInt);
      process.off('SIGTERM', onSigTerm);
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  if (failedKeys.length > 0) {
    const detail = failedKeys.map(f => `${f.key}: ${f.error}`).join('; ');
    throw new Error(`Heavy ingest failed for ${failedKeys.length}/${SECTION_SPECS.length} section(s): ${detail}`);
  }

  return { statements, okKeys, failedKeys };
}

if (import.meta.main) {
  await runHeavyIngest();
}
