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
import { buildSurfIndex } from '../worker/src/normalize/cluster';
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
  }
  for (const r of [defiRes, yieldsRes, polyRes, dexRes, ghRes]) {
    if (r.status === 'fulfilled') sections.push(r.value);
  }

  return { generatedAt: nowMs, sections, sectors };
}

async function buildDropsAndSources(
  airdrops: AirdropFeed,
  markets: MarketsResponse,
): Promise<{ feed: FeedResponse; sources: SourceHealth[] }> {
  if (workerBase) {
    const [fRes, sRes] = await Promise.all([fetch(`${workerBase}/feed.json`), fetch(`${workerBase}/sources.json`)]);
    if (fRes.ok && sRes.ok) {
      return {
        feed: (await fRes.json()) as FeedResponse,
        sources: (await sRes.json()) as SourceHealth[],
      };
    }
  }

  const defiSection = markets.sections.find(s => s.id === 'defi') ?? null;
  const knownEntries = collectKnownDomainEntries(airdrops, defiSection);
  const allKnownDomains = new Set(knownEntries.map(e => e.domain));
  const projectDomains = new Map(knownEntries.filter(e => e.origin !== 'platform').map(e => [e.domain, e.project]));
  const surfIndex = buildSurfIndex(airdrops);

  const tgEnabled = SEED_SOURCES.filter(s => s.platform === 'telegram' && s.enabled);
  const sampleBatch = tgEnabled.slice(0, 12);
  const healthMap = new Map<string, SourceHealth>();

  for (const s of SEED_SOURCES.filter(x => x.enabled)) {
    healthMap.set(`${s.platform}:${s.handle}`, {
      id: `${s.platform}:${s.handle}`,
      platform: s.platform,
      handle: s.handle,
      status: 'ok',
      lastOkAt: nowMs,
    });
  }

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
    for (const post of posts.slice(0, 6)) {
      if (post.postedAt < cutoff) continue;
      const parsed = parseDropPost(post.text, post.urls, {
        knownDomains: projectDomains,
        surfByDomain: surfIndex.byDomain,
        surfByTicker: surfIndex.byTicker,
      });
      const cid = parsed.projectDomain
        ? await sha1Hex(`dom:${parsed.projectDomain.toLowerCase()}`)
        : parsed.ticker
          ? await sha1Hex(`tick:$${parsed.ticker.toUpperCase()}`)
          : parsed.project === 'Web3 Project'
            ? await sha1Hex(`post:${src.handle}:${post.msgId}`)
            : await sha1Hex(`proj:${parsed.project.toLowerCase().replace(/[^a-z0-9]+/g, '')}`);

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

  items.sort((a, b) => b.score - a.score || b.lastSeen - a.lastSeen);
  return {
    feed: { generatedAt: nowMs, items: items.slice(0, 100) },
    sources: [...healthMap.values()],
  };
}

await mkdir('data/snapshot', { recursive: true });
const [airdrops, markets] = await Promise.all([buildAirdrops(), buildMarkets()]);
const { feed, sources } = await buildDropsAndSources(airdrops, markets);
await writeFile('data/snapshot/airdrops.json', JSON.stringify(airdrops));
await writeFile('data/snapshot/markets.json', JSON.stringify(markets));
await writeFile('data/snapshot/feed.json', JSON.stringify(feed));
await writeFile('data/snapshot/sources.json', JSON.stringify(sources));
console.log(
  `Wrote snapshots: airdrops=${airdrops.cards.length}, markets=${markets.sections.length}, feed=${feed.items.length}, sources=${sources.length}`,
);
