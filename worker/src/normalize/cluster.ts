import type {
  AirdropFeed,
  FeedItem,
  FeedResponse,
  FeedSourceRef,
  Grade,
  MarketSection,
  RiskLevel,
  SourceHealth,
  TaskType,
} from '../../../shared/types';
import { isGamblingFeedItem, isGamblingPost } from '../../../shared/gamblingFilter';
import { sha1Hex } from '../lib/hash';
import { safeHttpsUrl } from '../lib/url';
import {
  evaluateSafety,
  getTrustedSurfCardDomain,
  isUntrustedSheetSource,
  isUnverifiedRegistryReason,
  reconcileSafetyReasons,
  UNVERIFIED_REGISTRY_REASON_PREFIX,
} from '../safety';
import {
  getRegistrableDomain,
  isCuratedAggregatorDomain,
  isNewsDomain,
  isPlatformDomain,
  selectFeedLinks,
} from './domains';
import { stripOrTranslateCjk } from './i18n';
import {
  buildRuleSummary,
  parseDropPost,
  type ParseContext,
  type ParsedDrop,
  type RichDropMeta,
  type SurfMatch,
} from './parse';
import { computeScore } from './score';
import {
  classifyDropRelevance,
  cleanSummaryText,
  detectNonEnglishLatin,
  isStopName,
  MAJOR_TICKERS,
  truncateAtWordBoundary,
} from './text';

const THREE_DAYS_MS = 3 * 86_400_000;
const SEVEN_DAYS_MS = 7 * 86_400_000;

const FEED_BATCH_SIZE = 100;
const FEED_MAX_BATCHES = 5;
const MAX_CLUSTER_URLS = 32;

const fallbackQueues = new WeakMap<D1Database, Map<string, Promise<void>>>();

async function withFallbackLock<T>(
  db: D1Database,
  key: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  if (!key) return fn();
  let dbMap = fallbackQueues.get(db);
  if (!dbMap) {
    dbMap = new Map();
    fallbackQueues.set(db, dbMap);
  }
  const prev = dbMap.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const chained = prev.then(() => gate, () => gate);
  dbMap.set(key, chained);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (dbMap.get(key) === chained) {
      dbMap.delete(key);
    }
  }
}

const LEGACY_BLOCKED_DOMAINS = new Set<string>([
  'whale-alert.io',
  'dropstab.com',
  'pump.fun',
  'chungdailynote.com',
  'ranked.plus',
]);

export interface SurfIndex {
  byDomain: Map<string, SurfMatch>;
  byTicker: Map<string, SurfMatch>;
  byName?: Map<string, SurfMatch>;
}

export function buildSurfIndex(feed?: AirdropFeed | null): SurfIndex {
  const byDomain = new Map<string, SurfMatch>();
  const byTicker = new Map<string, SurfMatch>();
  const byName = new Map<string, SurfMatch>();
  if (!feed) return { byDomain, byTicker, byName };

  for (const card of feed.cards) {
    if (card.b?.includes('risk') || isUntrustedSheetSource(card.source)) continue;
    const logo = safeHttpsUrl(card.img) ?? undefined;
    const match: SurfMatch = {
      name: card.n,
      tier: card.g,
      cardRank: card.r,
      ...(logo ? { logo } : {}),
    };
    if (card.t) {
      const upper = card.t.toUpperCase();
      if (!byTicker.has(upper)) byTicker.set(upper, match);
    }
    const dom = getTrustedSurfCardDomain(card);
    if (dom && !byDomain.has(dom)) byDomain.set(dom, match);
    const nameKey = normalizeProjectKey(card.n);
    if (nameKey.length >= 3 && !byName.has(nameKey)) byName.set(nameKey, match);
  }
  return { byDomain, byTicker, byName };
}

/** A trusted Radar card (or DefiLlama protocol row) a Live Drops item can be linked back to. */
export interface RadarCardRef {
  /** Stable Radar card id (`card.id`); null for DefiLlama rows, which are not Radar cards. */
  id: string | null;
  name: string;
  /** Trusted registrable domain of the card, when it has one. */
  domain?: string;
  ticker?: string;
  logo?: string;
  /** Total raise (`card.f`); absent when the card shows no funding. */
  funding?: string;
  tvlUsd?: number;
}

export interface FeedLogoIndex {
  byDomain: Map<string, string>;
  byTicker: Map<string, string>;
  byName: Map<string, string>;
  /** Radar cards by trusted domain / project key / ticker, built together with the logo maps. */
  radarByDomain?: Map<string, RadarCardRef>;
  radarByName?: Map<string, RadarCardRef>;
  radarByTicker?: Map<string, RadarCardRef>;
}

