import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FETCH_TIMEOUT_MS, USER_AGENT } from '../worker/src/lib/format';
import { sha1Hex } from '../worker/src/lib/hash';
import { extractDefiLlamaTokenlessAirdrops } from '../worker/src/sources/curated';
import { fetchDuneAirdrops } from '../worker/src/sources/dune';
import { normalizeDefiProtocols, normalizeDefiYields } from '../worker/src/sources/markets';
import { fetchArndxtSheet, fetchAsso7878Sheet } from '../worker/src/sources/sheets';

const dryRun = process.argv.includes('--dry-run');
const nowMs = Date.now();

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS * 2),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function sqlQuote(str: string): string {
  return `'${str.replace(/'/g, "''")}'`;
}

async function main() {
  // Fetch heavy DefiLlama payloads and Google Sheets concurrently outside the
  // Worker's 10 ms free-tier CPU budget; sheet failures are non-fatal so
  // DefiLlama snapshots still refresh.
  const [protocolsRaw, yieldsRaw, asso7878Feed, arndxtFeed] = await Promise.all([
    fetchJson('https://api.llama.fi/protocols'),
    fetchJson('https://yields.llama.fi/pools'),
    fetchAsso7878Sheet(undefined, nowMs).catch(err => {
      console.warn('Optional ASSO7878 sheet fetch failed (continuing with other snapshots):', err);
      return null;
    }),
    fetchArndxtSheet(undefined, nowMs).catch(err => {
      console.warn('Optional arndxt sheet fetch failed (continuing with other snapshots):', err);
      return null;
    }),
  ]);

  const defi = normalizeDefiProtocols(protocolsRaw, nowMs);
  const yields = normalizeDefiYields(yieldsRaw, nowMs);
  // Zero extra requests: reuse protocolsRaw to extract tokenless protocols (symbol === "-", TVL >= $5M).
  const defiLlamaAirdrops = extractDefiLlamaTokenlessAirdrops(protocolsRaw, nowMs);

  console.log(
    `Normalized DeFi: ${defi.rows.length} rows, Yields: ${yields.rows.length} rows, Tokenless Airdrops: ${defiLlamaAirdrops.cards.length} cards, ASSO7878: ${asso7878Feed?.cards.length ?? 0} cards/${asso7878Feed?.tge.length ?? 0} tge, arndxt: ${arndxtFeed?.cards.length ?? 0} cards/${arndxtFeed?.tge.length ?? 0} tge`,
  );

  // An empty/filtered-out section would overwrite the last good snapshot with
  // `rows: []` and ok=1; fail before any write so the old data ages out instead.
  if (defi.rows.length === 0 || yields.rows.length === 0) {
    throw new Error(`Empty DefiLlama section (defi=${defi.rows.length}, yields=${yields.rows.length}) — refusing to overwrite D1 snapshots`);
  }

  const snapshotsToWrite: [string, unknown][] = [
    ['markets:defi', defi],
    ['markets:yields', yields],
  ];
  if (defiLlamaAirdrops.cards.length > 0) {
    snapshotsToWrite.push(['airdrops:defillama', defiLlamaAirdrops]);
  }
  if (asso7878Feed && (asso7878Feed.cards.length > 0 || asso7878Feed.tge.length > 0)) {
    snapshotsToWrite.push(['airdrops:asso7878', asso7878Feed]);
  }
  if (arndxtFeed && (arndxtFeed.cards.length > 0 || arndxtFeed.tge.length > 0)) {
    snapshotsToWrite.push(['airdrops:arndxt', arndxtFeed]);
  }

  // Strictly opt-in paid Dune integration: 100% keyless $0 when DUNE_API_KEY is unset.
  const duneApiKey = process.env.DUNE_API_KEY?.trim();
  if (duneApiKey) {
    try {
      const duneSnapshot = await fetchDuneAirdrops(duneApiKey, undefined, nowMs);
      snapshotsToWrite.push(['airdrops:dune', duneSnapshot]);
      console.log(`Fetched Dune airdrop snapshot: ${duneSnapshot.queries.length} queries`);
    } catch (err) {
      console.warn('Optional Dune airdrop fetch failed (continuing with DefiLlama snapshots):', err);
    }
  }

  if (dryRun) {
    console.log('Dry-run complete (skipping D1 remote write).');
    return;
  }

  const statements: string[] = [];
  for (const [key, section] of snapshotsToWrite) {
    const body = JSON.stringify(section);
    const etag = `"${await sha1Hex(body)}"`;
    // Same fetched_at guard as the Worker's upsertSnapshot (worker/src/lib/db.ts):
    // completion order ≠ schedule order, so a delayed overlapping heavy run must
    // never regress a newer snapshot. `fetched_at` is fixed per run, so older run
    // loses, newer wins.
    statements.push(
      `INSERT INTO snapshots (key, body, etag, fetched_at, ok, error) VALUES (${sqlQuote(key)}, ${sqlQuote(body)}, ${sqlQuote(etag)}, ${nowMs}, 1, NULL)
ON CONFLICT(key) DO UPDATE SET
  body = excluded.body,
  etag = excluded.etag,
  fetched_at = excluded.fetched_at,
  ok = 1,
  error = NULL
WHERE excluded.fetched_at >= snapshots.fetched_at;`,
    );
  }
  // known_domains is NOT touched here: without the surf input this loop
  // relabelled surf-owned domains (origin surf -> defi) every 30 minutes;
  // the Worker's 5-minute cron reseeds the table from both feeds.

  const sqlPath = join(tmpdir(), `web3-radar-heavy-${nowMs}.sql`);
  await writeFile(sqlPath, statements.join('\n'), 'utf8');
  try {
    await Bun.$`npx wrangler d1 execute DB --remote --file ${sqlPath}`.cwd('worker');
    console.log('Updated snapshots in remote D1.');
  } finally {
    await unlink(sqlPath).catch(() => {});
  }
}

await main();
