import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AirdropFeed,
  FeedItem,
  FeedResponse,
  FeedSourceRef,
  MarketSection,
  MarketSector,
  MarketSectionId,
  MarketsResponse,
  RiskLevel,
  SourceHealth,
  TaskType,
} from '../shared/types';
import { FETCH_TIMEOUT_MS, USER_AGENT } from '../worker/src/lib/format';
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

// README promises a "100% English" feed. The registry carries id/zh channels
// (worker/sources.json), whose raw Telegram text reaches clusters before any
// AI translation, so drop non-Latin posts at the snapshot boundary. Mirrors
// NON_LATIN_SCRIPT_RE in worker/src/normalize/parse.ts (inlined: a script-side
// module importing worker internals only for one regex would tangle deps).
const NON_LATIN_SCRIPT_RE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Thai}]/u;

export function isEnglishText(text: string): boolean {
  return !NON_LATIN_SCRIPT_RE.test(text);
}

/** Last committed feed for the fixture-seeded fallback (failed-fetch invariant). */
async function readExistingFeed(): Promise<FeedResponse | null> {
  try {
    const raw = await readFile('data/snapshot/feed.json', 'utf8');
    const parsed = JSON.parse(raw) as FeedResponse;
    return Array.isArray(parsed.items) && parsed.items.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Total-failure gate for the fixture fallback: true only when no live channel
 * produced any parsed post. Consumes post-collection state (the deferred
 * channelPosts map), never the cluster map — clusters stay empty until the
 * deterministic merge loop runs, so they cannot witness collection.
 */
export function fixtureFallbackNeeded(
  channelPosts: ReadonlyMap<string, { handle: string; posts: MergePost[] }>,
): boolean {
  return channelPosts.size === 0;
}

/**
 * Byte-stable output for identical data: cluster accumulation order depends on
 * channel/promise completion, so merge posts in a channel-independent order.
 * Sorting the merged post stream by (postedAt, handle, msgId) before the cap
 * keeps summary/links/sources selection completion-order-independent. Same
 * per-post cap (6) as the per-channel slice.
 */
export interface MergePost {
  handle: string;
  msgId: string;
  postUrl: string;
  postedAt: number;
  text: string;
  urls: string[];
}

/** Stable merge of per-channel newest-first post lists; slices newest `perChannel`. */
export function mergePostsStable(
  perChannelPosts: { handle: string; posts: MergePost[] }[],
  cutoff: number,
  perChannel = 6,
): MergePost[] {
  const trimmed = perChannelPosts.map(({ handle, posts }) => ({
    handle,
    posts: [...posts]
      .filter(p => p.postedAt >= cutoff && isEnglishText(p.text))
      .sort((a, b) => b.postedAt - a.postedAt || a.msgId.localeCompare(b.msgId))
      .slice(0, perChannel),
  }));
  return trimmed
    .flatMap(({ handle, posts }) => posts.map(p => ({ ...p, handle })))
    .sort(
      (a, b) =>
        b.postedAt - a.postedAt ||
        a.handle.localeCompare(b.handle) ||
        a.msgId.localeCompare(b.msgId),
    );
}


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
      const res = await fetch(`${workerBase}/airdrops.json`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS * 2),
      });
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

/**
 * Section-level failed-fetch invariant (#5): a run where any section's fetch
 * failed must not overwrite the committed markets.json with a reduced payload.
 * Keeps the prior committed section for every missing id; null only when a
 * required section is missing AND has no committed predecessor (caller throws).
 * generatedAt/sectors always come from the current run.
 */
