import type {
  AirdropFeed,
  FeedItem,
  FeedResponse,
  FeedSourceRef,
  Grade,
  RiskLevel,
  SourceHealth,
  TaskType,
} from '../../../shared/types';
import { sha1Hex } from '../lib/hash';
import { evaluateSafety, reconcileSafetyReasons } from '../safety';
import {
  getRegistrableDomain,
  isNewsDomain,
  isPlatformDomain,
  selectFeedLinks,
} from './domains';
import {
  buildRuleSummary,
  parseDropPost,
  type ParseContext,
  type ParsedDrop,
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
}

export function buildSurfIndex(feed?: AirdropFeed | null): SurfIndex {
  const byDomain = new Map<string, SurfMatch>();
  const byTicker = new Map<string, SurfMatch>();
  if (!feed) return { byDomain, byTicker };

  for (const card of feed.cards) {
    const match: SurfMatch = { name: card.n, tier: card.g, cardRank: card.r };
    if (card.t) byTicker.set(card.t.toUpperCase(), match);
    const urls = [card.url, ...(card.tasks?.map(t => t.url) ?? [])];
    for (const raw of urls) {
      if (!raw) continue;
      const dom = getRegistrableDomain(raw);
      if (dom && !isPlatformDomain(dom) && !byDomain.has(dom)) byDomain.set(dom, match);
    }
  }
  return { byDomain, byTicker };
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
  const suffix = attempt >= 2 ? `:${attempt}` : '';
  return sha1Hex(`${baseClusterId}:win:${postedAt}:${postId}${suffix}`);
}

/**
 * Resolves the target cluster ID using sliding time windows for fallback
 * ticker (7d) and project (3d) clusters when no canonical project domain is
 * present. Checks `baseClusterId` occupancy via PK lookup outside any LIMITed
 * candidate query and filters project candidates by normalized `project_key`
 * before limiting.
 */
