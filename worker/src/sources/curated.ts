import type { AirdropFeed, Badge, Card, FitKey, Grade, Tge } from '../../../shared/types';
import { fmtUsd } from '../lib/format';
import { normalizeProjectKey } from '../normalize/cluster';
import {
  cleanUrl,
  getRegistrableDomain,
  isCuratedAggregatorDomain,
  isPlatformDomain,
} from '../normalize/domains';
import { stripOrTranslateCjk } from '../normalize/i18n';
import { URL_SHORTENERS } from '../safety/shorteners';
import {
  AIRDROPALERT_CALENDAR_URL,
  MERKL_OPPORTUNITIES_URL,
  PENDLE_POINTS_URL,
  fetchMerklOpportunities,
  fetchPendlePoints,
  fetchWpCalendarAirdrops,
} from './feeds';
import { resolveCuratedSourceUrl, type SourceConfig } from './registry';
import { ARNDXT_SHEET_URL, ASSO7878_SHEET_URL, fetchArndxtSheet, fetchAsso7878Sheet } from './sheets';
import { SURF_AIRDROPS_URL, fetchSurfAirdrops } from './surf';

interface ValidLlamaProtocolItem {
  slug?: unknown;
  name: string;
  symbol: '-';
  category?: string | null;
  chains?: unknown;
  chain?: unknown;
  tvl: number;
  listedAt?: unknown;
  url?: unknown;
}

function isValidLlamaProtocolItem(entry: unknown): entry is ValidLlamaProtocolItem {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const p = entry as Record<string, unknown>;
  if (typeof p.name !== 'string' || p.name.trim().length === 0) return false;
  if (p.symbol !== '-') return false;
  if (p.category != null && typeof p.category !== 'string') return false;
  if (typeof p.category === 'string' && DEFILLAMA_EXCLUDED_CATEGORIES.has(p.category.trim().toLowerCase())) {
    return false;
  }
  if (typeof p.tvl !== 'number' || !Number.isFinite(p.tvl) || p.tvl < DEFILLAMA_MIN_TVL_USD) return false;
  return true;
}

const DEFILLAMA_MIN_TVL_USD = 5_000_000;
const DEFILLAMA_MAX_CARDS = 80;
const DEFILLAMA_RECENT_WINDOW_SEC = 365 * 86_400;
const DEFILLAMA_EXCLUDED_CATEGORIES = new Set([
  'cex',
  'canonical bridge',
  'chain',
  'cefi',
  'custody',
  'treasury manager',
  'rwa',
]);

function mapLlamaCategoryType(category?: string): string {
  const lower = (category ?? '').toLowerCase();
  if (lower.includes('deriv') || lower.includes('perp') || lower.includes('dex') || lower.includes('option')) {
    return 'trading';
  }
  if (lower.includes('lend') || lower.includes('yield') || lower.includes('stak') || lower.includes('cdp')) {
    return 'staking';
  }
  if (lower.includes('bridge')) return 'mainnet';
  return 'liquidity';
}

function slugify(raw: string): string {
  return (
    raw
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'protocol'
  );
}

/**
 * Extracts active tokenless protocols (`symbol === "-"`, TVL >= $5M, non-CEX)
 * from the already-fetched `api.llama.fi/protocols` payload (0 extra requests).
 */
