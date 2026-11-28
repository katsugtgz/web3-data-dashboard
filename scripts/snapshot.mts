import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
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
import {
  filterGamblingAirdropFeed,
  filterGamblingFeedItems,
  findGamblingAirdropViolations,
  findGamblingFeedViolations,
} from '../shared/gamblingFilter';
import { FETCH_TIMEOUT_MS, USER_AGENT } from '../worker/src/lib/format';
import {
  buildFeedLogoIndex,
  buildSurfIndex,
  computeClusterId,
  resolveFeedItemLogo,
  type FeedLogoIndex,
  type SurfIndex,
} from '../worker/src/normalize/cluster';
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
  parseWpCalendarFeedPayload,
  parseWpCalendarToAirdropFeed,
} from '../worker/src/sources/feeds';
import {
  enrichYieldRowIcons,
  fetchCryptoSection,
  fetchGithubSection,
  fetchPredictionsSection,
  fetchTrendingSection,
  normalizeDefiProtocols,
  normalizeDefiYields,
} from '../worker/src/sources/markets';
import { SEED_SOURCES, getSeedSourceById } from '../worker/src/sources/registry';
import { normalizeSurf } from '../worker/src/sources/surf';
import { fetchTelegramChannelHtml, parseTelegramHtml } from '../worker/src/sources/telegram';

const nowMs = Date.now();

export function resolveWorkerBase(env: Record<string, string | undefined> = process.env): string {
  return (env.VITE_API_BASE?.trim() || env.WORKER_URL?.trim() || '').replace(/\/+$/, '');
}

const workerBase = resolveWorkerBase();

// Matches scripts/check-no-cjk.sh exact forbidden CJK character coverage.
const FORBIDDEN_CJK_RE =
  /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}|\p{Script=Bopomofo}|[\u3000-\u303F\u3200-\u32FF\uFE30-\uFE4F\uFF01-\uFFEF]/u;

// README promises a "100% English" feed. The registry carries id/zh channels
// (worker/sources.json), whose raw Telegram text reaches clusters before any
// AI translation, so drop non-Latin / forbidden CJK posts at the snapshot boundary.
const NON_LATIN_SCRIPT_RE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Thai}\u3000-\u303F\u3200-\u32FF\uFE30-\uFE4F\uFF01-\uFFEF]/u;

export function isEnglishText(text: string): boolean {
  return !NON_LATIN_SCRIPT_RE.test(text);
}