async function resolveClusterId(
  db: D1Database,
  parsed: ParsedDrop,
  input: IngestPostInput,
  attempt = 0,
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
      r => r.id === baseClusterId || r.ticker?.toUpperCase() === tickerUpper,
    );
    if (match) return match.id;
    if (baseRow) {
      return mintWindowedClusterId(baseClusterId, input.postedAt, input.postId, attempt);
    }
    return baseClusterId;
  }

  if (isValidProjectClusterKey(parsed.project)) {
    const normProj = normalizeProjectKey(parsed.project);
    const windowMs = THREE_DAYS_MS;
    const [baseRow, res] = await Promise.all([
      db
        .prepare('SELECT id, project, first_seen, last_seen FROM clusters WHERE id = ?1')
        .bind(baseClusterId)
        .first<WindowCandidateRow & { project: string }>(),
      db
        .prepare(
          `SELECT id, project, first_seen, last_seen
           FROM clusters
           WHERE domain IS NULL
             AND last_seen >= ?2
             AND first_seen <= ?3
             AND (
               project_key = ?1
               OR (
                 project_key IS NULL
                 AND lower(replace(replace(replace(replace(replace(replace(project, ' ', ''), '-', ''), '_', ''), '.', ''), ':', ''), '/', '')) = ?1
               )
             )
           ORDER BY last_seen DESC, id ASC
           LIMIT 200`,
        )
        .bind(normProj, input.postedAt - windowMs, input.postedAt + windowMs)
        .all<WindowCandidateRow & { project: string }>(),
    ]);

    const candidates = baseRow ? [baseRow, ...(res.results ?? [])] : (res.results ?? []);
    const match = pickBestWindowCandidate(
      candidates,
      input.postedAt,
      windowMs,
      r => r.id === baseClusterId || normalizeProjectKey(r.project) === normProj,
    );
    if (match) return match.id;
    if (baseRow) {
      return mintWindowedClusterId(baseClusterId, input.postedAt, input.postId, attempt);
    }
    return baseClusterId;
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
    .prepare('SELECT cluster_id FROM posts WHERE id = ?1')
    .bind(input.postId)
    .first<{ cluster_id: string | null }>();
  const replayedClusterId = existingPost?.cluster_id ?? null;
  const fallbackIdentity = replayedClusterId ? null : getFallbackIdentity(parsed, input.postedAt);

  return withFallbackLock(db, fallbackIdentity?.key ?? null, async () => {
    const maxAttempts = fallbackIdentity ? 4 : 1;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const clusterId = replayedClusterId ?? (await resolveClusterId(db, parsed, input, attempt));

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
            `SELECT DISTINCT p.source_id, COALESCE(s.trust, ?2) AS trust
             FROM posts p
             LEFT JOIN sources s ON s.id = p.source_id
             WHERE p.cluster_id = ?1`,
          )
          .bind(clusterId, input.sourceTrust)
          .all<{ source_id: string; trust: number }>(),
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
      const domainIsKnown = Boolean(
        resolvedDomain && (knownProjectDomains.has(resolvedDomain.toLowerCase()) || isPlatformDomain(resolvedDomain)),
      );
      const exactUnverifiedReason = resolvedDomain
        ? `domain not in verified registry: ${resolvedDomain.toLowerCase()}`
        : '';

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
      // single-low-trust and exact-matching unverified-registry warnings once
      // corroborated or seeded into known_domains.
      const filteredPrevReasons = prevReasons.filter(r => {
        if (sourceCount > 1 && r === 'Single low-trust source') return false;
        if (domainIsKnown && exactUnverifiedReason && r.trim().toLowerCase() === exactUnverifiedReason) return false;
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
      const firstSeen = existing ? Math.min(existing.first_seen, input.postedAt) : input.postedAt;
      const lastSeen = existing ? Math.max(existing.last_seen, input.postedAt) : input.postedAt;

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

      const domainKnownFlag = domainIsKnown ? 1 : 0;
      const isDropFlag = parsed.isRelevantDrop ? 1 : 0;

      if (existing) {
        // Merge against the STORED row, not the stale in-memory `existing` read:
        // a concurrent ingest may have escalated risk between our SELECT and this
        // UPDATE, and a plain `risk_level = ?9` would silently downgrade it.
        await db
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
                   AND (?17 = 0 OR ?18 = '' OR lower(trim(value)) != ?18)
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
                          AND (?17 = 0 OR ?18 = '' OR lower(trim(value)) != ?18)
                      )
                   THEN 'warn'
                 ELSE 'ok'
               END,
               score = CASE
                 WHEN CASE
                        WHEN clusters.risk_level = 'risk' OR ?9 = 'risk' THEN 'risk'
                        WHEN (clusters.risk_level = 'warn' OR ?9 = 'warn')
                             AND EXISTS (
                               SELECT 1
                               FROM (SELECT value FROM json_each(clusters.risk_reasons)
                                     UNION
                                     SELECT value FROM json_each(?10))
                               WHERE (value != 'Single low-trust source' OR MAX(clusters.source_count, ?12) <= 1)
                                 AND (?17 = 0 OR ?18 = '' OR lower(trim(value)) != ?18)
                             )
                          THEN 'warn'
                        ELSE 'ok'
                      END = 'risk'
                 THEN MIN(clusters.score, ?11)
                 ELSE MAX(clusters.score, ?11)
               END,
               source_count = MAX(clusters.source_count, ?12),
               trust_max = MAX(clusters.trust_max, ?20),
               surf_tier = COALESCE(?13, clusters.surf_tier), surf_rank = COALESCE(?14, clusters.surf_rank),
               first_seen = MIN(clusters.first_seen, ?15), last_seen = MAX(clusters.last_seen, ?16),
               project = ?2, ticker = COALESCE(?3, clusters.ticker), domain = COALESCE(?4, clusters.domain),
               is_drop = CASE WHEN clusters.is_drop = 1 OR ?19 = 1 THEN 1 ELSE COALESCE(clusters.is_drop, ?19) END,
               project_key = COALESCE(clusters.project_key, ?21)
             WHERE id = ?1`,
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
            domainKnownFlag,
            exactUnverifiedReason,
            isDropFlag,
            trustMax,
            projectKey,
          )
          .run();
      } else {
        const upsertRes = await db
          .prepare(
            `INSERT INTO clusters (id, project, ticker, domain, chains, task_types, summary, summary_source, risk_level, risk_reasons, score, source_count, surf_tier, surf_rank, first_seen, last_seen, is_drop, trust_max, project_key)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?19, ?20, ?21)
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
                   AND (?17 = 0 OR ?18 = '' OR lower(trim(value)) != ?18)
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
                          AND (?17 = 0 OR ?18 = '' OR lower(trim(value)) != ?18)
                      )
                   THEN 'warn'
                 ELSE 'ok'
               END,
               summary = CASE WHEN clusters.summary_source = 'ai' THEN clusters.summary ELSE excluded.summary END,
               summary_source = CASE WHEN clusters.summary_source = 'ai' THEN 'ai' ELSE 'rule' END,
               first_seen = MIN(clusters.first_seen, excluded.first_seen),
               score = CASE
                 WHEN CASE
                        WHEN clusters.risk_level = 'risk' OR excluded.risk_level = 'risk' THEN 'risk'
                        WHEN (clusters.risk_level = 'warn' OR excluded.risk_level = 'warn')
                             AND EXISTS (
                               SELECT 1
                               FROM (SELECT value FROM json_each(clusters.risk_reasons)
                                     UNION
                                     SELECT value FROM json_each(excluded.risk_reasons))
                               WHERE (value != 'Single low-trust source' OR MAX(clusters.source_count, excluded.source_count) <= 1)
                                 AND (?17 = 0 OR ?18 = '' OR lower(trim(value)) != ?18)
                             )
                          THEN 'warn'
                        ELSE 'ok'
                      END = 'risk'
                 THEN MIN(clusters.score, excluded.score)
                 ELSE MAX(clusters.score, excluded.score)
               END,
               source_count = MAX(clusters.source_count, excluded.source_count),
               last_seen = MAX(clusters.last_seen, excluded.last_seen),
               is_drop = CASE WHEN clusters.is_drop = 1 OR excluded.is_drop = 1 THEN 1 ELSE COALESCE(clusters.is_drop, excluded.is_drop) END,
               trust_max = MAX(clusters.trust_max, excluded.trust_max),
               project_key = COALESCE(clusters.project_key, excluded.project_key)
             WHERE ?22 IS NULL OR (?23 >= clusters.first_seen - ?22 AND ?23 <= clusters.last_seen + ?22)`,
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
            domainKnownFlag,
            exactUnverifiedReason,
            isDropFlag,
            trustMax,
            projectKey,
            fallbackIdentity?.windowMs ?? null,
            Number.isFinite(input.postedAt) ? input.postedAt : null,
          )
          .run();

        if (fallbackIdentity && (upsertRes.meta?.changes ?? 1) === 0 && attempt < maxAttempts - 1) {
          continue;
        }
      }

      let postInserted = false;
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

      return {
        clusterId,
        sourceId: input.sourceId,
        rawText: input.text,
        forwardedFrom: input.forwardedFrom ?? null,
        isNewCluster: !existing && postInserted,
        isNonLatinSource: parsed.isNonLatinSource,
        riskLevel: mergedRisk,
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
  post_url: string;
  posted_at: number;
  urls: string;
  platform: 'telegram' | 'x' | 'surf' | null;
  handle: string | null;
}

interface LegacyPostRow {
  cluster_id: string;
  text: string;
  urls: string;
}

function polishLegacyRuleSummary(
  summary: string,
  project: string,
  taskTypes: TaskType[],
  chains: string[],
): string {
  const cleaned = cleanSummaryText(summary);
  if (!cleaned || detectNonEnglishLatin(cleaned)) {
    const tasksText = taskTypes.join(', ');
    const chainsText = chains.length > 0 ? ` on ${chains.join(', ')}` : '';
    return truncateAtWordBoundary(`${project}: ${tasksText}${chainsText}`, 195);
  }
  return truncateAtWordBoundary(cleaned, 195);
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
  const riskClause = opts.risk === 'exclude' ? `AND risk_level != 'risk'` : '';
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
        `SELECT id, project, ticker, domain, chains, task_types, summary, summary_source,
                risk_level, risk_reasons, score, source_count, surf_tier, surf_rank, first_seen, last_seen, is_drop
         FROM clusters
         WHERE last_seen >= ?1
           AND COALESCE(is_drop, 1) = 1
           ${riskClause}
           ${cursorClause}
           AND (
             NOT EXISTS (SELECT 1 FROM posts p WHERE p.cluster_id = clusters.id)
             OR EXISTS (
               SELECT 1 FROM posts p
               LEFT JOIN sources s ON s.id = p.source_id
               WHERE p.cluster_id = clusters.id AND COALESCE(s.enabled, 1) = 1
             )
           )
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

    const [postRows, legacyRows] = await Promise.all([
      db
        .prepare(
          `SELECT p.cluster_id, p.post_url, p.posted_at, p.urls, s.platform, s.handle
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
    ]);

    const postsByCluster = new Map<string, { sources: FeedSourceRef[]; urls: string[] }>();
    for (const row of postRows.results ?? []) {
      let entry = postsByCluster.get(row.cluster_id);
      if (!entry) {
        entry = { sources: [], urls: [] };
        postsByCluster.set(row.cluster_id, entry);
      }
      if (entry.sources.length < 10) {
        entry.sources.push({
          platform: row.platform ?? 'telegram',
          handle: row.handle ?? 'unknown',
          postUrl: row.post_url,
          postedAt: row.posted_at,
        });
      }
      if (entry.urls.length < MAX_CLUSTER_URLS) {
        try {
          const parsedUrls = JSON.parse(row.urls) as string[];
          for (const u of parsedUrls) {
            if (entry.urls.length >= MAX_CLUSTER_URLS) break;
            entry.urls.push(u);
          }
        } catch {
          // Ignore malformed URL JSON
        }
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
      const rawUrls = postData?.urls ?? [];
      const chains = JSON.parse(c.chains) as string[];
      const taskTypes = JSON.parse(c.task_types) as TaskType[];
      const storedReasons = JSON.parse(c.risk_reasons) as string[];

      // Defensive read-time gate for legacy D1 rows stored before pipeline cleanup.
      const domLower = c.domain?.toLowerCase();
      if (domLower && (isNewsDomain(domLower) || LEGACY_BLOCKED_DOMAINS.has(domLower))) {
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
        const dom = getRegistrableDomain(url);
        return { url, known: Boolean(dom && allKnownDomains.has(dom)) };
      });

      const reconciledRisk = reconcileSafetyReasons({
        level: c.risk_level,
        reasons: storedReasons,
        domain: cleanDomain,
        cleanedLinks: selectedUrls,
        knownDomains: allKnownDomains,
      });

      const summary =
        c.summary_source === 'rule'
          ? polishLegacyRuleSummary(c.summary, c.project, taskTypes, chains)
          : c.summary;

      const item: FeedItem = {
        id: c.id,
        project: c.project,
        chains,
        taskTypes,
        summary,
        summarySource: c.summary_source,
        links,
        sources: postData?.sources ?? [],
        sourceCount: c.source_count,
        score: c.score,
        risk: reconciledRisk,
        firstSeen: c.first_seen,
        lastSeen: c.last_seen,
      };
      if (c.ticker && !MAJOR_TICKERS.has(c.ticker.toUpperCase())) item.ticker = c.ticker;
      if (cleanDomain) item.domain = cleanDomain;
      if (c.surf_tier || c.surf_rank != null) {
        item.surf = {
          tier: c.surf_tier ?? undefined,
          cardRank: c.surf_rank ?? undefined,
        };
      }

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