function positiveUsd(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Builds a lightweight in-memory HTTPS logo and Radar-card lookup from trusted
 * Surf/curated airdrop cards, TGE entries, and DefiLlama protocols. Strictly
 * excludes risk cards, editable public sheets (ASSO7878 / arndxt), and
 * non-HTTPS URLs.
 */
export function buildFeedLogoIndex(
  airdrops?: AirdropFeed | null,
  defiSection?: MarketSection | null,
): FeedLogoIndex {
  const byDomain = new Map<string, string>();
  const byTicker = new Map<string, string>();
  const byName = new Map<string, string>();
  const radarByDomain = new Map<string, RadarCardRef>();
  const radarByName = new Map<string, RadarCardRef>();
  const radarByTicker = new Map<string, RadarCardRef>();

  const indexRadar = (ref: RadarCardRef, dom: string | undefined): void => {
    if (dom) {
      const existing = radarByDomain.get(dom);
      if (!existing) {
        radarByDomain.set(dom, ref);
      } else if (existing.tvlUsd === undefined && ref.tvlUsd !== undefined) {
        existing.tvlUsd = ref.tvlUsd;
      }
    }
    if (ref.ticker && !radarByTicker.has(ref.ticker)) radarByTicker.set(ref.ticker, ref);
    const nameKey = normalizeProjectKey(ref.name);
    if (nameKey.length >= 3 && !radarByName.has(nameKey)) radarByName.set(nameKey, ref);
  };

  if (airdrops) {
    for (const card of airdrops.cards ?? []) {
      if (card.b?.includes('risk') || isUntrustedSheetSource(card.source)) continue;
      const logo = safeHttpsUrl(card.img) ?? undefined;
      const dom = getTrustedSurfCardDomain(card);
      const ticker = card.t?.trim().toUpperCase() || undefined;
      const majorTicker = ticker ? MAJOR_TICKERS.has(ticker) : false;
      if (logo) {
        if (dom && !byDomain.has(dom)) byDomain.set(dom, logo);
        if (ticker && !majorTicker && !byTicker.has(ticker)) byTicker.set(ticker, logo);
      }
      const nameKey = normalizeProjectKey(card.n);
      if (logo && nameKey.length >= 3 && !byName.has(nameKey)) byName.set(nameKey, logo);
      const tvlUsd = positiveUsd(card.tvlUsd);
      indexRadar(
        {
          id: card.id?.trim() || null,
          name: card.n,
          ...(dom ? { domain: dom } : {}),
          ...(ticker && !majorTicker ? { ticker } : {}),
          ...(logo ? { logo } : {}),
          ...(card.f && card.f !== '—' ? { funding: card.f } : {}),
          ...(tvlUsd !== undefined ? { tvlUsd } : {}),
        },
        dom,
      );
    }

    for (const tge of airdrops.tge ?? []) {
      if (isUntrustedSheetSource(tge.source)) continue;
      const logo = safeHttpsUrl(tge.logo);
      if (!logo) continue;
      if (tge.url) {
        const dom = getRegistrableDomain(tge.url)?.toLowerCase();
        if (
          dom &&
          !isPlatformDomain(dom) &&
          !isCuratedAggregatorDomain(dom, { n: tge.n, source: tge.source }) &&
          !byDomain.has(dom)
        ) {
          byDomain.set(dom, logo);
        }
      }
      if (tge.t) {
        const upper = tge.t.trim().toUpperCase();
        if (upper && !MAJOR_TICKERS.has(upper) && !byTicker.has(upper)) {
          byTicker.set(upper, logo);
        }
      }
      const nameKey = normalizeProjectKey(tge.n);
      if (nameKey.length >= 3 && !byName.has(nameKey)) byName.set(nameKey, logo);
    }
  }

  if (defiSection) {
    // TVL sits in the raw sort value of the column titled `TVL`, never in its formatted cell.
    const tvlCol = defiSection.cols?.findIndex(col => /^tvl$/i.test(col.trim())) ?? -1;
    for (const row of defiSection.rows ?? []) {
      const logo = safeHttpsUrl(row.icon);
      const dom = row.href ? getRegistrableDomain(row.href)?.toLowerCase() : undefined;
      const tvlUsd = tvlCol >= 0 ? positiveUsd(row.sortValues?.[tvlCol]) : undefined;
      if (logo) {
        if (dom && !isPlatformDomain(dom) && !byDomain.has(dom)) byDomain.set(dom, logo);
        const label = row.cells?.[0];
        const nameKey = label ? normalizeProjectKey(label) : '';
        if (nameKey.length >= 3 && !byName.has(nameKey)) byName.set(nameKey, logo);
      }
      if (logo || tvlUsd !== undefined) {
        indexRadar(
          {
            // DefiLlama rows carry TVL and a logo only; they are not Radar cards.
            id: null,
            name: row.cells?.[0] ?? '',
            ...(dom && !isPlatformDomain(dom) ? { domain: dom } : {}),
            ...(logo ? { logo } : {}),
            ...(tvlUsd !== undefined ? { tvlUsd } : {}),
          },
          dom && !isPlatformDomain(dom) ? dom : undefined,
        );
      }
    }
  }

  return { byDomain, byTicker, byName, radarByDomain, radarByName, radarByTicker };
}

function radarNameKey(project: string): string | undefined {
  const nameKey = normalizeProjectKey(project);
  return nameKey.length >= 3 && nameKey !== 'web3project' && !isStopName(project) ? nameKey : undefined;
}

/**
 * Finds the Radar card (or DefiLlama row) behind a Live Drops item. A domain
 * match is exact. A name match is accepted only when the two domains do not
 * disagree, so a project never inherits the funding or TVL of a same-named
 * protocol that lives on a different domain.
 */
export function resolveRadarCard(
  item: { project: string; domain?: string; ticker?: string },
  logoIndex?: FeedLogoIndex | null,
): RadarCardRef | undefined {
  if (!logoIndex) return undefined;
  const dom = item.domain?.toLowerCase();
  if (dom && logoIndex.radarByDomain) {
    const byDom = logoIndex.radarByDomain.get(dom);
    if (byDom) return byDom;
  }
  const nameKey = radarNameKey(item.project);
  if (nameKey && logoIndex.radarByName) {
    const byName = logoIndex.radarByName.get(nameKey);
    if (byName && (!dom || !byName.domain || byName.domain === dom)) return byName;
  }
  if (!dom && item.ticker && logoIndex.radarByTicker) {
    const upper = item.ticker.toUpperCase();
    if (!MAJOR_TICKERS.has(upper)) return logoIndex.radarByTicker.get(upper);
  }
  return undefined;
}

/**
 * Resolves a trusted HTTPS project logo for a Live Drops item. Suppresses
 * logos on `risk` clusters and blocks ticker fallback when a distinct domain
 * is already attached so impersonators never display official project art.
 */
export function resolveFeedItemLogo(
  item: { project: string; domain?: string; ticker?: string; riskLevel?: RiskLevel },
  logoIndex?: FeedLogoIndex | null,
): string | undefined {
  if (!logoIndex || item.riskLevel === 'risk') return undefined;
  if (item.domain) {
    const byDom = logoIndex.byDomain.get(item.domain.toLowerCase());
    if (byDom) return byDom;
  }
  const nameKey = normalizeProjectKey(item.project);
  if (nameKey.length >= 3 && nameKey !== 'web3project' && !isStopName(item.project)) {
    const byName = logoIndex.byName.get(nameKey);
    if (byName) return byName;
  }
  if (!item.domain && item.ticker) {
    const upper = item.ticker.toUpperCase();
    if (!MAJOR_TICKERS.has(upper)) {
      const byTick = logoIndex.byTicker.get(upper);
      if (byTick) return byTick;
    }
  }
  return undefined;
}

export function normalizeProjectKey(project: string): string {
  return project.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function isValidProjectClusterKey(project: string): boolean {
  const normProj = normalizeProjectKey(project);
  return (
    normProj.length >= 4 &&
    normProj !== 'web3project' &&
    !isStopName(project) &&
    !isStopName(normProj)
  );
}

/**
 * Computes the backward-compatible base cluster ID (`dom:`, `tick:`, `proj:`,
 * or `post:`). Sliding time-window separation for fallback ticker/project
 * clusters is resolved dynamically against D1 `first_seen`/`last_seen` in
 * `ingestPostIntoCluster` so posts straddling fixed epoch boundaries never split.
 */
export async function computeClusterId(
  domain?: string,
  ticker?: string,
  project?: string,
  fallbackPostId?: string,
  _postedAt?: number,
): Promise<string> {
  if (domain && !isPlatformDomain(domain)) {
    return sha1Hex(`dom:${domain.toLowerCase()}`);
  }
  if (ticker && !MAJOR_TICKERS.has(ticker.toUpperCase())) {
    return sha1Hex(`tick:$${ticker.toUpperCase()}`);
  }
  const rawProj = project ?? '';
  if (!isValidProjectClusterKey(rawProj)) {
    return sha1Hex(`post:${fallbackPostId ?? 'unknown'}`);
  }
  return sha1Hex(`proj:${normalizeProjectKey(rawProj)}`);
}

interface WindowCandidateRow {
  id: string;
  first_seen: number;
  last_seen: number;
}

function distanceToWindow(postedAt: number, firstSeen: number, lastSeen: number): number {
  if (postedAt < firstSeen) return firstSeen - postedAt;
  if (postedAt > lastSeen) return postedAt - lastSeen;
  return 0;
}

function pickBestWindowCandidate<T extends WindowCandidateRow>(
  rows: T[],
  postedAt: number,
  windowMs: number,
  matches: (row: T) => boolean,
): T | null {
  let best: T | null = null;
  let bestDist = Infinity;
  for (const row of rows) {
    if (!matches(row)) continue;
    if (postedAt < row.first_seen - windowMs || postedAt > row.last_seen + windowMs) continue;
    const dist = distanceToWindow(postedAt, row.first_seen, row.last_seen);
    if (
      !best ||
      dist < bestDist ||
      (dist === bestDist && (row.last_seen > best.last_seen || (row.last_seen === best.last_seen && row.id < best.id)))
    ) {
      best = row;
      bestDist = dist;
    }
  }
  return best;
}

interface FallbackIdentity {
  key: string;
  windowMs: number;
}

function getFallbackIdentity(parsed: ParsedDrop, postedAt: number): FallbackIdentity | null {
  const hasProjectDomain = Boolean(parsed.projectDomain && !isPlatformDomain(parsed.projectDomain));
  if (hasProjectDomain || !Number.isFinite(postedAt)) return null;
  const tickerUpper = parsed.ticker?.toUpperCase();
  if (tickerUpper && !MAJOR_TICKERS.has(tickerUpper)) {
    return { key: `tick:${tickerUpper}`, windowMs: SEVEN_DAYS_MS };
  }
  if (isValidProjectClusterKey(parsed.project)) {
    return { key: `proj:${normalizeProjectKey(parsed.project)}`, windowMs: THREE_DAYS_MS };
  }
  return null;
}

function mintWindowedClusterId(baseClusterId: string, postedAt: number, postId: string, attempt = 0): Promise<string> {
  const suffix = attempt >= 1 ? `:${attempt}` : '';
  return sha1Hex(`${baseClusterId}:win:${postedAt}:${postId}${suffix}`);
}

/**
 * Atomically reserves or joins a per-identity window cluster ID in D1 without
 * overwriting separate out-of-window reservations so concurrent nearby ingests
 * converge on one shared ID even when a distant ingest reserves concurrently.
 */
async function reserveFallbackWindow(
  db: D1Database,
  identity: FallbackIdentity,
  preferredClusterId: string,
  windowedClusterId: string,
  postedAt: number,
  rejectedClusterId: string | null,
): Promise<string> {
  const inserted = await db
    .prepare(
      `INSERT OR IGNORE INTO fallback_windows (identity_key, cluster_id, first_seen, last_seen)
       SELECT
         ?1,
         CASE
           WHEN EXISTS (SELECT 1 FROM fallback_windows WHERE identity_key = ?1 AND cluster_id = ?2)
           THEN ?5
           ELSE ?2
         END,
         ?3,
         ?3
       WHERE NOT EXISTS (
         SELECT 1 FROM fallback_windows
         WHERE identity_key = ?1
           AND ?3 >= first_seen - ?4
           AND ?3 <= last_seen + ?4
           AND (?6 IS NULL OR cluster_id != ?6)
       )
       RETURNING cluster_id`,
    )
    .bind(identity.key, preferredClusterId, postedAt, identity.windowMs, windowedClusterId, rejectedClusterId)
    .first<{ cluster_id: string }>();

  if (inserted?.cluster_id) return inserted.cluster_id;

  const updated = await db
    .prepare(
      `UPDATE fallback_windows
       SET first_seen = MIN(first_seen, ?2),
           last_seen = MAX(last_seen, ?2)
       WHERE identity_key = ?1
         AND cluster_id = (
           SELECT cluster_id
           FROM fallback_windows
           WHERE identity_key = ?1
             AND ?2 >= first_seen - ?3
             AND ?2 <= last_seen + ?3
             AND (?4 IS NULL OR cluster_id != ?4)
           ORDER BY
             CASE
               WHEN ?2 < first_seen THEN first_seen - ?2
               WHEN ?2 > last_seen THEN ?2 - last_seen
               ELSE 0
             END ASC,
             last_seen DESC,
             cluster_id ASC
           LIMIT 1
         )
       RETURNING cluster_id`,
    )
    .bind(identity.key, postedAt, identity.windowMs, rejectedClusterId)
    .first<{ cluster_id: string }>();

  return updated?.cluster_id ?? windowedClusterId;
}

/**
 * Resolves the target cluster ID using sliding time windows for fallback
 * ticker (7d) and project (3d) clusters when no canonical project domain is
 * present. Checks `baseClusterId` occupancy via PK lookup outside any LIMITed
 * candidate query, normalizes legacy `project_key IS NULL` rows identically to
 * `normalizeProjectKey`, and coordinates new-window IDs in `fallback_windows`.
 */
async function resolveClusterId(
  db: D1Database,
  parsed: ParsedDrop,
  input: IngestPostInput,
  attempt = 0,
  rejectedClusterId: string | null = null,
): Promise<string> {
  const baseClusterId = await computeClusterId(
    parsed.projectDomain,
    parsed.ticker,
    parsed.project,
    input.postId,
    input.postedAt,
  );

  const hasProjectDomain = Boolean(parsed.projectDomain && !isPlatformDomain(parsed.projectDomain));
  if (hasProjectDomain || !Number.isFinite(input.postedAt)) {
    return baseClusterId;
  }

  const tickerUpper = parsed.ticker?.toUpperCase();
  if (tickerUpper && !MAJOR_TICKERS.has(tickerUpper)) {
    const windowMs = SEVEN_DAYS_MS;
    const identity: FallbackIdentity = { key: `tick:${tickerUpper}`, windowMs };
    const [baseRow, res] = await Promise.all([
      db
        .prepare('SELECT id, project, ticker, first_seen, last_seen FROM clusters WHERE id = ?1')
        .bind(baseClusterId)
        .first<WindowCandidateRow & { project: string; ticker: string | null }>(),
      db
        .prepare(
          `SELECT id, project, ticker, first_seen, last_seen
           FROM clusters
           WHERE domain IS NULL
             AND ticker IS NOT NULL
             AND UPPER(ticker) = ?1
             AND last_seen >= ?2
             AND first_seen <= ?3
           ORDER BY last_seen DESC, id ASC
           LIMIT 50`,
        )
        .bind(tickerUpper, input.postedAt - windowMs, input.postedAt + windowMs)
        .all<WindowCandidateRow & { project: string; ticker: string | null }>(),
    ]);

    const candidates = baseRow ? [baseRow, ...(res.results ?? [])] : (res.results ?? []);
    const match = pickBestWindowCandidate(
      candidates,
      input.postedAt,
      windowMs,
      r => r.id !== rejectedClusterId && (r.id === baseClusterId || r.ticker?.toUpperCase() === tickerUpper),
    );
    if (match) return match.id;
    const windowedId = await mintWindowedClusterId(baseClusterId, input.postedAt, input.postId, attempt);
    const preferredId = baseRow || rejectedClusterId === baseClusterId ? windowedId : baseClusterId;
    return reserveFallbackWindow(db, identity, preferredId, windowedId, input.postedAt, rejectedClusterId);
  }

  if (isValidProjectClusterKey(parsed.project)) {
    const normProj = normalizeProjectKey(parsed.project);
    const windowMs = THREE_DAYS_MS;
    const identity: FallbackIdentity = { key: `proj:${normProj}`, windowMs };
    const [baseRow, indexedRes, nullKeyRes] = await Promise.all([
      db
        .prepare('SELECT id, project, first_seen, last_seen FROM clusters WHERE id = ?1')
        .bind(baseClusterId)
        .first<WindowCandidateRow & { project: string }>(),
      db
        .prepare(
          `SELECT id, project, first_seen, last_seen
           FROM clusters
           WHERE domain IS NULL
             AND project_key = ?1
             AND last_seen >= ?2
             AND first_seen <= ?3
           ORDER BY last_seen DESC, id ASC
           LIMIT 200`,
        )
        .bind(normProj, input.postedAt - windowMs, input.postedAt + windowMs)
        .all<WindowCandidateRow & { project: string }>(),
      db
        .prepare(
          `WITH RECURSIVE legacy_null(id, project, first_seen, last_seen, rest, acc) AS (
             SELECT id, project, first_seen, last_seen, replace(replace(lower(project), char(304), 'i'), char(8490), 'k'), ''
             FROM clusters
             WHERE domain IS NULL
               AND project_key IS NULL
               AND last_seen >= ?2
               AND first_seen <= ?3
             UNION ALL
             SELECT
               id, project, first_seen, last_seen,
               substr(rest, 2),
               acc || CASE WHEN substr(rest, 1, 1) GLOB '[a-z0-9]' THEN substr(rest, 1, 1) ELSE '' END
             FROM legacy_null
             WHERE length(rest) > 0
           )
           SELECT id, project, first_seen, last_seen
           FROM legacy_null
           WHERE length(rest) = 0 AND acc = ?1
           ORDER BY last_seen DESC, id ASC
           LIMIT 50`,
        )
        .bind(normProj, input.postedAt - windowMs, input.postedAt + windowMs)
        .all<WindowCandidateRow & { project: string }>(),
    ]);

    const candidates = [
      ...(baseRow ? [baseRow] : []),
      ...(indexedRes.results ?? []),
      ...(nullKeyRes.results ?? []),
    ];
    const match = pickBestWindowCandidate(
      candidates,
      input.postedAt,
      windowMs,
      r => r.id !== rejectedClusterId && (r.id === baseClusterId || normalizeProjectKey(r.project) === normProj),
    );
    if (match) return match.id;
    const windowedId = await mintWindowedClusterId(baseClusterId, input.postedAt, input.postId, attempt);
    const preferredId = baseRow || rejectedClusterId === baseClusterId ? windowedId : baseClusterId;
    return reserveFallbackWindow(db, identity, preferredId, windowedId, input.postedAt, rejectedClusterId);
  }

  return baseClusterId;
}

export interface IngestPostInput {
  postId: string;
  sourceId: string;
  sourceTrust: number;
  postUrl: string;
  postedAt: number;
  text: string;
  htmlUrls?: string[];
  forwardedFrom?: string | null;
  sourceLang?: string;
}

export interface IngestPostResult {
  clusterId: string;
  sourceId: string;
  rawText: string;
  forwardedFrom: string | null;
  isNewCluster: boolean;
  isNonLatinSource: boolean;
  riskLevel: RiskLevel;
  parsed: ParsedDrop;
}

function unionStrings<T extends string>(a: T[], b: T[]): T[] {
  const set = new Set<T>(a);
  for (const item of b) set.add(item);
  return [...set];
}

export async function ingestPostIntoCluster(
  db: D1Database,
  input: IngestPostInput,
  parseCtx: ParseContext,
  surfIndex: SurfIndex,
  knownProjectDomains: Map<string, string>,
  platformDomains?: Set<string>,
  nowMs = Date.now(),
  preParsed?: ParsedDrop,
): Promise<IngestPostResult> {
  const parsed =
    preParsed ??
    parseDropPost(input.text, input.htmlUrls ?? [], {
      ...parseCtx,
      sourceLang: input.sourceLang ?? parseCtx.sourceLang,
      surfByDomain: surfIndex.byDomain,
      surfByTicker: surfIndex.byTicker,
    });

  const existingPost = await db
    .prepare('SELECT cluster_id, posted_at FROM posts WHERE id = ?1')
    .bind(input.postId)
    .first<{ cluster_id: string | null; posted_at: number }>();
  const replayedClusterId = existingPost?.cluster_id ?? null;
  const effectivePostedAt =
    existingPost && Number.isFinite(existingPost.posted_at) ? existingPost.posted_at : input.postedAt;
  const resolveInput =
    effectivePostedAt === input.postedAt ? input : { ...input, postedAt: effectivePostedAt };
  const fallbackIdentity = replayedClusterId ? null : getFallbackIdentity(parsed, effectivePostedAt);

  return withFallbackLock(db, fallbackIdentity?.key ?? null, async () => {
    const maxAttempts = fallbackIdentity ? 6 : 1;
    let rejectedClusterId: string | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const clusterId: string =
        replayedClusterId ?? (await resolveClusterId(db, parsed, resolveInput, attempt, rejectedClusterId));

      const [existing, prevAgg] = await Promise.all([
        db
          .prepare(
            `SELECT id, project, ticker, domain, chains, task_types, summary, summary_source, risk_level, risk_reasons,
                    score, source_count, surf_tier, surf_rank, first_seen, last_seen, is_drop
             FROM clusters WHERE id = ?1`,
          )
          .bind(clusterId)
          .first<{
            id: string;
            project: string;
            ticker: string | null;
            domain: string | null;
            chains: string;
            task_types: string;
            summary: string;
            summary_source: 'rule' | 'ai';
            risk_level: RiskLevel;
            risk_reasons: string;
            score: number;
            source_count: number;
            surf_tier: Grade | null;
            surf_rank: number | null;
            first_seen: number;
            last_seen: number;
            is_drop: number | null;
          }>(),
        db
          .prepare(
            `SELECT p.source_id, MAX(COALESCE(s.trust, ?2)) AS trust,
                    MIN(p.posted_at) AS min_posted_at, MAX(p.posted_at) AS max_posted_at
             FROM posts p
             LEFT JOIN sources s ON s.id = p.source_id
             WHERE p.cluster_id = ?1
             GROUP BY p.source_id`,
          )
          .bind(clusterId, input.sourceTrust)
          .all<{ source_id: string; trust: number; min_posted_at: number; max_posted_at: number }>(),
      ]);

      const distinctSources = new Map<string, number>();
      for (const r of prevAgg.results ?? []) {
        distinctSources.set(r.source_id, r.trust);
      }
      distinctSources.set(input.sourceId, Math.max(distinctSources.get(input.sourceId) ?? 0, input.sourceTrust));

      const sourceCount = Math.max(1, distinctSources.size);
      let trustMax = input.sourceTrust;
      for (const t of distinctSources.values()) {
        if (t > trustMax) trustMax = t;
      }

      const surfMatch =
        (parsed.projectDomain && surfIndex.byDomain.get(parsed.projectDomain)) ||
        (parsed.ticker && surfIndex.byTicker.get(parsed.ticker)) ||
        undefined;

      const prevChains = existing ? (JSON.parse(existing.chains) as string[]) : [];
      const prevTasks = existing ? (JSON.parse(existing.task_types) as TaskType[]) : [];
      const prevReasons = existing ? (JSON.parse(existing.risk_reasons) as string[]) : [];

      const mergedChains = unionStrings(prevChains, parsed.chains);
      const mergedTasksRaw = unionStrings(prevTasks, parsed.taskTypes);
      const mergedTasks = mergedTasksRaw.length > 1 ? mergedTasksRaw.filter(t => t !== 'other') : mergedTasksRaw;

      const resolvedDomain = existing?.domain ?? parsed.projectDomain ?? undefined;

      const safety = evaluateSafety({
        domain: resolvedDomain,
        urls: parsed.urls,
        rawIpUrls: parsed.rawIpUrls,
        text: input.text,
        knownProjectDomains,
        platformDomains,
        trustMax,
        sourceCount,
      });

      // Escalate risk conservatively across merged posts, while clearing stale
      // single-low-trust warnings once corroborated and the retired
      // unverified-registry warning still stored on legacy rows.
      const filteredPrevReasons = prevReasons.filter(r => {
        if (sourceCount > 1 && r === 'Single low-trust source') return false;
        if (isUnverifiedRegistryReason(r)) return false;
        return true;
      });
      const mergedReasons = unionStrings(filteredPrevReasons, safety.reasons);
      let mergedRisk: RiskLevel = safety.level;
      if (existing?.risk_level === 'risk' || mergedRisk === 'risk') mergedRisk = 'risk';
      else if (existing?.risk_level === 'warn' || mergedRisk === 'warn') {
        mergedRisk = mergedReasons.length > 0 ? 'warn' : 'ok';
      }

      const project = existing?.project ?? parsed.project;
      const projectKey = isValidProjectClusterKey(project) ? normalizeProjectKey(project) : null;
      const ticker = existing?.ticker ?? parsed.ticker ?? null;
      const domain = resolvedDomain ?? null;
      const surfTier = existing?.surf_tier ?? surfMatch?.tier ?? null;
      const surfRank = existing?.surf_rank ?? surfMatch?.cardRank ?? null;
      let firstSeen = existing ? Math.min(existing.first_seen, input.postedAt) : input.postedAt;
      let lastSeen = existing ? Math.max(existing.last_seen, input.postedAt) : input.postedAt;
      if (existingPost && Number.isFinite(existingPost.posted_at)) {
        firstSeen = Math.min(firstSeen, existingPost.posted_at);
        lastSeen = Math.max(lastSeen, existingPost.posted_at);
      }
      for (const r of prevAgg.results ?? []) {
        if (Number.isFinite(r.min_posted_at)) firstSeen = Math.min(firstSeen, r.min_posted_at);
        if (Number.isFinite(r.max_posted_at)) lastSeen = Math.max(lastSeen, r.max_posted_at);
      }

      let summary = existing?.summary ?? parsed.summary;
      const summarySource: 'rule' | 'ai' = existing?.summary_source ?? 'rule';
      if (
        existing &&
        existing.summary_source === 'rule' &&
        !parsed.isNonLatinSource &&
        existing.summary.startsWith(`${existing.project}:`)
      ) {
        summary = buildRuleSummary(input.text, project, mergedTasks, mergedChains, input.sourceLang).summary;
      }

      const score = computeScore({
        trustMax,
        sourceCount,
        lastSeen,
        nowMs,
        surfTier,
        riskLevel: mergedRisk,
      });

      const isDropFlag = parsed.isRelevantDrop ? 1 : 0;

      if (existing) {
        if (fallbackIdentity) {
          const inDirectWindow =
            effectivePostedAt >= existing.first_seen - fallbackIdentity.windowMs &&
            effectivePostedAt <= existing.last_seen + fallbackIdentity.windowMs;
          // Query fallback_windows strictly after reading `existing` so any
          // concurrent writer's reservation expansion is guaranteed visible.
          const reservedWin = !inDirectWindow
            ? await db
                .prepare(
                  'SELECT first_seen, last_seen FROM fallback_windows WHERE identity_key = ?1 AND cluster_id = ?2',
                )
                .bind(fallbackIdentity.key, clusterId)
                .first<{ first_seen: number; last_seen: number }>()
            : null;
          const inBridgedWindow = Boolean(
            reservedWin &&
              effectivePostedAt >= reservedWin.first_seen &&
              effectivePostedAt <= reservedWin.last_seen &&
              existing.first_seen >= reservedWin.first_seen &&
              existing.last_seen <= reservedWin.last_seen,
          );
          if (!inDirectWindow && !inBridgedWindow) {
            rejectedClusterId = clusterId;
            if (attempt < maxAttempts - 1) continue;
            throw new Error(`Fallback cluster window conflict exhausted for ${clusterId}`);
          }
        }

        // Merge against the STORED row, not the stale in-memory `existing` read:
        // a concurrent ingest may have escalated risk between our SELECT and this
        // UPDATE, and a plain `risk_level = ?9` would silently downgrade it.
        // Also enforce sliding-window (or coordinated fallback_windows bridge) bounds.
        const updateRes = await db
          .prepare(
            `UPDATE clusters SET
               chains = (
                 SELECT json_group_array(DISTINCT value)
                 FROM (SELECT value FROM json_each(clusters.chains)
                       UNION SELECT value FROM json_each(?5))
               ),
               task_types = (
                 SELECT CASE
                          WHEN COUNT(DISTINCT value) > 1
                          THEN json_group_array(value) FILTER (WHERE value != 'other')
                          ELSE json_group_array(DISTINCT value)
                        END
                 FROM (SELECT value FROM json_each(clusters.task_types)
                       UNION SELECT value FROM json_each(?6))
               ),
               summary = CASE WHEN clusters.summary_source = 'ai' THEN clusters.summary ELSE ?7 END,
               summary_source = CASE WHEN clusters.summary_source = 'ai' THEN 'ai' ELSE ?8 END,
               risk_reasons = (
                 SELECT json_group_array(DISTINCT value)
                 FROM (SELECT value FROM json_each(clusters.risk_reasons)
                       UNION SELECT value FROM json_each(?10))
                 WHERE (value != 'Single low-trust source' OR MAX(clusters.source_count, ?12) <= 1)
                   AND lower(trim(value)) NOT LIKE '${UNVERIFIED_REGISTRY_REASON_PREFIX}%'
               ),
               risk_level = CASE
                 WHEN clusters.risk_level = 'risk' OR ?9 = 'risk' THEN 'risk'
                 WHEN (clusters.risk_level = 'warn' OR ?9 = 'warn')
                      AND EXISTS (
                        SELECT 1
                        FROM (SELECT value FROM json_each(clusters.risk_reasons)
                              UNION
                              SELECT value FROM json_each(?10))
                        WHERE (value != 'Single low-trust source' OR MAX(clusters.source_count, ?12) <= 1)
                          AND lower(trim(value)) NOT LIKE '${UNVERIFIED_REGISTRY_REASON_PREFIX}%'
                      )
                   THEN 'warn'
                 ELSE 'ok'
               END,
               score = CASE
                 WHEN ?9 = 'risk' THEN ?11
                 WHEN clusters.risk_level = 'risk' THEN ROUND(?11 * 0.2, 4)
                 ELSE MAX(clusters.score, ?11)
               END,
               source_count = MAX(clusters.source_count, ?12),
               trust_max = MAX(clusters.trust_max, ?18),
               surf_tier = COALESCE(?13, clusters.surf_tier), surf_rank = COALESCE(?14, clusters.surf_rank),
               first_seen = MIN(clusters.first_seen, ?15), last_seen = MAX(clusters.last_seen, ?16),
               project = ?2, ticker = COALESCE(?3, clusters.ticker), domain = COALESCE(?4, clusters.domain),
               is_drop = CASE WHEN clusters.is_drop = 1 OR ?17 = 1 THEN 1 ELSE COALESCE(clusters.is_drop, ?17) END,
               project_key = COALESCE(clusters.project_key, ?19)
             WHERE id = ?1
               AND (
                 ?20 IS NULL
                 OR (?21 >= clusters.first_seen - ?20 AND ?21 <= clusters.last_seen + ?20)
                 OR (
                   ?22 IS NOT NULL
                   AND EXISTS (
                     SELECT 1 FROM fallback_windows fw
                     WHERE fw.identity_key = ?22
                       AND fw.cluster_id = clusters.id
                       AND ?21 >= fw.first_seen
                       AND ?21 <= fw.last_seen
                       AND clusters.first_seen >= fw.first_seen
                       AND clusters.last_seen <= fw.last_seen
                   )
                 )
               )`,
          )
          .bind(
            clusterId,
            project,
            ticker,
            domain,
            JSON.stringify(mergedChains),
            JSON.stringify(mergedTasks),
            summary,
            summarySource,
            mergedRisk,
            JSON.stringify(mergedReasons),
            score,
            sourceCount,
            surfTier,
            surfRank,
            firstSeen,
            lastSeen,
            isDropFlag,
            trustMax,
            projectKey,
            fallbackIdentity?.windowMs ?? null,
            Number.isFinite(effectivePostedAt) ? effectivePostedAt : null,
            fallbackIdentity?.key ?? null,
          )
          .run();

        if (fallbackIdentity && (updateRes.meta?.changes ?? 1) === 0) {
          rejectedClusterId = clusterId;
          if (attempt < maxAttempts - 1) continue;
          throw new Error(`Fallback cluster window conflict exhausted for ${clusterId}`);
        }
      } else {
        const upsertRes = await db
          .prepare(
            `INSERT INTO clusters (id, project, ticker, domain, chains, task_types, summary, summary_source, risk_level, risk_reasons, score, source_count, surf_tier, surf_rank, first_seen, last_seen, is_drop, trust_max, project_key)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)
             ON CONFLICT(id) DO UPDATE SET
               chains = (
                 SELECT json_group_array(DISTINCT value)
                 FROM (SELECT value FROM json_each(clusters.chains)
                       UNION SELECT value FROM json_each(excluded.chains))
               ),
               task_types = (
                 SELECT CASE
                          WHEN COUNT(DISTINCT value) > 1
                          THEN json_group_array(value) FILTER (WHERE value != 'other')
                          ELSE json_group_array(DISTINCT value)
                        END
                 FROM (SELECT value FROM json_each(clusters.task_types)
                       UNION SELECT value FROM json_each(excluded.task_types))
               ),
               risk_reasons = (
                 SELECT json_group_array(DISTINCT value)
                 FROM (
                   SELECT value FROM json_each(clusters.risk_reasons)
                   UNION
                   SELECT value FROM json_each(excluded.risk_reasons)
                 )
                 WHERE (value != 'Single low-trust source' OR MAX(clusters.source_count, excluded.source_count) <= 1)
                   AND lower(trim(value)) NOT LIKE '${UNVERIFIED_REGISTRY_REASON_PREFIX}%'
               ),
               risk_level = CASE
                 WHEN clusters.risk_level = 'risk' OR excluded.risk_level = 'risk' THEN 'risk'
                 WHEN (clusters.risk_level = 'warn' OR excluded.risk_level = 'warn')
                      AND EXISTS (
                        SELECT 1
                        FROM (SELECT value FROM json_each(clusters.risk_reasons)
                              UNION
                              SELECT value FROM json_each(excluded.risk_reasons))
                        WHERE (value != 'Single low-trust source' OR MAX(clusters.source_count, excluded.source_count) <= 1)
                          AND lower(trim(value)) NOT LIKE '${UNVERIFIED_REGISTRY_REASON_PREFIX}%'
                      )
                   THEN 'warn'
                 ELSE 'ok'
               END,
               summary = CASE WHEN clusters.summary_source = 'ai' THEN clusters.summary ELSE excluded.summary END,
               summary_source = CASE WHEN clusters.summary_source = 'ai' THEN 'ai' ELSE 'rule' END,
               ticker = COALESCE(clusters.ticker, excluded.ticker),
               domain = COALESCE(clusters.domain, excluded.domain),
               surf_tier = COALESCE(clusters.surf_tier, excluded.surf_tier),
               surf_rank = COALESCE(clusters.surf_rank, excluded.surf_rank),
               first_seen = MIN(clusters.first_seen, excluded.first_seen),
               score = CASE
                 WHEN excluded.risk_level = 'risk' THEN excluded.score
                 WHEN clusters.risk_level = 'risk' THEN ROUND(excluded.score * 0.2, 4)
                 ELSE MAX(clusters.score, excluded.score)
               END,
               source_count = MAX(clusters.source_count, excluded.source_count),
               last_seen = MAX(clusters.last_seen, excluded.last_seen),
               is_drop = CASE WHEN clusters.is_drop = 1 OR excluded.is_drop = 1 THEN 1 ELSE COALESCE(clusters.is_drop, excluded.is_drop) END,
               trust_max = MAX(clusters.trust_max, excluded.trust_max),
               project_key = COALESCE(clusters.project_key, excluded.project_key)
             WHERE ?20 IS NULL
                OR (?21 >= clusters.first_seen - ?20 AND ?21 <= clusters.last_seen + ?20)
                OR (
                  ?22 IS NOT NULL
                  AND EXISTS (
                    SELECT 1 FROM fallback_windows fw
                    WHERE fw.identity_key = ?22
                      AND fw.cluster_id = clusters.id
                      AND ?21 >= fw.first_seen
                      AND ?21 <= fw.last_seen
                      AND clusters.first_seen >= fw.first_seen
                      AND clusters.last_seen <= fw.last_seen
                  )
                )`,
          )
          .bind(
            clusterId,
            project,
            ticker,
            domain,
            JSON.stringify(mergedChains),
            JSON.stringify(mergedTasks),
            summary,
            summarySource,
            mergedRisk,
            JSON.stringify(mergedReasons),
            score,
            sourceCount,
            surfTier,
            surfRank,
            firstSeen,
            lastSeen,
            isDropFlag,
            trustMax,
            projectKey,
            fallbackIdentity?.windowMs ?? null,
            Number.isFinite(effectivePostedAt) ? effectivePostedAt : null,
            fallbackIdentity?.key ?? null,
          )
          .run();

        if (fallbackIdentity && (upsertRes.meta?.changes ?? 1) === 0) {
          rejectedClusterId = clusterId;
          if (attempt < maxAttempts - 1) continue;
          throw new Error(`Fallback cluster window conflict exhausted for ${clusterId}`);
        }
      }

      if (fallbackIdentity && Number.isFinite(effectivePostedAt)) {
        await db
          .prepare(
            `UPDATE fallback_windows
             SET first_seen = MIN(first_seen, ?3),
                 last_seen = MAX(last_seen, ?3)
             WHERE identity_key = ?1
               AND cluster_id = ?2
               AND (?3 < first_seen OR ?3 > last_seen)`,
          )
          .bind(fallbackIdentity.key, clusterId, effectivePostedAt)
          .run();
      }

      let postInserted = false;
      // Rich metadata rides on its own statement so a pre-0009 schema never fails the ingest.
      if (parsed.isRelevantDrop) {
        await mergeClusterRichMeta(db, clusterId, parsed, {
          deadlineAt: Number.isFinite(effectivePostedAt) ? effectivePostedAt : nowMs,
        });
      }
      if (!existingPost) {
        const insertPost = await db
          .prepare(
            `INSERT OR IGNORE INTO posts (id, source_id, post_url, posted_at, text, urls, forwarded_from, cluster_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
          )
          .bind(
            input.postId,
            input.sourceId,
            input.postUrl,
            input.postedAt,
            input.text,
            JSON.stringify(parsed.urls),
            input.forwardedFrom ?? null,
            clusterId,
            nowMs,
          )
          .run();
        postInserted = (insertPost.meta?.changes ?? 1) > 0;
      } else if (existingPost.cluster_id == null) {
        await db
          .prepare('UPDATE posts SET cluster_id = ?2 WHERE id = ?1 AND cluster_id IS NULL')
          .bind(input.postId, clusterId)
          .run();
        postInserted = true;
      } else {
        postInserted = true;
      }

      let finalRiskLevel: RiskLevel = mergedRisk;
      // Sync source_count, low-trust warning, and score from posts when concurrent
      // ingests both raced past prevAgg before either post row was committed.
      if (postInserted) {
        const syncRes = await db
          .prepare(
            `UPDATE clusters
             SET source_count = (SELECT COUNT(DISTINCT source_id) FROM posts WHERE cluster_id = ?1),
                 risk_reasons = CASE
                   WHEN (SELECT COUNT(DISTINCT source_id) FROM posts WHERE cluster_id = ?1) > 1
                   THEN COALESCE(
                     (SELECT json_group_array(value) FROM json_each(clusters.risk_reasons) WHERE value != 'Single low-trust source'),
                     '[]'
                   )
                   ELSE clusters.risk_reasons
                 END,
                 risk_level = CASE
                   WHEN clusters.risk_level = 'risk' THEN 'risk'
                   WHEN clusters.risk_level = 'warn'
                        AND EXISTS (
                          SELECT 1 FROM json_each(clusters.risk_reasons)
                          WHERE value != 'Single low-trust source'
                             OR (SELECT COUNT(DISTINCT source_id) FROM posts WHERE cluster_id = ?1) <= 1
                        )
                     THEN 'warn'
                   ELSE 'ok'
                 END
             WHERE id = ?1
               AND source_count < (SELECT COUNT(DISTINCT source_id) FROM posts WHERE cluster_id = ?1)`,
          )
          .bind(clusterId)
          .run();
        if ((syncRes.meta?.changes ?? 0) > 0) {
          const synced = await db
            .prepare('SELECT trust_max, source_count, last_seen, surf_tier, risk_level FROM clusters WHERE id = ?1')
            .bind(clusterId)
            .first<{
              trust_max: number;
              source_count: number;
              last_seen: number;
              surf_tier: Grade | null;
              risk_level: RiskLevel;
            }>();
          if (synced) {
            finalRiskLevel = synced.risk_level;
            const syncedScore = computeScore({
              trustMax: synced.trust_max,
              sourceCount: synced.source_count,
              lastSeen: synced.last_seen,
              nowMs,
              surfTier: synced.surf_tier,
              riskLevel: synced.risk_level,
            });
            await db
              .prepare('UPDATE clusters SET score = ?2 WHERE id = ?1 AND risk_level = ?3')
              .bind(clusterId, syncedScore, synced.risk_level)
              .run();
          }
        }
      }

      return {
        clusterId,
        sourceId: input.sourceId,
        rawText: input.text,
        forwardedFrom: input.forwardedFrom ?? null,
        isNewCluster: !existing && postInserted,
        isNonLatinSource: parsed.isNonLatinSource,
        riskLevel: finalRiskLevel,
        parsed,
      };
    }

    throw new Error(`Failed to resolve non-conflicting cluster for post ${input.postId}`);
  });
}

export interface FeedQueryOptions {
  since?: number;
  limit?: number;
  risk?: 'include' | 'exclude';
  sort?: 'score' | 'new';
  cursor?: string;
  /** Content-derived payload timestamp (excluded from the ETag digest). */
  contentTs?: number;
  /** Optional zero-migration logo lookup built from stored Surf/curated/DeFi snapshots. */
  logoIndex?: FeedLogoIndex | null;
}

interface FeedCursor {
  a: number;
  b: number;
  id: string;
}

function encodeFeedCursor(sortByNew: boolean, cursor: FeedCursor): string {
  return `${sortByNew ? 'new' : 'score'}|${cursor.a}|${cursor.b}|${cursor.id}`;
}

function parseFeedCursor(raw: string | undefined, sortByNew: boolean): FeedCursor | null {
  if (!raw) return null;
  const expectedPrefix = sortByNew ? 'new|' : 'score|';
  if (!raw.startsWith(expectedPrefix)) return null;
  const rest = raw.slice(expectedPrefix.length);
  const firstSep = rest.indexOf('|');
  if (firstSep <= 0) return null;
  const secondSep = rest.indexOf('|', firstSep + 1);
  if (secondSep <= firstSep + 1) return null;
  const a = Number(rest.slice(0, firstSep));
  const b = Number(rest.slice(firstSep + 1, secondSep));
  const id = rest.slice(secondSep + 1);
  if (!Number.isFinite(a) || !Number.isFinite(b) || !id) return null;
  return { a, b, id };
}

interface ClusterFeedRow {
  id: string;
  project: string;
  ticker: string | null;
  domain: string | null;
  chains: string;
  task_types: string;
  summary: string;
  summary_source: 'rule' | 'ai';
  risk_level: RiskLevel;
  risk_reasons: string;
  score: number;
  source_count: number;
  surf_tier: Grade | null;
  surf_rank: number | null;
  first_seen: number;
  last_seen: number;
  is_drop: number | null;
}

interface FeedPostRow {
  cluster_id: string;
  source_id: string;
  post_url: string;
  posted_at: number;
  urls: string;
  platform: FeedSourceRef['platform'] | null;
  handle: string | null;
}

interface LegacyPostRow {
  cluster_id: string;
  text: string;
  urls: string;
}

interface ClusterPostAgg {
  sources: FeedSourceRef[];
  seenSourceKeys: Set<string>;
  distinctSourceIds: Set<string>;
  minPostedAt: number;
  maxPostedAt: number;
  projectUrls: string[];
  platformUrls: string[];
  oldestPostUrls: string[];
  seenProjectUrls: Set<string>;
  seenPlatformUrls: Set<string>;
}

function parseJsonArray<T>(raw: string): T[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function polishLegacyRuleSummary(
  summary: string,
  project: string,
  taskTypes: TaskType[],
  chains: string[],
): string {
  const safeProject = stripOrTranslateCjk(project) || 'Web3 Project';
  const cleaned = cleanSummaryText(stripOrTranslateCjk(summary));
  if (!cleaned || detectNonEnglishLatin(cleaned)) {
    const tasksText = taskTypes.join(', ');
    const chainsText = chains.length > 0 ? ` on ${chains.join(', ')}` : '';
    return truncateAtWordBoundary(`${safeProject}: ${tasksText}${chainsText}`);
  }
  return truncateAtWordBoundary(cleaned);
}

interface ClusterRichMetaRow {
  id: string;
  reward_pool: string | null;
  deadline: string | null;
  cost: string | null;
  steps: string | null;
}

interface DomainMetaRow {
  domain: string;
  logo_url: string | null;
  og_image: string | null;
  og_title: string | null;
  og_description: string | null;
  tvl_usd: number | null;
}

const MAX_STEPS = 4;

/**
 * Merges rich metadata into a cluster row. Values fill only what is still
 * empty, and steps merge in first-seen order up to the cap. When `deadlineAt`
 * is supplied (post ingest), a newer post's deadline replaces an older one
 * while an older post can still fill an empty field; an AI summary never
 * overrides what the parser already read. An AI caller also passes its row
 * lease so a lost lease never writes. Silently skipped on a pre-0009 schema
 * without the rich columns; the cluster write itself already succeeded.
 */
export async function mergeClusterRichMeta(
  db: D1Database,
  clusterId: string,
  rich: RichDropMeta,
  opts: { deadlineAt?: number; newestDeadlineWins?: boolean; leaseUntil?: number } = {},
): Promise<void> {
  const dedupedSteps = rich.steps?.length ? [...new Set(rich.steps)].slice(0, MAX_STEPS) : [];
  if (!rich.rewardPool && !rich.deadline && !rich.cost && dedupedSteps.length === 0) return;
  const values: unknown[] = [
    clusterId,
    rich.rewardPool ?? null,
    rich.deadline ?? null,
    rich.cost ?? null,
    JSON.stringify(dedupedSteps),
  ];
  const hasDeadlineAt = typeof opts.deadlineAt === 'number' && Number.isFinite(opts.deadlineAt);
  let deadlineAtParam = '';
  if (hasDeadlineAt) {
    values.push(opts.deadlineAt);
    deadlineAtParam = `?${values.length}`;
  }
  let leaseClause = '';
  if (opts.leaseUntil !== undefined) {
    values.push(opts.leaseUntil);
    leaseClause = ` AND ai_retry_after = ?${values.length}`;
  }
  const deadlineClause = hasDeadlineAt
    ? `deadline = CASE
         WHEN ?3 IS NULL THEN NULLIF(clusters.deadline, '')
         WHEN NULLIF(clusters.deadline, '') IS NULL THEN ?3
         WHEN clusters.deadline_updated_at IS NULL OR ${deadlineAtParam} >= clusters.deadline_updated_at THEN ?3
         ELSE clusters.deadline
       END,
       deadline_updated_at = CASE
         WHEN ?3 IS NULL THEN clusters.deadline_updated_at
         WHEN NULLIF(clusters.deadline, '') IS NULL THEN ${deadlineAtParam}
         WHEN clusters.deadline_updated_at IS NULL OR ${deadlineAtParam} >= clusters.deadline_updated_at THEN ${deadlineAtParam}
         ELSE clusters.deadline_updated_at
       END`
    : `deadline = ${
        opts.newestDeadlineWins
          ? "COALESCE(?3, NULLIF(clusters.deadline, ''))"
          : "COALESCE(NULLIF(clusters.deadline, ''), ?3, clusters.deadline)"
      }`;
  try {
    await db
      .prepare(
        `UPDATE clusters SET
           reward_pool = COALESCE(NULLIF(clusters.reward_pool, ''), ?2, clusters.reward_pool),
           ${deadlineClause},
           cost = COALESCE(NULLIF(clusters.cost, ''), ?4, clusters.cost),
           steps = CASE
                   WHEN json_valid(clusters.steps) AND json_array_length(clusters.steps) > 0
                   THEN (
                     SELECT json_group_array(value) FROM (
                       SELECT DISTINCT value FROM (
                         SELECT value FROM json_each(clusters.steps)
                         UNION ALL
                         SELECT value FROM json_each(?5)
                       )
                       LIMIT ${MAX_STEPS}
                     )
                   )
                   ELSE ?5
                 END
         WHERE id = ?1${leaseClause}`,
      )
      .bind(...values)
      .run();
  } catch {
    // Pre-0009 schema: the cluster row is still correct, only the rich fields are absent.
  }
}

/** One-line display text with control characters and CJK removed, or undefined when nothing is left. */
function cleanMetaText(raw: string | null | undefined, maxLen: number): string | undefined {
  if (!raw) return undefined;
  const text = truncateAtWordBoundary(
    stripOrTranslateCjk(raw)
      .replace(/[\u0000-\u001F\u007F]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
    maxLen,
  );
  return text || undefined;
}

function bindList(values: string[]): string {
  return values.map((_, idx) => `?${idx + 1}`).join(',');
}

/** Rich metadata for a page of clusters; an empty map on a pre-0009 schema without the columns. */
async function loadClusterRichMeta(db: D1Database, clusterIds: string[]): Promise<Map<string, ClusterRichMetaRow>> {
  const map = new Map<string, ClusterRichMetaRow>();
  if (clusterIds.length === 0) return map;
  try {
    const res = await db
      .prepare(`SELECT id, reward_pool, deadline, cost, steps FROM clusters WHERE id IN (${bindList(clusterIds)})`)
      .bind(...clusterIds)
      .all<ClusterRichMetaRow>();
    for (const row of res.results ?? []) map.set(row.id, row);
  } catch {
    // Pre-0009 schema: serve the feed without rich metadata.
  }
  return map;
}

// 99 domains + 1 expires_at cutoff stays within D1's 100-parameter bind limit.
const DOMAIN_META_BIND_CHUNK = 99;

/** Unexpired cached enrichment rows for a page of domains; empty when the table is missing. */
async function loadDomainMeta(db: D1Database, domains: string[]): Promise<Map<string, DomainMetaRow>> {
  const map = new Map<string, DomainMetaRow>();
  if (domains.length === 0) return map;
  const nowMs = Date.now();
  try {
    for (let i = 0; i < domains.length; i += DOMAIN_META_BIND_CHUNK) {
      const chunk = domains.slice(i, i + DOMAIN_META_BIND_CHUNK);
      const res = await db
        .prepare(
          `SELECT domain, logo_url, og_image, og_title, og_description, tvl_usd
           FROM domain_meta
           WHERE domain IN (${bindList(chunk)}) AND expires_at > ?${chunk.length + 1}`,
        )
        .bind(...chunk, nowMs)
        .all<DomainMetaRow>();
      for (const row of res.results ?? []) map.set(row.domain.toLowerCase(), row);
    }
  } catch {
    // Pre-0009 schema (no domain_meta table): serve the feed without enrichment.
  }
  return map;
}

export async function queryFeed(
  db: D1Database,
  allKnownDomains: Set<string>,
  opts: FeedQueryOptions = {},
): Promise<FeedResponse> {
  // D1 caps bound parameters per query (100): each keyset batch fetches at
  // most FEED_BATCH_SIZE (100) clusters so the posts IN (...) query stays
  // <= 100 binds, while looping up to FEED_MAX_BATCHES prevents page
  // starvation and emits a continuation cursor if the budget is exhausted.
  const rawLimit = Number(opts.limit);
  const safeLimit = Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 100;
  const limit = Math.min(100, Math.max(1, safeLimit));
  const since = Number.isFinite(opts.since) ? Number(opts.since) : 0;
  const riskClause = opts.risk === 'exclude' ? `AND c.risk_level != 'risk'` : '';
  const sortByNew = opts.sort === 'new';
  const orderCol = sortByNew
    ? 'last_seen DESC, score DESC, id ASC'
    : 'score DESC, last_seen DESC, id ASC';

  let cursor: FeedCursor | null = parseFeedCursor(opts.cursor, sortByNew);
  let lastBatchFull = false;
  const items: FeedItem[] = [];

  for (let batch = 0; batch < FEED_MAX_BATCHES && items.length < limit; batch++) {
    const cursorClause: string = cursor
      ? sortByNew
        ? 'AND (last_seen < ?3 OR (last_seen = ?3 AND (score < ?4 OR (score = ?4 AND id > ?5))))'
        : 'AND (score < ?3 OR (score = ?3 AND (last_seen < ?4 OR (last_seen = ?4 AND id > ?5))))'
      : '';
    const bindArgs: (string | number)[] = cursor
      ? [since, FEED_BATCH_SIZE, cursor.a, cursor.b, cursor.id]
      : [since, FEED_BATCH_SIZE];

    const clusterRows: D1Result<ClusterFeedRow> = await db
      .prepare(
        `WITH enabled_clusters AS MATERIALIZED (
           SELECT c.id, c.project, c.ticker, c.domain, c.chains, c.task_types, c.summary, c.summary_source,
                  c.risk_level, c.risk_reasons, c.score, c.source_count, c.surf_tier, c.surf_rank,
                  c.first_seen,
                  (
                    SELECT p.posted_at
                    FROM posts p
                    LEFT JOIN sources s ON s.id = p.source_id
                    WHERE p.cluster_id = c.id AND COALESCE(s.enabled, 1) = 1
                    ORDER BY p.posted_at DESC
                    LIMIT 1
                  ) AS last_seen,
                  c.is_drop
           FROM clusters c
           WHERE c.last_seen >= ?1
             AND COALESCE(c.is_drop, 1) = 1
             ${riskClause}
         )
         SELECT id, project, ticker, domain, chains, task_types, summary, summary_source,
                risk_level, risk_reasons, score, source_count, surf_tier, surf_rank, first_seen, last_seen, is_drop
         FROM enabled_clusters
         WHERE last_seen IS NOT NULL
           AND last_seen >= ?1
           ${cursorClause}
         ORDER BY ${orderCol}
         LIMIT ?2`,
      )
      .bind(...bindArgs)
      .all<ClusterFeedRow>();

    const clusters: ClusterFeedRow[] = clusterRows.results ?? [];
    if (clusters.length === 0) {
      lastBatchFull = false;
      break;
    }

    lastBatchFull = clusters.length === FEED_BATCH_SIZE;
    const last: ClusterFeedRow = clusters[clusters.length - 1];
    cursor = sortByNew
      ? { a: last.last_seen, b: last.score, id: last.id }
      : { a: last.score, b: last.last_seen, id: last.id };

    const clusterIds = clusters.map(c => c.id);
    const placeholders = clusterIds.map((_, idx) => `?${idx + 1}`).join(',');
    const legacyIds: string[] = [];
    for (const c of clusters) {
      if (c.is_drop != null) continue;
      const domLower = c.domain?.toLowerCase();
      if (domLower && (isNewsDomain(domLower) || LEGACY_BLOCKED_DOMAINS.has(domLower))) continue;
      legacyIds.push(c.id);
    }
    const metaDomains = [
      ...new Set(
        clusters
          .map(c => c.domain?.toLowerCase())
          .filter((d): d is string => Boolean(d) && !isPlatformDomain(d!)),
      ),
    ];

    // Rich metadata and cached domain enrichment load in the same round trip as the posts.
    const [postRows, legacyRows, richByCluster, domainMetaByDomain] = await Promise.all([
      db
        .prepare(
          `SELECT p.cluster_id, p.source_id, p.post_url, p.posted_at, p.urls, s.platform, s.handle
           FROM posts p
           LEFT JOIN sources s ON s.id = p.source_id
           WHERE p.cluster_id IN (${placeholders})
             AND COALESCE(s.enabled, 1) = 1
           ORDER BY p.posted_at DESC, p.post_url ASC`,
        )
        .bind(...clusterIds)
        .all<FeedPostRow>(),
      legacyIds.length > 0
        ? db
            .prepare(
              `SELECT p.cluster_id, p.text, p.urls
               FROM posts p
               LEFT JOIN sources s ON s.id = p.source_id
               WHERE p.cluster_id IN (${legacyIds.map((_, idx) => `?${idx + 1}`).join(',')})
                 AND COALESCE(s.enabled, 1) = 1
               ORDER BY p.posted_at DESC, p.post_url ASC`,
            )
            .bind(...legacyIds)
            .all<LegacyPostRow>()
        : Promise.resolve({ results: [] as LegacyPostRow[] }),
      loadClusterRichMeta(db, clusterIds),
      loadDomainMeta(db, metaDomains),
    ]);

    const postsByCluster = new Map<string, ClusterPostAgg>();
    for (const row of postRows.results ?? []) {
      let entry = postsByCluster.get(row.cluster_id);
      if (!entry) {
        entry = {
          sources: [],
          seenSourceKeys: new Set(),
          distinctSourceIds: new Set(),
          minPostedAt: row.posted_at,
          maxPostedAt: row.posted_at,
          projectUrls: [],
          platformUrls: [],
          oldestPostUrls: [],
          seenProjectUrls: new Set(),
          seenPlatformUrls: new Set(),
        };
        postsByCluster.set(row.cluster_id, entry);
      } else {
        if (row.posted_at < entry.minPostedAt) entry.minPostedAt = row.posted_at;
        if (row.posted_at > entry.maxPostedAt) entry.maxPostedAt = row.posted_at;
      }

      entry.distinctSourceIds.add(row.source_id);

      const platform = row.platform ?? 'telegram';
      const handle = row.handle ?? 'unknown';
      const sourceKey = `${platform}:${handle.toLowerCase()}`;
      if (!entry.seenSourceKeys.has(sourceKey)) {
        entry.seenSourceKeys.add(sourceKey);
        if (entry.sources.length < 10) {
          entry.sources.push({
            platform,
            handle,
            postUrl: row.post_url,
            postedAt: row.posted_at,
          });
        }
      }

      try {
        const parsedUrls = JSON.parse(row.urls) as string[];
        if (Array.isArray(parsedUrls) && parsedUrls.length > 0) {
          entry.oldestPostUrls = parsedUrls;
          for (const u of parsedUrls) {
            const dom = getRegistrableDomain(u);
            if (dom && !isPlatformDomain(dom)) {
              if (entry.projectUrls.length < MAX_CLUSTER_URLS && !entry.seenProjectUrls.has(u)) {
                entry.seenProjectUrls.add(u);
                entry.projectUrls.push(u);
              }
            } else if (entry.platformUrls.length < MAX_CLUSTER_URLS && !entry.seenPlatformUrls.has(u)) {
              entry.seenPlatformUrls.add(u);
              entry.platformUrls.push(u);
            }
          }
        }
      } catch {
        // Ignore malformed URL JSON
      }
    }

    const legacyPostsByCluster = new Map<string, { text: string; urls: string[] }[]>();
    for (const row of legacyRows.results ?? []) {
      let arr = legacyPostsByCluster.get(row.cluster_id);
      if (!arr) {
        arr = [];
        legacyPostsByCluster.set(row.cluster_id, arr);
      }
      let parsedUrls: string[] = [];
      try {
        parsedUrls = JSON.parse(row.urls) as string[];
      } catch {
        // Ignore malformed URL JSON
      }
      arr.push({ text: row.text ?? '', urls: parsedUrls });
    }

    for (const c of clusters) {
      const postData = postsByCluster.get(c.id);
      const rawUrls = postData
        ? [...new Set([...postData.projectUrls, ...postData.oldestPostUrls, ...postData.platformUrls])]
        : [];
      const project = stripOrTranslateCjk(c.project) || 'Web3 Project';
      const chains = parseJsonArray<string>(c.chains).map(ch => stripOrTranslateCjk(ch)).filter(Boolean);
      const taskTypes = parseJsonArray<TaskType>(c.task_types);
      const storedReasons = parseJsonArray<string>(c.risk_reasons);

      // Defensive read-time gate for legacy D1 rows stored before pipeline cleanup.
      const domLower = c.domain?.toLowerCase();
      if (domLower && (isNewsDomain(domLower) || LEGACY_BLOCKED_DOMAINS.has(domLower))) {
        continue;
      }
      if (isGamblingPost({ project, domain: domLower, text: c.summary, urls: rawUrls })) {
        continue;
      }

      // Trust persisted ingest verdict (`is_drop === 1`) so CJK fallback summaries
      // ("Nexus: other") and >195-char drops are never hidden at read time.
      // For legacy pre-migration rows (`is_drop == null`) that have posts,
      // re-classify against complete post text and full post evidence.
      if (c.is_drop == null && postData) {
        const legacyPosts = legacyPostsByCluster.get(c.id) ?? [];
        const anyPostDrop = legacyPosts.some(lp =>
          classifyDropRelevance({
            text: lp.text || c.summary,
            urls: lp.urls.length > 0 ? lp.urls : rawUrls,
            projectDomain: domLower,
            taskTypes,
            hasSurfMatch: Boolean(c.surf_tier),
          }).isDrop,
        );
        const matchesSummary =
          legacyPosts.length === 0 &&
          classifyDropRelevance({
            text: c.summary,
            urls: rawUrls,
            projectDomain: domLower,
            taskTypes,
            hasSurfMatch: Boolean(c.surf_tier),
          }).isDrop;
        if (!anyPostDrop && !matchesSummary) continue;
      }

      const sourceHandles = new Set((postData?.sources ?? []).map(s => s.handle.toLowerCase()));
      const cleanDomain = domLower && !isPlatformDomain(domLower) ? domLower : undefined;

      const selectedUrls = selectFeedLinks(rawUrls, {
        projectDomain: cleanDomain,
        sourceHandles,
        allKnownDomains,
        maxLinks: 6,
      });
      const links = selectedUrls.map(url => {
        const isHttps = /^https:\/\//i.test(url);
        const dom = isHttps ? getRegistrableDomain(url) : undefined;
        return { url, known: Boolean(isHttps && dom && allKnownDomains.has(dom)) };
      });

      const reconciledRisk = reconcileSafetyReasons({
        level: c.risk_level,
        reasons: storedReasons,
        cleanedLinks: selectedUrls,
      });

      const summary =
        c.summary_source === 'rule'
          ? polishLegacyRuleSummary(c.summary, project, taskTypes, chains)
          : stripOrTranslateCjk(c.summary) || polishLegacyRuleSummary(c.summary, project, taskTypes, chains);

      const item: FeedItem = {
        id: c.id,
        project,
        chains,
        taskTypes,
        summary,
        summarySource: c.summary_source,
        links,
        sources: postData?.sources ?? [],
        sourceCount: postData ? postData.distinctSourceIds.size : c.source_count,
        score: c.score,
        risk: reconciledRisk,
        firstSeen: postData ? postData.minPostedAt : c.first_seen,
        lastSeen: postData ? postData.maxPostedAt : c.last_seen,
      };
      if (c.ticker && !MAJOR_TICKERS.has(c.ticker.toUpperCase())) item.ticker = c.ticker;
      if (cleanDomain) item.domain = cleanDomain;

      // Domain trust: an item with no resolvable domain has nothing untrusted to flag.
      item.verifiedDomain = !cleanDomain || allKnownDomains.has(cleanDomain);

      const radar = resolveRadarCard({ project, domain: cleanDomain, ticker: item.ticker }, opts.logoIndex);
      const domainMeta = cleanDomain ? domainMetaByDomain.get(cleanDomain) : undefined;
      const tvlUsd = radar?.tvlUsd ?? domainMeta?.tvl_usd;
      if (radar?.id) item.radarId = radar.id;
      if (radar?.funding) item.funding = cleanMetaText(radar.funding, 40);
      if (typeof tvlUsd === 'number' && Number.isFinite(tvlUsd) && tvlUsd > 0) item.tvlUsd = tvlUsd;

      const rich = richByCluster.get(c.id);
      if (rich) {
        const rewardPool = cleanMetaText(rich.reward_pool, 60);
        const deadline = cleanMetaText(rich.deadline, 40);
        const cost = cleanMetaText(rich.cost, 40);
        if (rewardPool) item.rewardPool = rewardPool;
        if (deadline) item.deadline = deadline;
        if (cost) item.cost = cost;
        const steps = (rich.steps ? parseJsonArray<string>(rich.steps) : [])
          .map(step => cleanMetaText(step, 100))
          .filter((step): step is string => Boolean(step))
          .slice(0, MAX_STEPS);
        if (steps.length > 0) item.steps = steps;
      }
      if (domainMeta) {
        const ogImage = safeHttpsUrl(domainMeta.og_image);
        const ogTitle = cleanMetaText(domainMeta.og_title, 140);
        const ogDescription = cleanMetaText(domainMeta.og_description, 300);
        if (ogImage) item.ogImage = ogImage;
        if (ogTitle) item.ogTitle = ogTitle;
        if (ogDescription) item.ogDescription = ogDescription;
      }

      const logo =
        resolveFeedItemLogo(
          { project, domain: cleanDomain, ticker: item.ticker, riskLevel: reconciledRisk.level },
          opts.logoIndex,
        ) ??
        // A cached third-party logo is borrowed only by clusters that are not flagged risky.
        (reconciledRisk.level !== 'risk' ? safeHttpsUrl(domainMeta?.logo_url) ?? undefined : undefined);
      if (logo) item.logo = logo;
      if (c.surf_tier || c.surf_rank != null) {
        item.surf = {
          tier: c.surf_tier ?? undefined,
          cardRank: c.surf_rank ?? undefined,
        };
      }

      if (isGamblingFeedItem(item)) continue;

      items.push(item);
      if (items.length >= limit) break;
    }

    if (clusters.length < FEED_BATCH_SIZE) break;
  }

  const contentTs = opts.contentTs ?? items.reduce((m, it) => Math.max(m, it.lastSeen), 0);
  const res: FeedResponse = {
    generatedAt: contentTs,
    items,
  };
  if (items.length < limit && lastBatchFull && cursor) {
    res.cursor = encodeFeedCursor(sortByNew, cursor);
  }
  return res;
}

export async function querySourcesHealth(db: D1Database): Promise<SourceHealth[]> {
  const res = await db
    .prepare(
      `SELECT id, platform, handle, status, last_ok_at
       FROM sources
       WHERE enabled = 1
       ORDER BY platform ASC, handle ASC`,
    )
    .all<{
      id: string;
      platform: string;
      handle: string;
      status: 'ok' | 'degraded' | 'down';
      last_ok_at: number | null;
    }>();
  return (res.results ?? []).map(r => ({
    id: r.id,
    platform: r.platform,
    handle: r.handle,
    status: r.status,
    lastOkAt: r.last_ok_at,
  }));
}
