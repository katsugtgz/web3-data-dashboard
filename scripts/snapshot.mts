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
import { selectFeedLinks } from '../worker/src/normalize/domains';
import { getRegistrableDomain, parseDropPost } from '../worker/src/normalize/parse';
import { computeScore } from '../worker/src/normalize/score';
import { collectKnownDomainEntries, evaluateSafety, reconcileSafetyReasons } from '../worker/src/safety';
import {
  buildCuratedAirdropFeed,
  extractDefiLlamaTokenlessAirdrops,
  type CuratedSourceOutcome,
} from '../worker/src/sources/curated';
import {
  AIRDROPALERT_CALENDAR_URL,
  fetchDropFeedPosts,
  parseWpCalendarToAirdropFeed,
  parseWpCalendarToFeedPosts,
} from '../worker/src/sources/feeds';
import {
  fetchCryptoSection,
  fetchGithubSection,
  fetchPredictionsSection,
  fetchTrendingSection,
  normalizeDefiProtocols,
  normalizeDefiYields,
} from '../worker/src/sources/markets';
import { SEED_SOURCES } from '../worker/src/sources/registry';
import { normalizeSurf } from '../worker/src/sources/surf';
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
  platform?: FeedSourceRef['platform'];
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
        (a.platform ?? 'telegram').localeCompare(b.platform ?? 'telegram') ||
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