export function extractDefiLlamaTokenlessAirdrops(raw: unknown, nowMs = Date.now()): AirdropFeed {
  if (!Array.isArray(raw)) {
    return { cards: [], tge: [], counts: { active: 0, preToken: 0 }, fetchedAt: nowMs };
  }

  const recentCutoffSec = nowMs / 1000 - DEFILLAMA_RECENT_WINDOW_SEC;
  const filtered = raw
    .filter(isValidLlamaProtocolItem)
    .sort((a, b) => b.tvl - a.tvl)
    .slice(0, DEFILLAMA_MAX_CARDS);

  const cards: Card[] = [];
  for (const p of filtered) {
    const name = stripOrTranslateCjk(p.name);
    if (!name) continue;
    const tvl = p.tvl;
    const category = stripOrTranslateCjk(p.category ?? 'DeFi') || 'DeFi';
    const rawChains = Array.isArray(p.chains)
      ? p.chains
          .filter((c): c is string => typeof c === 'string')
          .map(c => stripOrTranslateCjk(c))
          .filter(Boolean)
      : [];
    const chains =
      rawChains.length > 0
        ? rawChains
        : typeof p.chain === 'string'
          ? [stripOrTranslateCjk(p.chain)].filter(Boolean)
          : [];
    const url = typeof p.url === 'string' ? cleanUrl(p.url) : null;
    const isRecentlyListed =
      typeof p.listedAt === 'number' && Number.isFinite(p.listedAt) && p.listedAt >= recentCutoffSec;
    const grade: Grade = tvl >= 100_000_000 ? 'S' : tvl >= 30_000_000 ? 'A' : tvl >= 10_000_000 ? 'B' : 'C';
    const sc = grade === 'S' ? 84 : grade === 'A' ? 74 : grade === 'B' ? 62 : 50;
    const badges: Badge[] = isRecentlyListed ? ['live', 'early'] : ['early'];
    const taskType = mapLlamaCategoryType(category);
    const taskTitle = `Use tokenless ${category} protocol (${fmtUsd(tvl)} TVL)`;
    const cleanSlug = typeof p.slug === 'string' ? stripOrTranslateCjk(p.slug) : '';

    cards.push({
      r: cards.length + 1,
      n: name,
      id: `defillama:${cleanSlug || slugify(name)}`,
      chain: chains[0],
      chains: chains.length > 0 ? chains : undefined,
      t: null,
      g: grade,
      b: badges,
      x: null,
      img: '',
      f: '—',
      raiseNum: 0,
      tk: '1/1',
      h: Math.round(tvl / 1_000_000),
      u: 'today',
      updatedTs: Math.floor(nowMs / 1000),
      fit: ['small', 'climber'],
      best: {
        n: taskTitle,
        ty: taskType,
        c: 'On-chain',
        m: '—',
      },
      costNum: 10,
      taskTypes: [taskType],
      tasks: [
        {
          title: taskTitle,
          type: taskType,
          status: 'OPEN',
          cost: 10,
          timeMinutes: null,
          url,
        },
      ],
      sc,
      sub: [grade === 'S' ? 9 : 7, 7, null],
      url,
      source: 'DefiLlama',
    });
  }

  return {
    cards,
    tge: [],
    counts: { active: cards.length, preToken: cards.length },
    fetchedAt: nowMs,
  };
}

const UNTRUSTED_SHEET_SOURCES = new Set(['asso7878', 'arndxt']);

function isUntrustedSheetSource(source?: string): boolean {
  return Boolean(source && UNTRUSTED_SHEET_SOURCES.has(source.trim().toLowerCase()));
}

function eligibleProjectDomains(card: Card): string[] {
  const domains: string[] = [];
  const seen = new Set<string>();
  const candidates = [card.url, ...(card.tasks?.map(t => t.url) ?? [])];
  for (const raw of candidates) {
    if (!raw) continue;
    const dom = getRegistrableDomain(raw)?.toLowerCase();
    if (!dom || seen.has(dom) || isPlatformDomain(dom) || URL_SHORTENERS[dom] || isCuratedAggregatorDomain(dom, card)) {
      continue;
    }
    seen.add(dom);
    domains.push(dom);
  }
  return domains;
}

function canonicalProjectDomain(card: Card): string | null {
  return eligibleProjectDomains(card)[0] ?? null;
}