export function mergeSectionsWithPrior(
  freshSections: MarketSection[],
  priorSections: MarketSection[],
  requiredIds: readonly MarketSectionId[],
): MarketSection[] | null {
  const byId = new Map(freshSections.map(s => [s.id, s]));
  for (const prior of priorSections) {
    if (!byId.has(prior.id)) byId.set(prior.id, prior);
  }
  for (const id of requiredIds) {
    if (!byId.has(id)) return null;
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Last committed markets sections; tolerates missing/corrupt file. */
async function readPriorSections(): Promise<MarketSection[]> {
  try {
    const parsed = JSON.parse(await readFile('data/snapshot/markets.json', 'utf8')) as MarketsResponse;
    return Array.isArray(parsed.sections) ? parsed.sections.filter(s => s && typeof s.id === 'string') : [];
  } catch {
    return [];
  }
}

async function buildMarkets(): Promise<MarketsResponse | null> {
  if (workerBase) {
    try {
      const res = await fetch(`${workerBase}/markets.json`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS * 2),
      });
      if (res.ok) return (await res.json()) as MarketsResponse;
    } catch (err) {
      console.warn('Worker markets read failed, using local fallback:', err);
    }
  }

  const fresh: MarketSection[] = [];
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
    fresh.push(cryptoRes.value.section);
    sectors = cryptoRes.value.sectors;
  }
  for (const [name, r] of [
    ['defi', defiRes],
    ['yields', yieldsRes],
    ['predictions', polyRes],
    ['trending', dexRes],
    ['github', ghRes],
  ] as const) {
    if (r.status === 'fulfilled') fresh.push(r.value);
    else console.warn(`markets section "${name}" rejected:`, r.reason);
  }

  const sections = mergeSectionsWithPrior(fresh, await readPriorSections(), ['crypto', 'defi']);
  return sections ? { generatedAt: nowMs, sections, sectors } : null;
}

async function buildDropsAndSources(
  airdrops: AirdropFeed,
  markets: MarketsResponse,
): Promise<{ feed: FeedResponse; sources: SourceHealth[]; fixtureSeeded: boolean }> {
  if (workerBase) {
    const [fRes, sRes] = await Promise.allSettled([
      fetch(`${workerBase}/feed.json`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS * 2) }),
      fetch(`${workerBase}/sources.json`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS * 2) }),
    ]);
    if (fRes.status === 'fulfilled' && sRes.status === 'fulfilled' && fRes.value.ok && sRes.value.ok) {
      try {
        return {
          feed: (await fRes.value.json()) as FeedResponse,
          sources: (await sRes.value.json()) as SourceHealth[],
          fixtureSeeded: false,
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

  let fixtureSeeded = false;
  // Parsed but unclustered posts, merged deterministically after all channels
  // settle (see mergePostsStable): clustering in completion order made the
  // summary/links/sources caps depend on network timing.
  const channelPosts = new Map<string, { handle: string; posts: MergePost[] }>();
  const processPosts = async (src: (typeof tgEnabled)[number], html: string, fromFixture = false) => {
    fixtureSeeded ||= fromFixture;
    const posts = await parseTelegramHtml(html, src.handle);
    // t.me/s pages are oldest-first: keep the NEWEST posts per channel. (The
    // first-six slice silently dropped the freshest posts on pages with more
    // than six messages.) Cutoff + English filter are applied by mergePostsStable.
    channelPosts.set(src.handle, {
      handle: src.handle,
      posts: posts.map(p => ({
        handle: src.handle,
        msgId: p.msgId,
        postUrl: p.postUrl,
        postedAt: p.postedAt,
        text: p.text,
        urls: p.urls,
      })),
    });
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
          await processPosts(src, html, true);
        } catch {
          // Ignore missing fixture
        }
      }
    }),
  );

  // If network failed completely, seed from all local fixtures. Gate on the
  // collected posts, NOT the cluster map: clusters stay empty until the merge
  // loop below runs, so a pre-clustering `clusters.size === 0` check always
  // fired on live runs and forced the fixture fallback (previous committed
  // feed reused, never regenerated).
  if (fixtureFallbackNeeded(channelPosts)) {
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
      await processPosts(src, html, true);
    }
  }

  // Deterministic merge before clustering: caps (summary pick, links 8,
  // sources 10) no longer depend on channel completion order.
  const merged = mergePostsStable([...channelPosts.values()], cutoff);
  for (const post of merged) {
    const src = SEED_SOURCES.find(s => s.handle === post.handle) ?? {
      platform: 'telegram' as const,
      handle: post.handle,
      lang: 'en',
      trust: 0.6,
      tags: ['airdrop'],
      enabled: true,
    };
    const parsed = parseDropPost(post.text, post.urls, {
      knownDomains: projectDomains,
      surfByDomain: surfIndex.byDomain,
      surfByTicker: surfIndex.byTicker,
    });
    // Same identity rule as the Worker: drift here silently split or
    // merged clusters between the committed snapshot and the live feed.
    const cid = await computeClusterId(parsed.projectDomain, parsed.ticker, parsed.project, `${post.handle}:${post.msgId}`);

    const srcId = `telegram:${post.handle}`;
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
        handle: post.handle,
        postUrl: post.postUrl,
        postedAt: post.postedAt,
      });
    }
  }

  const items: FeedItem[] = [];
  for (const acc of clusters.values()) {
    // Determinism: every collection here feeds a cap, join, or pick. Sort by
    // stable keys so identical input data cannot produce different bytes when
    // post arrival order changed (the merge order is already stable).
    const urlsList = [...acc.urls].sort((a, b) => a.localeCompare(b));
    const chainsList = [...acc.chains].sort((a, b) => a.localeCompare(b));
    const texts = [...acc.texts].sort((a, b) => a.localeCompare(b));
    const safety = evaluateSafety({
      domain: acc.domain,
      urls: urlsList,
      text: texts.join('\n'),
      knownProjectDomains: projectDomains,
      trustMax: acc.trustMax,
      sourceCount: acc.sourceIds.size,
    });
    const taskTypes = acc.taskTypes.size > 1
      ? [...acc.taskTypes].sort((a, b) => a.localeCompare(b)).filter(t => t !== 'other')
      : [...acc.taskTypes].sort((a, b) => a.localeCompare(b));
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
      chains: chainsList,
      taskTypes,
      summary: acc.summary,
      summarySource: 'rule',
      links: urlsList.slice(0, 8).map(url => {
        const dom = getRegistrableDomain(url);
        return { url, known: Boolean(dom && allKnownDomains.has(dom)) };
      }),
      // Stable cap: postedAt desc with postUrl tiebreak, so identical data
      // cannot reorder on completion timing (merge is already deterministic;
      // this keeps the in-flight cap below 10 order-free too).
      sources: [...acc.sources]
        .sort((a, b) => b.postedAt - a.postedAt || a.postUrl.localeCompare(b.postUrl))
        .slice(0, 10),
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
    sources: [...healthMap.values()].sort((a, b) => a.id.localeCompare(b.id)),
    fixtureSeeded,
  };
}

