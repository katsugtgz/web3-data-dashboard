import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AirdropFeed,
  FeedItem,
  FeedResponse,
  FeedSourceRef,
  MarketSection,
  MarketSector,
  MarketsResponse,
  RiskLevel,
  SourceHealth,
  TaskType,
} from '../shared/types';
import { FETCH_TIMEOUT_MS, USER_AGENT } from '../worker/src/lib/format';
import { sha1Hex } from '../worker/src/lib/hash';
import { buildSurfIndex, computeClusterId } from '../worker/src/normalize/cluster';
import { getRegistrableDomain, parseDropPost } from '../worker/src/normalize/parse';
import { computeScore } from '../worker/src/normalize/score';
import { collectKnownDomainEntries, evaluateSafety } from '../worker/src/safety';
import {
  fetchCryptoSection,
  fetchGithubSection,
  fetchPredictionsSection,
  fetchTrendingSection,
  normalizeDefiProtocols,
  normalizeDefiYields,
} from '../worker/src/sources/markets';
import { SEED_SOURCES } from '../worker/src/sources/registry';
import { fetchSurfAirdrops, normalizeSurf } from '../worker/src/sources/surf';
import { fetchTelegramChannelHtml, parseTelegramHtml } from '../worker/src/sources/telegram';

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
    try {
      const res = await fetch(`${workerBase}/airdrops.json`);
      if (res.ok) return (await res.json()) as AirdropFeed;
    } catch (err) {
      console.warn('Worker airdrops read failed, using local fallback:', err);
    }
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
    try {
      const res = await fetch(`${workerBase}/markets.json`);
      if (res.ok) return (await res.json()) as MarketsResponse;
    } catch (err) {
      console.warn('Worker markets read failed, using local fallback:', err);
    }
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
  }
  for (const [name, r] of [
    ['defi', defiRes],
    ['yields', yieldsRes],
    ['predictions', polyRes],
    ['trending', dexRes],
    ['github', ghRes],
  ] as const) {
    if (r.status === 'fulfilled') sections.push(r.value);
    else console.warn(`markets section "${name}" rejected:`, r.reason);
  }

  return { generatedAt: nowMs, sections, sectors };
}