function mergeSecondaryIntoPrimary(primary: Card, secondary: Card): Card {
  const merged: Card = {
    ...primary,
    b: [...primary.b],
    fit: [...primary.fit],
  };

  // Editable public sheets (ASSO7878 / arndxt) must never inject foreign domains
  // onto higher-trust primary cards (Surf / DefiLlama / etc.), otherwise
  // collectKnownDomainEntries would elevate untrusted sheet URLs to verified status.
  const secondaryIsUntrustedSheet =
    isUntrustedSheetSource(secondary.source) && !isUntrustedSheetSource(primary.source);
  let primaryDomains: Set<string> | null = null;
  if (secondaryIsUntrustedSheet) {
    primaryDomains = new Set<string>();
    for (const raw of [primary.url, ...(primary.tasks?.map(t => t.url) ?? [])]) {
      if (!raw) continue;
      const dom = getRegistrableDomain(raw);
      if (dom) primaryDomains.add(dom.toLowerCase());
    }
  }

  if (!merged.url && secondary.url) {
    if (!secondaryIsUntrustedSheet) {
      merged.url = secondary.url;
    } else {
      const secDom = getRegistrableDomain(secondary.url)?.toLowerCase();
      if (secDom && primaryDomains?.has(secDom)) {
        merged.url = secondary.url;
      }
    }
  }
  if ((!merged.raiseNum || merged.raiseNum <= 0) && secondary.raiseNum && secondary.raiseNum > 0) {
    merged.raiseNum = secondary.raiseNum;
    merged.f = secondary.f;
  }
  if (!merged.chain && secondary.chain) merged.chain = secondary.chain;
  if ((!merged.chains || merged.chains.length === 0) && secondary.chains?.length) {
    merged.chains = [...secondary.chains];
  }
  if (!merged.img && secondary.img) merged.img = secondary.img;

  const badgeSet = new Set(merged.b);
  for (const b of secondary.b) {
    if (b === 'token' && !badgeSet.has('token')) continue;
    if (b === 'zero' && (merged.costNum ?? 0) > 0) continue;
    if (!badgeSet.has(b)) {
      badgeSet.add(b);
      merged.b.push(b);
    }
  }
  if (badgeSet.has('risk') && !merged.riskLabel && secondary.riskLabel) {
    merged.riskLabel = secondary.riskLabel;
  }

  const fitSet = new Set(merged.fit);
  for (const f of secondary.fit) {
    if (!fitSet.has(f)) {
      fitSet.add(f);
      merged.fit.push(f as FitKey);
    }
  }

  if ((merged.tasks?.length ?? 0) <= 1 && secondary.tasks && secondary.tasks.length > 0) {
    const existing = merged.tasks ? [...merged.tasks] : [];
    const seenTitles = new Set(existing.map(t => t.title.toLowerCase()));
    for (const st of secondary.tasks) {
      if (existing.length >= 6) break;
      if (seenTitles.has(st.title.toLowerCase())) continue;
      seenTitles.add(st.title.toLowerCase());
      const taskSource =
        st.source ?? (secondary.source && secondary.source !== primary.source ? secondary.source : undefined);
      const taskWithSource = taskSource && st.source !== taskSource ? { ...st, source: taskSource } : st;
      if (secondaryIsUntrustedSheet && taskWithSource.url) {
        const stDom = getRegistrableDomain(taskWithSource.url)?.toLowerCase();
        existing.push(stDom && primaryDomains?.has(stDom) ? taskWithSource : { ...taskWithSource, url: null });
      } else {
        existing.push(taskWithSource);
      }
    }
    merged.tasks = existing;
    merged.tk = `${existing.length}/${existing.length}`;
    const recomputedTypes = [...new Set([...(merged.taskTypes ?? []), ...existing.map(t => t.type)].filter(Boolean))];
    if (recomputedTypes.length > 0) {
      merged.taskTypes = recomputedTypes;
    }
  }

  return merged;
}

/**
 * Merges multiple curated airdrop feeds in priority order (first feed wins on
 * duplicates, e.g. Surf's richer tasks win when Surf is online), deduplicating
 * by canonical non-platform domain and normalized project name.
 */