// import.meta.main guard: the test file imports this module for
// mergePostsStable/isEnglishText and must not re-run the pipeline.
if (import.meta.main) {
  await runSnapshot();
}

async function runSnapshot(): Promise<void> {
  await mkdir('data/snapshot', { recursive: true });
  const [airdrops, markets] = await Promise.all([buildAirdrops(), buildMarkets()]);
  // Never publish empty payloads: a total fetch failure must keep the last
  // committed snapshot instead of wiping markets (or the feed) to `[]`. The
  // same holds for the fixture-seeded feed: test data must never ship as the
  // committed snapshot, so the previous feed.json is reused instead.
  if (!markets) {
    throw new Error('All market fetches failed and no committed section could be reused — refusing to overwrite data/snapshot/markets.json');
  }
  const { feed, sources, fixtureSeeded } = await buildDropsAndSources(airdrops, markets);
  if (feed.items.length === 0) {
    throw new Error('Feed had zero items — refusing to overwrite data/snapshot/feed.json');
  }
  const feedOut = fixtureSeeded ? await readExistingFeed() : feed;
  if (!feedOut) {
    throw new Error('Feed was seeded from test fixtures and no committed data/snapshot/feed.json exists — refusing to publish fixture data');
  }
  await writeFile('data/snapshot/airdrops.json', JSON.stringify(airdrops));
  await writeFile('data/snapshot/markets.json', JSON.stringify(markets));
  await writeFile('data/snapshot/feed.json', JSON.stringify(feedOut));
  await writeFile('data/snapshot/sources.json', JSON.stringify(sources));
  console.log(
    `Wrote snapshots: airdrops=${airdrops.cards.length}, markets=${markets.sections.length}, feed=${feed.items.length}, sources=${sources.length}`,
  );
}