async function buildAirdrops(
  protocolsRawPromise?: Promise<unknown>,
  airdropAlertRawPromise?: Promise<unknown>,
): Promise<{ feed: AirdropFeed; curatedOutcomes: CuratedSourceOutcome[] }> {
  if (workerBase) {
    try {
      const res = await fetch(`${workerBase}/airdrops.json`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS * 2),
      });
      if (res.ok) return { feed: (await res.json()) as AirdropFeed, curatedOutcomes: [] };
    } catch (err) {
      console.warn('Worker airdrops read failed, using local fallback:', err);
    }
  }
  try {
    const defiLlamaRaw = protocolsRawPromise ? await protocolsRawPromise.catch(() => null) : null;
    const defiLlamaFeed = defiLlamaRaw ? extractDefiLlamaTokenlessAirdrops(defiLlamaRaw, nowMs) : null;
    const { feed, outcomes } = await buildCuratedAirdropFeed({
      nowMs,
      defiLlamaFeed,
      fetchers: airdropAlertRawPromise
        ? {
            airdropalert: async () => {
              const raw = await airdropAlertRawPromise;
              const parsed = parseWpCalendarToAirdropFeed(raw, nowMs);
              if (parsed.cards.length === 0 && parsed.tge.length === 0) {
                throw new Error('AirdropAlert calendar returned 0 events');
              }
              return parsed;
            },
          }
        : undefined,
    });
    for (const o of outcomes) {
      if (!o.ok) console.warn(`Curated source "${o.name}" failed:`, o.error);
    }
    return { feed, curatedOutcomes: outcomes };
  } catch (err) {
    console.warn('All curated airdrop fetches failed, falling back to fixture:', err);
    const raw = JSON.parse(await readFile('worker/test/fixtures/surf-airdrops.json', 'utf8'));
    return { feed: normalizeSurf(raw, nowMs), curatedOutcomes: [] };
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

async function buildMarkets(
  protocolsRawPromise?: Promise<unknown>,
): Promise<MarketsResponse | null> {
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
    (protocolsRawPromise ?? fetchJson('https://api.llama.fi/protocols')).then(r => normalizeDefiProtocols(r, nowMs)),
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

export interface SnapshotAccCluster {
  id: string;
  project: string;
  ticker?: string;
  domain?: string;
  chains: Set<string>;
  taskTypes: Set<TaskType>;
  summary: string;
  urls: Set<string>;
  rawIpUrls: Set<string>;
  sources: FeedSourceRef[];
  sourceIds: Set<string>;
  sourceHandles: Set<string>;
  trustMax: number;
  firstSeen: number;
  lastSeen: number;
  texts: string[];
  surf?: FeedItem['surf'];
}

export interface FinalizeSnapshotClusterCtx {
  projectDomains: Map<string, string>;
  platformDomains: Set<string>;
  allKnownDomains: Set<string>;
  nowMs: number;
}

/**
 * Mirrors Worker `cluster.ts` safety + link hygiene on each accumulated
 * snapshot cluster: passes `platformDomains` + `rawIpUrls` into `evaluateSafety`,
 * selects up to 6 cleaned links via `selectFeedLinks`, and reconciles safety reasons.
 */
export function finalizeSnapshotCluster(
  acc: SnapshotAccCluster,
  ctx: FinalizeSnapshotClusterCtx,
): FeedItem {
  const urlsList = [...acc.urls].sort((a, b) => a.localeCompare(b));
  const rawIpUrlsList = [...acc.rawIpUrls].sort((a, b) => a.localeCompare(b));
  const chainsList = [...acc.chains].sort((a, b) => a.localeCompare(b));
  const texts = [...acc.texts].sort((a, b) => a.localeCompare(b));
  const cleanedLinks = selectFeedLinks(urlsList, {
    projectDomain: acc.domain,
    sourceHandles: acc.sourceHandles,
    allKnownDomains: ctx.allKnownDomains,
    maxLinks: 6,
  });
  const rawSafety = evaluateSafety({
    domain: acc.domain,
    urls: urlsList,
    rawIpUrls: rawIpUrlsList,
    text: texts.join('\n'),
    knownProjectDomains: ctx.projectDomains,
    platformDomains: ctx.platformDomains,
    trustMax: acc.trustMax,
    sourceCount: acc.sourceIds.size,
  });
  const safety = reconcileSafetyReasons({
    level: rawSafety.level,
    reasons: rawSafety.reasons,
    domain: acc.domain,
    cleanedLinks,
    knownDomains: ctx.allKnownDomains,
  });
  const taskTypes = acc.taskTypes.size > 1
    ? [...acc.taskTypes].sort((a, b) => a.localeCompare(b)).filter(t => t !== 'other')
    : [...acc.taskTypes].sort((a, b) => a.localeCompare(b));
  const score = computeScore({
    trustMax: acc.trustMax,
    sourceCount: acc.sourceIds.size,
    lastSeen: acc.lastSeen,
    nowMs: ctx.nowMs,
    surfTier: acc.surf?.tier,
    riskLevel: safety.level,
  });
  return {
    id: acc.id,
    project: acc.project,
    ...(acc.ticker ? { ticker: acc.ticker } : {}),
    ...(acc.domain ? { domain: acc.domain } : {}),
    chains: chainsList,
    taskTypes,
    summary: acc.summary,
    summarySource: 'rule',
    links: cleanedLinks.map(url => {
      const dom = getRegistrableDomain(url);
      return { url, known: Boolean(dom && ctx.allKnownDomains.has(dom)) };
    }),
    sources: [...acc.sources]
      .sort((a, b) => b.postedAt - a.postedAt || a.postUrl.localeCompare(b.postUrl))
      .slice(0, 10),
    sourceCount: acc.sourceIds.size,
    score,
    risk: safety as { level: RiskLevel; reasons: string[] },
    ...(acc.surf ? { surf: acc.surf } : {}),
    firstSeen: acc.firstSeen,
    lastSeen: acc.lastSeen,
  };
}

async function buildDropsAndSources(
  airdrops: AirdropFeed,
  markets: MarketsResponse,
  curatedOutcomes: CuratedSourceOutcome[] = [],
  airdropAlertRawPromise?: Promise<unknown>,
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
  const platformDomains = new Set(knownEntries.filter(e => e.origin === 'platform').map(e => e.domain));
  const surfIndex = buildSurfIndex(airdrops);

  const tgEnabled = SEED_SOURCES.filter(s => s.platform === 'telegram' && s.enabled);
  const dropFeeds = SEED_SOURCES.filter(s => s.platform === 'feed' && s.enabled && s.tags.includes('drops'));
  // Rotate through the registry: without a usable WORKER_URL only 12 channels
  // can be polled per run, so successive runs cover the rest instead of
  // always omitting the same tail.
  const runSlot = Math.floor(nowMs / (6 * 3_600_000)) % Math.max(1, Math.ceil(tgEnabled.length / 12));
  const sampleBatch = tgEnabled.slice(runSlot * 12, runSlot * 12 + 12);
  // Health reflects actual probe outcomes across attempted telegram, feed, and sheet sources.
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
  for (const o of curatedOutcomes) {
    if (!o.sourceId || o.sourceId === 'feed:airdropalert_calendar') continue;
    const [platform, handle] = o.sourceId.split(':');
    if (!platform || !handle) continue;
    healthMap.set(o.sourceId, {
      id: o.sourceId,
      platform,
      handle,
      status: o.ok ? 'ok' : 'down',
      lastOkAt: o.ok ? nowMs : null,
    });
  }

  const markChannelFailure = (platform: 'telegram' | 'feed', handle: string) => {
    const id = `${platform}:${handle}`;
    healthMap.set(id, {
      id,
      platform,
      handle,
      status: 'down',
      lastOkAt: null,
    });
  };

  const clusters = new Map<string, SnapshotAccCluster>();
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
    channelPosts.set(`telegram:${src.handle}`, {
      handle: src.handle,
      posts: posts.map(p => ({
        platform: 'telegram',
        handle: src.handle,
        msgId: p.msgId,
        postUrl: p.postUrl,
        postedAt: p.postedAt,
        text: p.text,
        urls: p.urls,
      })),
    });
  };

  await Promise.allSettled([
    ...sampleBatch.map(async src => {
      try {
        const html = await fetchTelegramChannelHtml(src.handle);
        await processPosts(src, html);
      } catch {
        markChannelFailure('telegram', src.handle);
        const fixturePath = join('worker/test/fixtures/telegram', `${src.handle}.html`);
        try {
          const html = await readFile(fixturePath, 'utf8');
          await processPosts(src, html, true);
        } catch {
          // Ignore missing fixture
        }
      }
    }),
    ...dropFeeds.map(async src => {
      const id = `feed:${src.handle}`;
      try {
        const posts =
          src.parser === 'wp_calendar' && airdropAlertRawPromise
            ? parseWpCalendarToFeedPosts(await airdropAlertRawPromise)
            : await fetchDropFeedPosts(src, nowMs);
        healthMap.set(id, {
          id,
          platform: 'feed',
          handle: src.handle,
          status: 'ok',
          lastOkAt: nowMs,
        });
        if (posts.length > 0) {
          channelPosts.set(id, {
            handle: src.handle,
            posts: posts.map(p => ({
              platform: 'feed',
              handle: src.handle,
              msgId: p.id,
              postUrl: p.postUrl,
              postedAt: p.postedAt,
              text: p.text,
              urls: p.urls,
            })),
          });
        }
      } catch {
        markChannelFailure('feed', src.handle);
      }
    }),
  ]);

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
      const src = SEED_SOURCES.find(s => s.platform === 'telegram' && s.handle === handle) ?? {
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

  // Deterministic merge before clustering: caps (summary pick, links 6,
  // sources 10) no longer depend on channel completion order.
  const merged = mergePostsStable([...channelPosts.values()], cutoff);
  for (const post of merged) {
    const platform = post.platform ?? 'telegram';
    const src = SEED_SOURCES.find(s => s.platform === platform && s.handle === post.handle) ?? {
      platform,
      handle: post.handle,
      lang: 'en',
      trust: 0.6,
      tags: ['airdrop'],
      enabled: true,
    };
    const parsed = parseDropPost(post.text, post.urls, {
      sourceLang: src.lang,
      knownDomains: projectDomains,
      surfByDomain: surfIndex.byDomain,
      surfByTicker: surfIndex.byTicker,
    });
    if (!parsed.isRelevantDrop) continue;
    // Same identity rule as the Worker: drift here silently split or
    // merged clusters between the committed snapshot and the live feed.
    const cid = await computeClusterId(
      parsed.projectDomain,
      parsed.ticker,
      parsed.project,
      `${platform}:${post.handle}:${post.msgId}`,
    );

    const srcId = `${platform}:${post.handle}`;
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
        rawIpUrls: new Set(parsed.rawIpUrls ?? []),
        sources: [],
        sourceIds: new Set(),
        sourceHandles: new Set(),
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
      for (const ipUrl of parsed.rawIpUrls ?? []) acc.rawIpUrls.add(ipUrl);
      acc.trustMax = Math.max(acc.trustMax, src.trust);
      acc.firstSeen = Math.min(acc.firstSeen, post.postedAt);
      acc.lastSeen = Math.max(acc.lastSeen, post.postedAt);
      acc.texts.push(post.text);
    }
    acc.sourceIds.add(srcId);
    acc.sourceHandles.add(post.handle);
    if (acc.sources.length < 10) {
      acc.sources.push({
        platform,
        handle: post.handle,
        postUrl: post.postUrl,
        postedAt: post.postedAt,
      });
    }
  }

  const items: FeedItem[] = [];
  const finalizeCtx: FinalizeSnapshotClusterCtx = {
    projectDomains,
    platformDomains,
    allKnownDomains,
    nowMs,
  };
  for (const acc of clusters.values()) {
    items.push(finalizeSnapshotCluster(acc, finalizeCtx));
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
  // Share single DefiLlama protocols & AirdropAlert calendar fetches concurrently
  // across airdrops, markets, and drop feeds without pre-awaiting serially.
  const sharedProtocolsPromise = workerBase ? undefined : fetchJson('https://api.llama.fi/protocols');
  const sharedAirdropAlertPromise = workerBase ? undefined : fetchJson(AIRDROPALERT_CALENDAR_URL);
  sharedProtocolsPromise?.catch(() => {});
  sharedAirdropAlertPromise?.catch(() => {});
  const [{ feed: airdrops, curatedOutcomes }, markets] = await Promise.all([
    buildAirdrops(sharedProtocolsPromise, sharedAirdropAlertPromise),
    buildMarkets(sharedProtocolsPromise),
  ]);
  // Never publish empty payloads: a total fetch failure must keep the last
  // committed snapshot instead of wiping markets (or the feed) to `[]`. The
  // same holds for the fixture-seeded feed: test data must never ship as the
  // committed snapshot, so the previous feed.json is reused instead.
  if (!markets) {
    throw new Error('All market fetches failed and no committed section could be reused — refusing to overwrite data/snapshot/markets.json');
  }
  const { feed, sources, fixtureSeeded } = await buildDropsAndSources(
    airdrops,
    markets,
    curatedOutcomes,
    sharedAirdropAlertPromise,
  );
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