export function mergeCuratedAirdropFeeds(feeds: AirdropFeed[], nowMs = Date.now()): AirdropFeed {
  const mergedCards: Card[] = [];
  const byDomain = new Map<string, number>();
  const byName = new Map<string, number>();

  for (const feed of feeds) {
    for (const card of feed.cards) {
      const dom = canonicalProjectDomain(card);
      const nameKey = normalizeProjectKey(card.n);

      let matchIdx: number | undefined;
      if (dom && byDomain.has(dom)) {
        matchIdx = byDomain.get(dom);
      } else if (nameKey.length >= 3 && byName.has(nameKey)) {
        matchIdx = byName.get(nameKey);
      }

      if (matchIdx !== undefined) {
        const merged = mergeSecondaryIntoPrimary(mergedCards[matchIdx], card);
        mergedCards[matchIdx] = merged;
        for (const mergedDom of eligibleProjectDomains(merged)) {
          if (!byDomain.has(mergedDom)) byDomain.set(mergedDom, matchIdx);
        }
        if (nameKey.length >= 3 && !byName.has(nameKey)) byName.set(nameKey, matchIdx);
        continue;
      }

      const nextIdx = mergedCards.length;
      const nextCard = { ...card };
      mergedCards.push(nextCard);
      for (const cardDom of eligibleProjectDomains(nextCard)) {
        if (!byDomain.has(cardDom)) byDomain.set(cardDom, nextIdx);
      }
      if (nameKey.length >= 3) byName.set(nameKey, nextIdx);
    }
  }

  mergedCards.sort(
    (a, b) =>
      b.sc - a.sc ||
      (b.raiseNum ?? 0) - (a.raiseNum ?? 0) ||
      (a.n < b.n ? -1 : a.n > b.n ? 1 : 0) ||
      ((a.id ?? '') < (b.id ?? '') ? -1 : (a.id ?? '') > (b.id ?? '') ? 1 : 0),
  );

  const rankedCards = mergedCards.map((c, idx) => ({ ...c, r: idx + 1 }));

  const mergedTge: Tge[] = [];
  const seenTge = new Set<string>();
  for (const feed of feeds) {
    for (const entry of feed.tge) {
      const key = normalizeProjectKey(entry.n);
      if (!key || seenTge.has(key)) continue;
      seenTge.add(key);
      mergedTge.push({ ...entry });
    }
  }

  return {
    cards: rankedCards,
    tge: mergedTge,
    counts: {
      active: rankedCards.length,
      preToken: rankedCards.filter(c => !c.b.includes('token')).length,
    },
    fetchedAt: nowMs,
  };
}

export interface CuratedAirdropOptions {
  nowMs?: number;
  surfUrl?: string;
  asso7878Url?: string;
  arndxtUrl?: string;
  pendleUrl?: string;
  merklUrl?: string;
  airdropAlertUrl?: string;
  sourceRegistry?: ReadonlyMap<string, SourceConfig>;
  defiLlamaFeed?: AirdropFeed | null;
  cachedAsso7878Feed?: AirdropFeed | null;
  cachedArndxtFeed?: AirdropFeed | null;
  prevFeed?: AirdropFeed | null;
  disabledSourceIds?: Set<string>;
  deferredSourceIds?: Set<string>;
  onOutcomes?: (outcomes: CuratedSourceOutcome[]) => Promise<void> | void;
  fetchers?: {
    surf?: () => Promise<AirdropFeed>;
    asso7878?: () => Promise<AirdropFeed>;
    arndxt?: () => Promise<AirdropFeed>;
    pendle?: () => Promise<AirdropFeed>;
    merkl?: () => Promise<AirdropFeed>;
    airdropalert?: () => Promise<AirdropFeed>;
  };
}

export interface CuratedSourceOutcome {
  sourceId?: string;
  name: string;
  ok: boolean;
  cards: number;
  tge: number;
  error?: string;
}

export interface CuratedAirdropResult {
  feed: AirdropFeed;
  outcomes: CuratedSourceOutcome[];
}

function hasSourceLabel(source?: string): boolean {
  return typeof source === 'string' && source.trim().length > 0;
}

/**
 * Stamps `source: 'Surf'` on legacy cached airdrop cards and TGE entries that
 * predate multi-source tagging, leaving existing non-empty source values untouched.
 */