async function buildDropsAndSources(
  airdrops: AirdropFeed,
  markets: MarketsResponse,
): Promise<{ feed: FeedResponse; sources: SourceHealth[] }> {
  if (workerBase) {
    const [fRes, sRes] = await Promise.allSettled([
      fetch(`${workerBase}/feed.json`),
      fetch(`${workerBase}/sources.json`),
    ]);
    if (fRes.status === 'fulfilled' && sRes.status === 'fulfilled' && fRes.value.ok && sRes.value.ok) {
      try {
        return {
          feed: (await fRes.value.json()) as FeedResponse,
          sources: (await sRes.value.json()) as SourceHealth[],
        };
      } catch (err) {
        console.warn('Worker feed/sources JSON parse failed, using local fallback:', err);
      }
    } else {
      console.warn(
        'Worker feed/sources read failed; using local fallback:',
        fRes.status === 'rejected' ? fRes.reason : `feed HTTP ${fRes.value.status}`,
        sRes.status === 'rejected' ? sRes.reason : `sources HTTP ${sRes.value.status}`,
      );
    }
  }

  const defiSection = markets.sections.find(s => s.id === 'defi') ?? null;
  const knownEntries = collectKnownDomainEntries(airdrops, defiSection);
  const allKnownDomains = new Set(knownEntries.map(e => e.domain));
  const projectDomains = new Map(knownEntries.filter(e => e.origin !== 'platform').map(e => [e.domain, e.project]));
  const surfIndex = buildSurfIndex(airdrops);

  const tgEnabled = SEED_SOURCES.filter(s => s.platform === 'telegram' && s.enabled);
  // Rotate through the registry: without a usable WORKER_URL only 12 channels
  // can be polled per run, so successive runs cover the rest instead of
  // always omitting the same tail.
  const runSlot = Math.floor(nowMs / (6 * 3_600_000)) % Math.max(1, Math.ceil(tgEnabled.length / 12));
  const sampleBatch = tgEnabled.slice(runSlot * 12, runSlot * 12 + 12);
  // Health reflects actual probe outcomes: only channels attempted this run
  // are reported (ok after a successful fetch+parse). Marking the whole
  // registry healthy — including unpolled X sources and failed fetches —
  // made the popover lie. X sources are unprobed here and simply omitted;
  // the Worker's /sources.json stays the source of truth for live health.
  const healthMap = new Map<string, SourceHealth>();
  for (const src of sampleBatch) {
    healthMap.set(`telegram:${src.handle}`, {
      id: `telegram:${src.handle}`,
      platform: 'telegram',
      handle: src.handle,
      status: 'ok',
      lastOkAt: nowMs,
    });
  }
  const markChannelFailure = (handle: string) => {
    const id = `telegram:${handle}`;
    healthMap.set(id, {
      id,
      platform: 'telegram',
      handle,
      status: 'down',
      lastOkAt: null,
    });
  };

  interface AccCluster {
    id: string;
    project: string;
    ticker?: string;
    domain?: string;
    chains: Set<string>;
    taskTypes: Set<TaskType>;
    summary: string;
    urls: Set<string>;
    sources: FeedSourceRef[];
    sourceIds: Set<string>;
    trustMax: number;
    firstSeen: number;
    lastSeen: number;
    texts: string[];
    surf?: FeedItem['surf'];
  }

  const clusters = new Map<string, AccCluster>();
  const cutoff = nowMs - 14 * 86_400_000;

  const processPosts = async (src: (typeof sampleBatch)[number], html: string) => {
    const posts = await parseTelegramHtml(html, src.handle);
    // t.me/s pages are oldest-first: keep the NEWEST posts per channel, then
    // apply the 14-day cutoff. (The first-six slice silently dropped the
    // freshest posts on pages with more than six messages.)
    for (const post of [...posts].sort((a, b) => b.postedAt - a.postedAt).slice(0, 6)) {
      if (post.postedAt < cutoff) continue;
      const parsed = parseDropPost(post.text, post.urls, {
        knownDomains: projectDomains,
        surfByDomain: surfIndex.byDomain,
        surfByTicker: surfIndex.byTicker,
      });
      // Same identity rule as the Worker: drift here silently split or
      // merged clusters between the committed snapshot and the live feed.
      const cid = await computeClusterId(parsed.projectDomain, parsed.ticker, parsed.project, `${src.handle}:${post.msgId}`);

      const srcId = `telegram:${src.handle}`;
      const surfMatch =
        (parsed.projectDomain && surfIndex.byDomain.get(parsed.projectDomain)) ||
        (parsed.ticker && surfIndex.byTicker.get(parsed.ticker)) ||
        undefined;

      let acc = clusters.get(cid);
      if (!acc) {
        acc = {
          id: cid,
          project: parsed.project,
          ticker: parsed.ticker,
          domain: parsed.projectDomain,
          chains: new Set(parsed.chains),
          taskTypes: new Set(parsed.taskTypes),
          summary: parsed.summary,
          urls: new Set(parsed.urls),
          sources: [],
          sourceIds: new Set(),
          trustMax: src.trust,
          firstSeen: post.postedAt,
          lastSeen: post.postedAt,
          texts: [post.text],
          surf: surfMatch ? { tier: surfMatch.tier, cardRank: surfMatch.cardRank } : undefined,
        };
        clusters.set(cid, acc);
      } else {
        for (const c of parsed.chains) acc.chains.add(c);
        for (const t of parsed.taskTypes) acc.taskTypes.add(t);
        for (const u of parsed.urls) acc.urls.add(u);
        acc.trustMax = Math.max(acc.trustMax, src.trust);
        acc.firstSeen = Math.min(acc.firstSeen, post.postedAt);
        acc.lastSeen = Math.max(acc.lastSeen, post.postedAt);
        acc.texts.push(post.text);
      }
      acc.sourceIds.add(srcId);
      if (acc.sources.length < 10) {
        acc.sources.push({
          platform: 'telegram',
          handle: src.handle,
          postUrl: post.postUrl,
          postedAt: post.postedAt,
        });
      }
    }
  };

  await Promise.allSettled(
    sampleBatch.map(async src => {
      try {
        const html = await fetchTelegramChannelHtml(src.handle);
        await processPosts(src, html);
      } catch {
        markChannelFailure(src.handle);
        const fixturePath = join('worker/test/fixtures/telegram', `${src.handle}.html`);
        try {
          const html = await readFile(fixturePath, 'utf8');
          await processPosts(src, html);
        } catch {
          // Ignore missing fixture
        }
      }
    }),
  );

  // If network failed completely, seed from all local fixtures
  if (clusters.size === 0) {
    const files = await readdir('worker/test/fixtures/telegram').catch(() => [] as string[]);
    for (const file of files) {
      if (!file.endsWith('.html')) continue;
      const handle = file.replace(/\.html$/, '');
      const src = SEED_SOURCES.find(s => s.handle === handle) ?? {
        platform: 'telegram' as const,
        handle,
        lang: 'en',
        trust: 0.6,
        tags: ['airdrop'],
        enabled: true,
      };
      const html = await readFile(join('worker/test/fixtures/telegram', file), 'utf8');
      await processPosts(src, html);
    }
  }

  const items: FeedItem[] = [];
  for (const acc of clusters.values()) {
    const urlsList = [...acc.urls];
    const safety = evaluateSafety({
      domain: acc.domain,
      urls: urlsList,
      text: acc.texts.join('\n'),
      knownProjectDomains: projectDomains,
      trustMax: acc.trustMax,
      sourceCount: acc.sourceIds.size,
    });
    const taskTypes = acc.taskTypes.size > 1 ? [...acc.taskTypes].filter(t => t !== 'other') : [...acc.taskTypes];
    const score = computeScore({
      trustMax: acc.trustMax,
      sourceCount: acc.sourceIds.size,
      lastSeen: acc.lastSeen,
      nowMs,
      surfTier: acc.surf?.tier,
      riskLevel: safety.level,
    });
    items.push({
      id: acc.id,
      project: acc.project,
      ...(acc.ticker ? { ticker: acc.ticker } : {}),
      ...(acc.domain ? { domain: acc.domain } : {}),
      chains: [...acc.chains],
      taskTypes,
      summary: acc.summary,
      summarySource: 'rule',
      links: urlsList.slice(0, 8).map(url => {
        const dom = getRegistrableDomain(url);
        return { url, known: Boolean(dom && allKnownDomains.has(dom)) };
      }),
      sources: acc.sources.sort((a, b) => b.postedAt - a.postedAt).slice(0, 10),
      sourceCount: acc.sourceIds.size,
      score,
      risk: safety as { level: RiskLevel; reasons: string[] },
      ...(acc.surf ? { surf: acc.surf } : {}),
      firstSeen: acc.firstSeen,
      lastSeen: acc.lastSeen,
    });
  }

  // Deterministic order: id tiebreak matches the Worker's queryFeed, so two
  // runs over identical data produce byte-identical feeds regardless of
  // network completion order.
  items.sort((a, b) => b.score - a.score || b.lastSeen - a.lastSeen || a.id.localeCompare(b.id));
  return {
    feed: { generatedAt: nowMs, items: items.slice(0, 100) },
    sources: [...healthMap.values()],
  };
}

await mkdir('data/snapshot', { recursive: true });
const [airdrops, markets] = await Promise.all([buildAirdrops(), buildMarkets()]);
const { feed, sources } = await buildDropsAndSources(airdrops, markets);
// Never publish empty payloads: a total fetch failure must keep the last
// committed snapshot instead of wiping markets (or the feed) to `[]`.
if (markets.sections.length === 0) {
  throw new Error('All market fetches failed — refusing to overwrite data/snapshot/markets.json with zero sections');
}
if (feed.items.length === 0) {
  throw new Error('Feed had zero items — refusing to overwrite data/snapshot/feed.json');
}
await writeFile('data/snapshot/airdrops.json', JSON.stringify(airdrops));
await writeFile('data/snapshot/markets.json', JSON.stringify(markets));
await writeFile('data/snapshot/feed.json', JSON.stringify(feed));
await writeFile('data/snapshot/sources.json', JSON.stringify(sources));
console.log(
  `Wrote snapshots: airdrops=${airdrops.cards.length}, markets=${markets.sections.length}, feed=${feed.items.length}, sources=${sources.length}`,
);