/** Last committed feed for the failed-fetch fallback invariant. */
async function readExistingFeed(): Promise<FeedResponse | null> {
  try {
    const raw = await readFile('data/snapshot/feed.json', 'utf8');
    const parsed = JSON.parse(raw) as FeedResponse;
    return Array.isArray(parsed.items) && parsed.items.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

/** Last committed airdrops snapshot for the failed-fetch fallback invariant. */
async function readPriorAirdrops(): Promise<AirdropFeed | null> {
  try {
    const raw = await readFile('data/snapshot/airdrops.json', 'utf8');
    const parsed = JSON.parse(raw) as AirdropFeed;
    return parsed &&
      typeof parsed === 'object' &&
      Array.isArray(parsed.cards) &&
      parsed.cards.length > 0 &&
      typeof parsed.fetchedAt === 'number' &&
      Number.isFinite(parsed.fetchedAt)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/**
 * Resolves a fixture's own historical timestamp instead of stamping `nowMs`,
 * respecting the anti-fixture freshness invariant.
 */
export function resolveFixtureFetchedAt(raw: unknown, priorFetchedAt = 0): number {
  const obj = raw as { fetchedAt?: unknown; active?: { last_status_update?: unknown }[] } | null;
  if (typeof obj?.fetchedAt === 'number' && Number.isFinite(obj.fetchedAt) && obj.fetchedAt > 0) {
    return obj.fetchedAt;
  }
  let maxTsSec = 0;
  if (Array.isArray(obj?.active)) {
    for (const p of obj.active) {
      const ts = Number(p?.last_status_update);
      if (Number.isFinite(ts) && ts > maxTsSec) maxTsSec = ts;
    }
  }
  if (maxTsSec > 0) return maxTsSec * 1000;
  return Number.isFinite(priorFetchedAt) && priorFetchedAt > 0 ? priorFetchedAt : 0;
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
 * Selects the feed snapshot to publish: preserves live drops whenever at least
 * one live channel succeeded AND produced items. Falls back to the prior
 * committed feed only when all live channels failed or live drops are empty.
 */
export function selectFeedOutput(
  liveFeed: FeedResponse,
  liveChannelsSucceeded: number,
  existingFeed: FeedResponse | null,
): FeedResponse {
  if (liveChannelsSucceeded > 0 && Array.isArray(liveFeed.items) && liveFeed.items.length > 0) {
    const cleanLiveItems = filterGamblingFeedItems(liveFeed.items);
    if (cleanLiveItems.length > 0) {
      return cleanLiveItems === liveFeed.items ? liveFeed : { ...liveFeed, items: cleanLiveItems };
    }
  }
  if (existingFeed && Array.isArray(existingFeed.items) && existingFeed.items.length > 0) {
    const cleanPriorItems = filterGamblingFeedItems(existingFeed.items);
    if (cleanPriorItems.length > 0) {
      return cleanPriorItems === existingFeed.items ? existingFeed : { ...existingFeed, items: cleanPriorItems };
    }
  }
  throw new Error(
    'All Telegram fetches failed or yielded zero live items and no committed data/snapshot/feed.json exists — refusing to publish empty/fixture feed',
  );
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

export interface LiveTelegramCollection {
  channelPosts: Map<string, { handle: string; posts: MergePost[] }>;
  healthMap: Map<string, SourceHealth>;
  liveChannelsSucceeded: number;
}

/**
 * Scrapes live Telegram preview pages for `batch`. Throws on empty HTTP-200
 * pages (0 parsed messages, matching `worker/src/sources/telegram.ts`), marks
 * failed channels `down`, and never contaminates live results with per-channel
 * fixture HTML.
 */
export async function collectLiveTelegramPosts(
  batch: readonly { handle: string }[],
  runNowMs: number,
  fetchHtml: (handle: string) => Promise<string> = fetchTelegramChannelHtml,
): Promise<LiveTelegramCollection> {
  const healthMap = new Map<string, SourceHealth>();
  const channelPosts = new Map<string, { handle: string; posts: MergePost[] }>();
  let liveChannelsSucceeded = 0;

  await Promise.allSettled(
    batch.map(async src => {
      const id = `telegram:${src.handle}`;
      try {
        const html = await fetchHtml(src.handle);
        const posts = await parseTelegramHtml(html, src.handle);
        if (posts.length === 0) {
          throw new Error(`0 messages parsed for ${src.handle}`);
        }
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
        healthMap.set(id, {
          id,
          platform: 'telegram',
          handle: src.handle,
          status: 'ok',
          lastOkAt: runNowMs,
        });
        liveChannelsSucceeded++;
      } catch {
        healthMap.set(id, {
          id,
          platform: 'telegram',
          handle: src.handle,
          status: 'down',
          lastOkAt: null,
        });
      }
    }),
  );

  return { channelPosts, healthMap, liveChannelsSucceeded };
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS * 2),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function isValidAirdropsPayload(data: unknown): data is AirdropFeed {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const d = data as { cards?: unknown; fetchedAt?: unknown };
  return Array.isArray(d.cards) && d.cards.length > 0 && typeof d.fetchedAt === 'number' && Number.isFinite(d.fetchedAt);
}

export interface BuildAirdropsDeps {
  workerBase?: string;
  nowMs?: number;
  fetchWorker?: (url: string) => Promise<Response>;
  fetchLive?: (nowMs: number) => Promise<AirdropFeed>;
  readPrior?: () => Promise<AirdropFeed | null>;
  readFixture?: () => Promise<unknown>;
  protocolsRawPromise?: Promise<unknown>;
  airdropAlertRawPromise?: Promise<unknown>;
  onOutcomes?: (outcomes: CuratedSourceOutcome[]) => void;
}

export async function buildAirdrops(deps: BuildAirdropsDeps = {}): Promise<AirdropFeed> {
  const base = deps.workerBase ?? workerBase;
  const runNowMs = deps.nowMs ?? nowMs;
  const fetchWorker =
    deps.fetchWorker ??
    ((url: string) =>
      fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS * 2),
      }));
  const fetchLive =
    deps.fetchLive ??
    (async (ts: number): Promise<AirdropFeed> => {
      const defiLlamaRaw = deps.protocolsRawPromise ? await deps.protocolsRawPromise.catch(() => null) : null;
      const defiLlamaFeed = defiLlamaRaw ? extractDefiLlamaTokenlessAirdrops(defiLlamaRaw, ts) : null;
      const { feed, outcomes } = await buildCuratedAirdropFeed({
        nowMs: ts,
        defiLlamaFeed,
        fetchers: deps.airdropAlertRawPromise
          ? {
              airdropalert: async () => {
                const raw = await deps.airdropAlertRawPromise;
                const parsed = parseWpCalendarToAirdropFeed(raw, ts);
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
      deps.onOutcomes?.(outcomes);
      return feed;
    });
  const readPrior = deps.readPrior ?? readPriorAirdrops;
  const readFixture =
    deps.readFixture ??
    (async () => JSON.parse(await readFile('worker/test/fixtures/surf-airdrops.json', 'utf8')) as unknown);

  if (base) {
    try {
      const res = await fetchWorker(`${base}/airdrops.json`);
      if (res.ok) {
        const parsed: unknown = await res.json();
        if (isValidAirdropsPayload(parsed)) {
          const clean = filterGamblingAirdropFeed(parsed);
          if (clean.cards.length > 0) return clean;
        }
        console.warn('Worker airdrops payload invalid, using local fallback');
      }
    } catch (err) {
      console.warn('Worker airdrops read failed, using local fallback:', err);
    }
  }
  try {
    return filterGamblingAirdropFeed(await fetchLive(runNowMs));
  } catch (err) {
    console.warn('All curated airdrop fetches failed, falling back to prior/fixture:', err);
    const prior = await readPrior();
    if (prior) {
      const cleanPrior = filterGamblingAirdropFeed(prior);
      if (cleanPrior.cards.length > 0) return cleanPrior;
    }
    const raw = await readFixture();
    const fixtureFetchedAt = resolveFixtureFetchedAt(raw);
    return filterGamblingAirdropFeed(normalizeSurf(raw, fixtureFetchedAt));
  }
}

/**
 * Validates a `/markets.json` payload fetched from the Worker before accepting
 * it as a snapshot: requires non-empty `sections` (each with string `id` and
 * `rows` array, including non-empty `crypto` and `defi`) and a `sectors` array.
 */
export function isValidMarketsPayload(data: unknown): data is MarketsResponse {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const d = data as { sections?: unknown; sectors?: unknown };
  if (!Array.isArray(d.sections) || d.sections.length === 0 || !Array.isArray(d.sectors)) {
    return false;
  }
  const byId = new Map<string, MarketSection>();
  for (const item of d.sections) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const sec = item as MarketSection;
    if (typeof sec.id !== 'string' || !Array.isArray(sec.rows)) return false;
    byId.set(sec.id, sec);
  }
  const crypto = byId.get('crypto');
  const defi = byId.get('defi');
  return Boolean(crypto && crypto.rows.length > 0 && defi && defi.rows.length > 0);
}

/**
 * Section-level failed-fetch invariant (#5): a run where any section's fetch
 * failed must not overwrite the committed markets.json with a reduced payload.
 * Keeps the prior committed section for every missing id; null only when a
 * required section is missing AND has no committed predecessor (caller throws).
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

export function mergeMarketsWithPrior(
  freshSections: MarketSection[],
  freshSectors: MarketSector[],
  prior: { sections: MarketSection[]; sectors: MarketSector[] },
  requiredIds: readonly MarketSectionId[],
): { sections: MarketSection[]; sectors: MarketSector[] } | null {
  const sections = mergeSectionsWithPrior(freshSections, prior.sections, requiredIds);
  if (!sections) return null;
  const hasFreshCrypto = freshSections.some(s => s.id === 'crypto');
  const retainedCrypto = sections.some(s => s.id === 'crypto');
  const sectors = hasFreshCrypto ? freshSectors : retainedCrypto ? prior.sectors : [];
  return { sections, sectors };
}

/** Last committed markets sections and sectors; tolerates missing/corrupt file. */
async function readPriorMarkets(): Promise<{ sections: MarketSection[]; sectors: MarketSector[] }> {
  try {
    const parsed = JSON.parse(await readFile('data/snapshot/markets.json', 'utf8')) as MarketsResponse;
    const sections = Array.isArray(parsed.sections) ? parsed.sections.filter(s => s && typeof s.id === 'string') : [];
    const sectors = Array.isArray(parsed.sectors) ? parsed.sectors : [];
    return { sections, sectors };
  } catch {
    return { sections: [], sectors: [] };
  }
}

async function buildMarkets(
  protocolsRawPromise?: Promise<unknown>,
): Promise<MarketsResponse | null> {
  if (workerBase) {
    try {
      const res = await fetch(`${workerBase}/markets.json`, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS * 2),
      });
      if (res.ok) {
        const parsed: unknown = await res.json();
        if (isValidMarketsPayload(parsed)) return parsed;
        console.warn('Worker markets payload invalid, using local fallback');
      }
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
  } else {
    console.warn('markets section "crypto" rejected:', cryptoRes.reason);
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

  const merged = mergeMarketsWithPrior(fresh, sectors, await readPriorMarkets(), ['crypto', 'defi']);
  if (!merged) return null;
  const defiSec = merged.sections.find(s => s.id === 'defi');
  const sections = defiSec
    ? merged.sections.map(s => (s.id === 'yields' ? enrichYieldRowIcons(s, defiSec) : s))
    : merged.sections;
  return { generatedAt: nowMs, sections, sectors: merged.sectors };
}

/** Matches Worker parseDropPost's guard: ticker fallback applies only when no projectDomain is present. */
export function resolveSnapshotSurfMatch(
  parsed: { projectDomain?: string; ticker?: string },
  surfIndex: SurfIndex,
) {
  return (
    (parsed.projectDomain && surfIndex.byDomain.get(parsed.projectDomain)) ||
    (!parsed.projectDomain && parsed.ticker && surfIndex.byTicker.get(parsed.ticker)) ||
    undefined
  );
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
  logoIndex?: FeedLogoIndex | null;
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
    cleanedLinks,
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
  const logo = resolveFeedItemLogo(
    { project: acc.project, domain: acc.domain, ticker: acc.ticker, riskLevel: safety.level },
    ctx.logoIndex,
  );
  const verifiedDomain = !acc.domain || ctx.allKnownDomains.has(acc.domain.toLowerCase());
  return {
    id: acc.id,
    project: acc.project,
    ...(acc.ticker ? { ticker: acc.ticker } : {}),
    ...(acc.domain ? { domain: acc.domain } : {}),
    ...(logo ? { logo } : {}),
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
    verifiedDomain,
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
): Promise<{ feed: FeedResponse; sources: SourceHealth[]; liveChannelsSucceeded: number }> {
  if (workerBase) {
    const [fRes, sRes] = await Promise.allSettled([
      fetch(`${workerBase}/feed.json`, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS * 2),
      }),
      fetch(`${workerBase}/sources.json`, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS * 2),
      }),
    ]);
    if (fRes.status === 'fulfilled' && sRes.status === 'fulfilled' && fRes.value.ok && sRes.value.ok) {
      try {
        const feed = (await fRes.value.json()) as FeedResponse;
        const sources = (await sRes.value.json()) as SourceHealth[];
        if (
          feed &&
          typeof feed === 'object' &&
          Array.isArray(feed.items) &&
          feed.items.length > 0 &&
          Array.isArray(sources) &&
          sources.length > 0
        ) {
          const cleanItems = filterGamblingFeedItems(feed.items);
          if (cleanItems.length > 0) {
            return {
              feed: cleanItems === feed.items ? feed : { ...feed, items: cleanItems },
              sources,
              liveChannelsSucceeded: sources.filter(s => s.status === 'ok').length || 1,
            };
          }
        }
        console.warn('Worker feed/sources payload empty or invalid, using local fallback');
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

  let dropFeedsSucceeded = 0;
  const feedPostsMap = new Map<string, { handle: string; posts: MergePost[] }>();
  const feedHealthMap = new Map<string, SourceHealth>();

  const [{ channelPosts, healthMap, liveChannelsSucceeded: tgChannelsSucceeded }] = await Promise.all([
    collectLiveTelegramPosts(sampleBatch, nowMs),
    Promise.allSettled(
      dropFeeds.map(async src => {
        const id = `feed:${src.handle}`;
        try {
          const posts =
            src.parser === 'wp_calendar' && airdropAlertRawPromise
              ? parseWpCalendarFeedPayload(await airdropAlertRawPromise)
              : await fetchDropFeedPosts(src, nowMs);
          feedHealthMap.set(id, {
            id,
            platform: 'feed',
            handle: src.handle,
            status: 'ok',
            lastOkAt: nowMs,
          });
          if (posts.length > 0) {
            dropFeedsSucceeded++;
            feedPostsMap.set(id, {
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
          feedHealthMap.set(id, {
            id,
            platform: 'feed',
            handle: src.handle,
            status: 'down',
            lastOkAt: null,
          });
        }
      }),
    ),
  ]);

  for (const [id, entry] of feedPostsMap) {
    channelPosts.set(id, entry);
  }
  for (const [id, health] of feedHealthMap) {
    healthMap.set(id, health);
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

  const liveChannelsSucceeded = tgChannelsSucceeded + dropFeedsSucceeded;
  const clusters = new Map<string, SnapshotAccCluster>();
  const cutoff = nowMs - 14 * 86_400_000;

  // Deterministic merge before clustering: caps (summary pick, links 6,
  // sources 10) no longer depend on channel completion order.
  const merged = fixtureFallbackNeeded(channelPosts) ? [] : mergePostsStable([...channelPosts.values()], cutoff);
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
    const surfMatch = resolveSnapshotSurfMatch(parsed, surfIndex);

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
  const logoIndex = buildFeedLogoIndex(airdrops, defiSection);
  const finalizeCtx: FinalizeSnapshotClusterCtx = {
    projectDomains,
    platformDomains,
    allKnownDomains,
    logoIndex,
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
    liveChannelsSucceeded,
  };
}

export interface SnapshotBundle {
  airdrops: AirdropFeed;
  markets: MarketsResponse;
  feed: FeedResponse;
  sources: SourceHealth[];
}

export interface SerializedSnapshotBundle {
  airdropsJson: string;
  marketsJson: string;
  feedJson: string;
  sourcesJson: string;
}

export function validateSnapshotBundle(bundle: SnapshotBundle): SerializedSnapshotBundle {
  if (!Array.isArray(bundle.airdrops?.cards) || bundle.airdrops.cards.length === 0) {
    throw new Error('Snapshot validation failed: airdrops.cards is empty');
  }
  if (!Array.isArray(bundle.markets?.sections) || bundle.markets.sections.length === 0) {
    throw new Error('Snapshot validation failed: markets.sections is empty');
  }
  if (!Array.isArray(bundle.feed?.items) || bundle.feed.items.length === 0) {
    throw new Error('Snapshot validation failed: feed.items is empty');
  }
  if (!Array.isArray(bundle.sources) || bundle.sources.length === 0) {
    throw new Error('Snapshot validation failed: sources is empty');
  }

  const serialized: SerializedSnapshotBundle = {
    airdropsJson: JSON.stringify(bundle.airdrops),
    marketsJson: JSON.stringify(bundle.markets),
    feedJson: JSON.stringify(bundle.feed),
    sourcesJson: JSON.stringify(bundle.sources),
  };

  for (const [name, json] of [
    ['airdrops.json', serialized.airdropsJson],
    ['markets.json', serialized.marketsJson],
    ['feed.json', serialized.feedJson],
    ['sources.json', serialized.sourcesJson],
  ] as const) {
    if (FORBIDDEN_CJK_RE.test(json)) {
      throw new Error(`Snapshot validation failed: forbidden CJK character found in ${name}`);
    }
  }

  const gamblingViolations = [
    ...findGamblingAirdropViolations(bundle.airdrops),
    ...findGamblingFeedViolations(bundle.feed),
  ];
  if (gamblingViolations.length > 0) {
    throw new Error(
      `Snapshot validation failed: gambling/betting entries found (${gamblingViolations.slice(0, 5).join('; ')})`,
    );
  }

  return serialized;
}

export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  await writeFile(tmpPath, content, 'utf8');
  try {
    await rename(tmpPath, filePath);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}

// import.meta.main guard: the test file imports this module for helpers
// and must not re-run the pipeline.
if (import.meta.main) {
  await runSnapshot();
}

async function runSnapshot(): Promise<void> {
  await mkdir('data/snapshot', { recursive: true });
  // Share single DefiLlama protocols & AirdropAlert calendar fetches concurrently
  // across airdrops, markets, and drop feeds without pre-awaiting serially.
  const sharedProtocolsPromise = workerBase ? undefined : fetchJson('https://api.llama.fi/protocols');
  const airdropAlertUrl = getSeedSourceById('feed:airdropalert_calendar')?.url ?? AIRDROPALERT_CALENDAR_URL;
  const sharedAirdropAlertPromise = workerBase ? undefined : fetchJson(airdropAlertUrl);
  sharedProtocolsPromise?.catch(() => {});
  sharedAirdropAlertPromise?.catch(() => {});
  let curatedOutcomes: CuratedSourceOutcome[] = [];
  const [airdrops, markets] = await Promise.all([
    buildAirdrops({
      protocolsRawPromise: sharedProtocolsPromise,
      airdropAlertRawPromise: sharedAirdropAlertPromise,
      onOutcomes: outcomes => {
        curatedOutcomes = outcomes;
      },
    }),
    buildMarkets(sharedProtocolsPromise),
  ]);
  // Never publish empty payloads: a total fetch failure must keep the last
  // committed snapshot instead of wiping markets (or the feed) to `[]`.
  if (!markets) {
    throw new Error('All market fetches failed and no committed section could be reused — refusing to overwrite data/snapshot/markets.json');
  }
  const { feed, sources, liveChannelsSucceeded } = await buildDropsAndSources(
    airdrops,
    markets,
    curatedOutcomes,
    sharedAirdropAlertPromise,
  );
  const existingFeed = liveChannelsSucceeded > 0 && feed.items.length > 0 ? null : await readExistingFeed();
  const feedOut = selectFeedOutput(feed, liveChannelsSucceeded, existingFeed);

  const { airdropsJson, marketsJson, feedJson, sourcesJson } = validateSnapshotBundle({
    airdrops,
    markets,
    feed: feedOut,
    sources,
  });

  await writeFileAtomic('data/snapshot/airdrops.json', airdropsJson);
  await writeFileAtomic('data/snapshot/markets.json', marketsJson);
  await writeFileAtomic('data/snapshot/feed.json', feedJson);
  await writeFileAtomic('data/snapshot/sources.json', sourcesJson);
  console.log(
    `Wrote snapshots: airdrops=${airdrops.cards.length}, markets=${markets.sections.length}, feed=${feedOut.items.length}, sources=${sources.length}`,
  );
}