export function backfillLegacyAirdropSources(feed: AirdropFeed): AirdropFeed {
  let changed = false;
  const cards = Array.isArray(feed.cards)
    ? feed.cards.map(c => {
        if (hasSourceLabel(c.source)) return c;
        changed = true;
        return { ...c, source: 'Surf' };
      })
    : [];
  const tge = Array.isArray(feed.tge)
    ? feed.tge.map(t => {
        if (hasSourceLabel(t.source)) return t;
        changed = true;
        return { ...t, source: 'Surf' };
      })
    : [];
  return changed ? { ...feed, cards, tge } : feed;
}

function stripExcludedMergedTasks(card: Card, excludedTaskSources?: ReadonlySet<string>): Card {
  if (!excludedTaskSources || excludedTaskSources.size === 0 || !card.tasks?.length) {
    return card;
  }
  const keptTasks = card.tasks.filter(t => !t.source || !excludedTaskSources.has(t.source.trim().toLowerCase()));
  if (keptTasks.length === card.tasks.length) return card;
  const nextTaskTypes =
    keptTasks.length > 0
      ? [...new Set(keptTasks.map(t => t.type).filter(Boolean))]
      : card.best?.ty
        ? [card.best.ty]
        : [];
  return {
    ...card,
    tasks: keptTasks,
    tk: `${keptTasks.length}/${keptTasks.length}`,
    taskTypes: nextTaskTypes.length > 0 ? nextTaskTypes : card.taskTypes,
  };
}

const CURATED_SOURCE_NAME_BY_ID: Readonly<Record<string, string>> = {
  'sheet:asso7878_sheet': 'asso7878',
  'sheet:arndxt_sheet': 'arndxt',
  'feed:pendle_points': 'pendle',
  'feed:merkl_opportunities': 'merkl',
  'feed:airdropalert_calendar': 'airdropalert',
};

function expandDisabledSources(disabledSourceIds: ReadonlySet<string>): Set<string> {
  const excluded = new Set<string>();
  for (const raw of disabledSourceIds) {
    const key = raw.trim().toLowerCase();
    if (!key) continue;
    excluded.add(key);
    const mapped = CURATED_SOURCE_NAME_BY_ID[key];
    if (mapped) excluded.add(mapped);
  }
  return excluded;
}

function matchesExcludedSource(source: string | undefined, excluded: ReadonlySet<string>): boolean {
  const normalized = hasSourceLabel(source) ? source!.trim().toLowerCase() : 'surf';
  return excluded.has(normalized);
}

/**
 * Removes cards, TGE entries, and merged secondary tasks belonging to any
 * disabled source ID or raw source name, renumbering surviving ranks and
 * recomputing counts while keeping `fetchedAt` intact.
 */
export function filterAirdropFeedByDisabledSources(
  feed: AirdropFeed,
  disabledSourceIds: ReadonlySet<string>,
): AirdropFeed {
  if (disabledSourceIds.size === 0) return feed;
  const excluded = expandDisabledSources(disabledSourceIds);
  if (excluded.size === 0) return feed;

  const origCards = Array.isArray(feed.cards) ? feed.cards : [];
  const origTge = Array.isArray(feed.tge) ? feed.tge : [];

  let changed = false;
  const keptCards: Card[] = [];
  for (const card of origCards) {
    if (matchesExcludedSource(card.source, excluded)) {
      changed = true;
      continue;
    }
    const stripped = stripExcludedMergedTasks(card, excluded);
    if (stripped !== card) changed = true;
    keptCards.push(stripped);
  }

  const keptTge = origTge.filter(t => !matchesExcludedSource(t.source, excluded));
  if (keptTge.length !== origTge.length) changed = true;

  if (!changed) return feed;

  const rankedCards = keptCards.map((c, idx) => (c.r === idx + 1 ? c : { ...c, r: idx + 1 }));
  return {
    ...feed,
    cards: rankedCards,
    tge: keptTge,
    counts: {
      active: rankedCards.length,
      preToken: rankedCards.filter(c => !c.b?.includes('token')).length,
    },
    fetchedAt: feed.fetchedAt,
  };
}

