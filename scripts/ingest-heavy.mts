import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FETCH_TIMEOUT_MS, USER_AGENT } from '../worker/src/lib/format';
import { sha1Hex } from '../worker/src/lib/hash';
import { collectKnownDomainEntries } from '../worker/src/safety';
import { normalizeDefiProtocols, normalizeDefiYields } from '../worker/src/sources/markets';

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
  const [protocolsRaw, yieldsRaw] = await Promise.all([
    fetchJson('https://api.llama.fi/protocols'),
    fetchJson('https://yields.llama.fi/pools'),
  ]);

  const defi = normalizeDefiProtocols(protocolsRaw, nowMs);
  const yields = normalizeDefiYields(yieldsRaw, nowMs);

  console.log(`Normalized DeFi: ${defi.rows.length} rows, Yields: ${yields.rows.length} rows`);

  if (dryRun) {
    console.log('Dry-run complete (skipping D1 remote write).');
    return;
  }

  const statements: string[] = [];
  for (const [key, section] of [
    ['markets:defi', defi],
    ['markets:yields', yields],
  ] as const) {
    const body = JSON.stringify(section);
    const etag = `"${await sha1Hex(body)}"`;
    statements.push(
      `INSERT OR REPLACE INTO snapshots (key, body, etag, fetched_at, ok, error) VALUES (${sqlQuote(key)}, ${sqlQuote(body)}, ${sqlQuote(etag)}, ${nowMs}, 1, NULL);`,
    );
  }
  for (const entry of collectKnownDomainEntries(null, defi)) {
    statements.push(
      `INSERT INTO known_domains (domain, project, origin) VALUES (${sqlQuote(entry.domain)}, ${sqlQuote(entry.project)}, ${sqlQuote(entry.origin)}) ON CONFLICT(domain) DO UPDATE SET project = excluded.project, origin = excluded.origin;`,
    );
  }

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
