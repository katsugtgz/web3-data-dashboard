import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { AirdropFeed, MarketSection, MarketSector, MarketsResponse } from '../shared/types';
import { FETCH_TIMEOUT_MS, USER_AGENT } from '../worker/src/lib/format';
import {
  fetchCryptoSection,
  fetchGithubSection,
  fetchPredictionsSection,
  fetchTrendingSection,
  normalizeDefiProtocols,
  normalizeDefiYields,
} from '../worker/src/sources/markets';
import { fetchSurfAirdrops, normalizeSurf } from '../worker/src/sources/surf';

const nowMs = Date.now();
const workerBase = (process.env.WORKER_URL ?? '').replace(/\/+$/, '');

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS * 2),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function buildAirdrops(): Promise<AirdropFeed> {
  if (workerBase) {
    const res = await fetch(`${workerBase}/airdrops.json`);
    if (res.ok) return (await res.json()) as AirdropFeed;
  }
  try {
    return await fetchSurfAirdrops(undefined, nowMs);
  } catch (err) {
    console.warn('Live surf fetch failed, falling back to fixture:', err);
    const raw = JSON.parse(await readFile('worker/test/fixtures/surf-airdrops.json', 'utf8'));
    return normalizeSurf(raw, nowMs);
  }
}

async function buildMarkets(): Promise<MarketsResponse> {
  if (workerBase) {
    const res = await fetch(`${workerBase}/markets.json`);
    if (res.ok) return (await res.json()) as MarketsResponse;
  }

  const sections: MarketSection[] = [];
  let sectors: MarketSector[] = [];

  const [cryptoRes, defiRes, yieldsRes, polyRes, dexRes, ghRes] = await Promise.allSettled([
    fetchCryptoSection(nowMs),
    fetchJson('https://api.llama.fi/protocols').then(r => normalizeDefiProtocols(r, nowMs)),
    fetchJson('https://yields.llama.fi/pools').then(r => normalizeDefiYields(r, nowMs)),
    fetchPredictionsSection(nowMs),
    fetchTrendingSection(nowMs),
    fetchGithubSection(nowMs),
  ]);

  if (cryptoRes.status === 'fulfilled') {
    sections.push(cryptoRes.value.section);
    sectors = cryptoRes.value.sectors;
  } else {
    console.warn('crypto failed:', cryptoRes.reason);
  }
  for (const r of [defiRes, yieldsRes, polyRes, dexRes, ghRes]) {
    if (r.status === 'fulfilled') sections.push(r.value);
    else console.warn('market section failed:', r.reason);
  }

  return { generatedAt: nowMs, sections, sectors };
}

await mkdir('data/snapshot', { recursive: true });
const [airdrops, markets] = await Promise.all([buildAirdrops(), buildMarkets()]);
await writeFile('data/snapshot/airdrops.json', JSON.stringify(airdrops));
await writeFile('data/snapshot/markets.json', JSON.stringify(markets));
console.log(
  `Wrote data/snapshot/airdrops.json (${airdrops.cards.length} cards, ${airdrops.tge.length} tge) and markets.json (${markets.sections.length} sections)`,
);