function slicePrevFeedForSource(
  prevFeed: AirdropFeed | null | undefined,
  sourceName: string,
  excludedTaskSources?: ReadonlySet<string>,
): AirdropFeed | null {
  if (!prevFeed) return null;
  const isSurf = sourceName === 'Surf';
  const cards = (prevFeed.cards ?? [])
    .filter(c => c.source === sourceName || (isSurf && !hasSourceLabel(c.source)))
    .map(c => {
      const labeled = hasSourceLabel(c.source) ? c : { ...c, source: 'Surf' };
      return stripExcludedMergedTasks(labeled, excludedTaskSources);
    });
  const tge = (prevFeed.tge ?? [])
    .filter(t => t.source === sourceName || (isSurf && !hasSourceLabel(t.source)))
    .map(t => (hasSourceLabel(t.source) ? t : { ...t, source: 'Surf' }));
  if (cards.length === 0 && tge.length === 0) return null;
  return {
    cards,
    tge,
    counts: {
      active: cards.length,
      preToken: cards.filter(c => !c.b.includes('token')).length,
    },
    fetchedAt: prevFeed.fetchedAt,
  };
}

function hasCachedFeedContent(feed?: AirdropFeed | null): feed is AirdropFeed {
  return Boolean(feed && (feed.cards.length > 0 || feed.tge.length > 0));
}

export async function buildCuratedAirdropFeed(opts: CuratedAirdropOptions = {}): Promise<CuratedAirdropResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const reg = opts.sourceRegistry;
  const jobs: { name: string; sourceId?: string; cachedFeed?: AirdropFeed | null; run: () => Promise<AirdropFeed> }[] = [
    {
      name: 'Surf',
      run: opts.fetchers?.surf ?? (() => fetchSurfAirdrops(opts.surfUrl ?? SURF_AIRDROPS_URL, nowMs)),
    },
    {
      name: 'ASSO7878',
      sourceId: 'sheet:asso7878_sheet',
      cachedFeed: opts.cachedAsso7878Feed,
      run:
        opts.fetchers?.asso7878 ??
        (() =>
          fetchAsso7878Sheet(
            resolveCuratedSourceUrl(opts.asso7878Url, 'sheet:asso7878_sheet', ASSO7878_SHEET_URL, reg),
            nowMs,
          )),
    },
    {
      name: 'arndxt',
      sourceId: 'sheet:arndxt_sheet',
      cachedFeed: opts.cachedArndxtFeed,
      run:
        opts.fetchers?.arndxt ??
        (() =>
          fetchArndxtSheet(
            resolveCuratedSourceUrl(opts.arndxtUrl, 'sheet:arndxt_sheet', ARNDXT_SHEET_URL, reg),
            nowMs,
          )),
    },
    {
      name: 'Pendle',
      sourceId: 'feed:pendle_points',
      run:
        opts.fetchers?.pendle ??
        (() =>
          fetchPendlePoints(
            resolveCuratedSourceUrl(opts.pendleUrl, 'feed:pendle_points', PENDLE_POINTS_URL, reg),
            nowMs,
          )),
    },
    {
      name: 'Merkl',
      sourceId: 'feed:merkl_opportunities',
      run:
        opts.fetchers?.merkl ??
        (() =>
          fetchMerklOpportunities(
            resolveCuratedSourceUrl(opts.merklUrl, 'feed:merkl_opportunities', MERKL_OPPORTUNITIES_URL, reg),
            nowMs,
          )),
    },
    {
      name: 'AirdropAlert',
      sourceId: 'feed:airdropalert_calendar',
      run:
        opts.fetchers?.airdropalert ??
        (() =>
          fetchWpCalendarAirdrops(
            resolveCuratedSourceUrl(opts.airdropAlertUrl, 'feed:airdropalert_calendar', AIRDROPALERT_CALENDAR_URL, reg),
            nowMs,
          )),
    },
  ];

  const disabledLower = expandDisabledSources(opts.disabledSourceIds ?? new Set());
  const deferredLower = new Set([...(opts.deferredSourceIds ?? [])].map(s => s.toLowerCase()));

  const jobModes: ('disabled' | 'cached' | 'deferred' | 'live')[] = [];
  const liveIndices: number[] = [];
  const excludedTaskSources = new Set<string>(disabledLower);
  let deferredCount = 0;

  for (let i = 0; i < jobs.length; i++) {
    const matchKey = (jobs[i].sourceId ?? jobs[i].name).toLowerCase();
    const jobNameLower = jobs[i].name.toLowerCase();
    if (disabledLower.has(matchKey) || disabledLower.has(jobNameLower)) {
      jobModes.push('disabled');
      excludedTaskSources.add(jobNameLower);
    } else if (hasCachedFeedContent(jobs[i].cachedFeed)) {
      jobModes.push('cached');
      excludedTaskSources.add(jobNameLower);
    } else if (deferredLower.has(matchKey)) {
      jobModes.push('deferred');
      deferredCount++;
    } else {
      jobModes.push('live');
      liveIndices.push(i);
    }
  }

  const settledLive = await Promise.allSettled(liveIndices.map(idx => jobs[idx].run()));
  const settledByJobIdx = new Map<number, PromiseSettledResult<AirdropFeed>>();
  for (let i = 0; i < liveIndices.length; i++) {
    const idx = liveIndices[i];
    settledByJobIdx.set(idx, settledLive[i]);
    if (settledLive[i].status === 'fulfilled') {
      excludedTaskSources.add(jobs[idx].name.toLowerCase());
    }
  }

  const fulfilledFeeds: AirdropFeed[] = [];
  const outcomes: CuratedSourceOutcome[] = [];
  let liveFulfilledCount = 0;

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const mode = jobModes[i];
    if (mode === 'disabled') continue;
    if (mode === 'cached') {
      const cached = job.cachedFeed!;
      fulfilledFeeds.push(cached);
      outcomes.push({
        name: job.name,
        ok: true,
        cards: cached.cards.length,
        tge: cached.tge.length,
      });
      continue;
    }
    if (mode === 'deferred') {
      const prior = slicePrevFeedForSource(opts.prevFeed, job.name, excludedTaskSources);
      if (prior) fulfilledFeeds.push(prior);
      continue;
    }

    const res = settledByJobIdx.get(i)!;
    if (res.status === 'fulfilled') {
      liveFulfilledCount++;
      fulfilledFeeds.push(res.value);
      outcomes.push({
        sourceId: job.sourceId,
        name: job.name,
        ok: true,
        cards: res.value.cards.length,
        tge: res.value.tge.length,
      });
    } else {
      outcomes.push({
        sourceId: job.sourceId,
        name: job.name,
        ok: false,
        cards: 0,
        tge: 0,
        error: res.reason instanceof Error ? res.reason.message : String(res.reason),
      });
      const prior = slicePrevFeedForSource(opts.prevFeed, job.name, excludedTaskSources);
      if (prior) fulfilledFeeds.push(prior);
    }
  }

  if (opts.defiLlamaFeed && opts.defiLlamaFeed.cards.length > 0) {
    fulfilledFeeds.push(opts.defiLlamaFeed);
    outcomes.push({
      name: 'DefiLlama',
      ok: true,
      cards: opts.defiLlamaFeed.cards.length,
      tge: opts.defiLlamaFeed.tge.length,
    });
  }

  if (opts.onOutcomes) {
    await opts.onOutcomes(outcomes);
  }

  if (liveFulfilledCount === 0 && !(liveIndices.length === 0 && deferredCount > 0)) {
    throw new Error('All curated airdrop sources failed');
  }

  const merged = mergeCuratedAirdropFeeds(fulfilledFeeds, nowMs);
  if (merged.cards.length === 0) {
    throw new Error('Curated airdrop sources returned zero cards');
  }

  return { feed: merged, outcomes };
}
