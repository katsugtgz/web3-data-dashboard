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
import { evaluateSafety } from '../safety';
import { getRegistrableDomain } from './parse';
import { computeScore } from './score';
import {
  buildRuleSummary,
  parseDropPost,
  type ParseContext,
  type ParsedDrop,
  type SurfMatch,
} from './parse';

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
      if (dom && !byDomain.has(dom)) byDomain.set(dom, match);
    }
  }
  return { byDomain, byTicker };
}

export function normalizeProjectKey(project: string): string {
  return project.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export async function computeClusterId(
  domain?: string,
  ticker?: string,
  project?: string,
  fallbackPostId?: string,
): Promise<string> {
  if (domain) {
    return sha1Hex(`dom:${domain.toLowerCase()}`);
  }
  if (ticker) {
    return sha1Hex(`tick:$${ticker.toUpperCase()}`);
  }
  const normProj = normalizeProjectKey(project ?? '');
  if (!normProj || normProj === 'web3project') {
    return sha1Hex(`post:${fallbackPostId ?? 'unknown'}`);
  }
  return sha1Hex(`proj:${normProj}`);
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
): Promise<IngestPostResult> {
  const parsed = parseDropPost(input.text, input.htmlUrls ?? [], {
    ...parseCtx,
    surfByDomain: surfIndex.byDomain,
    surfByTicker: surfIndex.byTicker,
  });

  const clusterId = await computeClusterId(parsed.projectDomain, parsed.ticker, parsed.project, input.postId);

  const [insertPost, existing, prevAgg] = await Promise.all([
    db
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
      .run(),
    db
      .prepare(
        `SELECT id, project, ticker, domain, chains, task_types, summary, summary_source, risk_level, risk_reasons,
                score, source_count, surf_tier, surf_rank, first_seen, last_seen
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

  const safety = evaluateSafety({
    domain: parsed.projectDomain ?? existing?.domain ?? undefined,
    urls: parsed.urls,
    text: input.text,
    knownProjectDomains,
    platformDomains,
    trustMax,
    sourceCount,
  });

  // Escalate risk conservatively across merged posts, but clear single-low-trust warning once sourceCount > 1
  const filteredPrevReasons =
    sourceCount > 1 ? prevReasons.filter(r => r !== 'Single low-trust source') : prevReasons;
  const mergedReasons = unionStrings(filteredPrevReasons, safety.reasons);
  let mergedRisk: RiskLevel = safety.level;
  if (existing?.risk_level === 'risk' || mergedRisk === 'risk') mergedRisk = 'risk';
  else if (existing?.risk_level === 'warn' || mergedRisk === 'warn') {
    mergedRisk = mergedReasons.length > 0 ? 'warn' : 'ok';
  }

  const project = existing?.project ?? parsed.project;
  const ticker = existing?.ticker ?? parsed.ticker ?? null;
  const domain = existing?.domain ?? parsed.projectDomain ?? null;
  const surfTier = existing?.surf_tier ?? surfMatch?.tier ?? null;
  const surfRank = existing?.surf_rank ?? surfMatch?.cardRank ?? null;
  const firstSeen = existing ? Math.min(existing.first_seen, input.postedAt) : input.postedAt;
  const lastSeen = existing ? Math.max(existing.last_seen, input.postedAt) : input.postedAt;

  let summary = existing?.summary ?? parsed.summary;
  let summarySource: 'rule' | 'ai' = existing?.summary_source ?? 'rule';
  if (existing && existing.summary_source === 'rule' && !parsed.isNonLatinSource && existing.summary.startsWith(`${existing.project}:`)) {
    summary = buildRuleSummary(input.text, project, mergedTasks, mergedChains).summary;
  }

  const score = computeScore({
    trustMax,
    sourceCount,
    lastSeen,
    nowMs,
    surfTier,
    riskLevel: mergedRisk,
  });

  if (existing) {
    // Merge against the STORED row, not the stale in-memory `existing` read:
    // a concurrent ingest may have escalated risk between our SELECT and this
    // UPDATE, and a plain `risk_level = ?9` would silently downgrade it.
    // Same JSON-union + escalation as the first-insert conflict path; dates
    // stay monotonic; an AI summary is never overwritten by rule output.
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
             WHERE value != 'Single low-trust source'
                OR MAX(clusters.source_count, ?12) <= 1
           ),
           -- Mirrors the JS mergedRisk merge: 'warn' survives only while
           -- reasons remain after the single-low-trust filter (which drops
           -- it once the merged cluster has 2+ sources); no reasons → 'ok'.
           risk_level = CASE
             WHEN clusters.risk_level = 'risk' OR ?9 = 'risk' THEN 'risk'
             WHEN (clusters.risk_level = 'warn' OR ?9 = 'warn')
                  AND EXISTS (
                    SELECT 1
                    FROM (SELECT value FROM json_each(clusters.risk_reasons)
                          UNION
                          SELECT value FROM json_each(?10))
                    WHERE value != 'Single low-trust source'
                       OR MAX(clusters.source_count, ?12) <= 1
                  )
               THEN 'warn'
             ELSE 'ok'
           END,
           -- The racing writer computed ?11 from its stale (pre-escalation)
           -- risk view. If the MERGED level is risk, the penalty must apply:
           -- take the smaller (penalized) score; a legitimately higher score
           -- from a risk-free concurrent path still wins via MAX semantics.
           score = CASE
             WHEN CASE
                    WHEN clusters.risk_level = 'risk' OR ?9 = 'risk' THEN 'risk'
                    WHEN (clusters.risk_level = 'warn' OR ?9 = 'warn')
                         AND EXISTS (
                           SELECT 1
                           FROM (SELECT value FROM json_each(clusters.risk_reasons)
                                 UNION
                                 SELECT value FROM json_each(?10))
                           WHERE value != 'Single low-trust source'
                              OR MAX(clusters.source_count, ?12) <= 1
                         )
                      THEN 'warn'
                    ELSE 'ok'
                  END = 'risk'
             THEN MIN(clusters.score, ?11)
             ELSE MAX(clusters.score, ?11)
           END,
           source_count = MAX(clusters.source_count, ?12),
           surf_tier = COALESCE(?13, clusters.surf_tier), surf_rank = COALESCE(?14, clusters.surf_rank),
           first_seen = MIN(clusters.first_seen, ?15), last_seen = MAX(clusters.last_seen, ?16),
           project = ?2, ticker = COALESCE(?3, clusters.ticker), domain = COALESCE(?4, clusters.domain)
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
      )
      .run();
  } else {
    await db
      .prepare(
        `INSERT INTO clusters (id, project, ticker, domain, chains, task_types, summary, summary_source, risk_level, risk_reasons, score, source_count, surf_tier, surf_rank, first_seen, last_seen)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
         ON CONFLICT(id) DO UPDATE SET
           -- Two concurrent first posts for one cluster can both land here.
           -- The loser must MERGE into the winner, not overwrite it: union the
           -- chain/task sets, escalate risk conservatively, and merge reasons.
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
             -- The single-low-trust warning is meaningless once the cluster
             -- has 2+ distinct sources (post-merge count is knowable here).
             WHERE value != 'Single low-trust source'
                OR MAX(clusters.source_count, excluded.source_count) <= 1
           ),
           -- Mirrors the JS mergedRisk merge: 'warn' survives only while
           -- reasons remain after the single-low-trust filter; none → 'ok'.
           risk_level = CASE
             WHEN clusters.risk_level = 'risk' OR excluded.risk_level = 'risk' THEN 'risk'
             WHEN (clusters.risk_level = 'warn' OR excluded.risk_level = 'warn')
                  AND EXISTS (
                    SELECT 1
                    FROM (SELECT value FROM json_each(clusters.risk_reasons)
                          UNION
                          SELECT value FROM json_each(excluded.risk_reasons))
                    WHERE value != 'Single low-trust source'
                       OR MAX(clusters.source_count, excluded.source_count) <= 1
                  )
               THEN 'warn'
             ELSE 'ok'
           END,
           summary = CASE WHEN clusters.summary_source = 'ai' THEN clusters.summary ELSE excluded.summary END,
           summary_source = CASE WHEN clusters.summary_source = 'ai' THEN 'ai' ELSE 'rule' END,
           first_seen = MIN(clusters.first_seen, excluded.first_seen),
           -- A concurrent risky first post escalates the merged level to
           -- 'risk', but its own score is the only penalized one: the stored
           -- safe post's score was computed risk-free. MIN applies the
           -- penalty; MAX keeps a legitimately higher risk-free score.
           score = CASE
             WHEN CASE
                    WHEN clusters.risk_level = 'risk' OR excluded.risk_level = 'risk' THEN 'risk'
                    WHEN (clusters.risk_level = 'warn' OR excluded.risk_level = 'warn')
                         AND EXISTS (
                           SELECT 1
                           FROM (SELECT value FROM json_each(clusters.risk_reasons)
                                 UNION
                                 SELECT value FROM json_each(excluded.risk_reasons))
                           WHERE value != 'Single low-trust source'
                              OR MAX(clusters.source_count, excluded.source_count) <= 1
                         )
                      THEN 'warn'
                    ELSE 'ok'
                  END = 'risk'
             THEN MIN(clusters.score, excluded.score)
             ELSE MAX(clusters.score, excluded.score)
           END,
           source_count = MAX(clusters.source_count, excluded.source_count),
           last_seen = MAX(clusters.last_seen, excluded.last_seen)`,
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
      )
      .run();
  }

  return {
    clusterId,
    sourceId: input.sourceId,
    rawText: input.text,
    forwardedFrom: input.forwardedFrom ?? null,
    isNewCluster: !existing && (insertPost.meta?.changes ?? 1) > 0,
    isNonLatinSource: parsed.isNonLatinSource,
    riskLevel: mergedRisk,
    parsed,
  };
}

export interface FeedQueryOptions {
  since?: number;
  limit?: number;
  risk?: 'include' | 'exclude';
  sort?: 'score' | 'new';
  /** Content-derived payload timestamp (excluded from the ETag digest). */
  contentTs?: number;
}

export async function queryFeed(
  db: D1Database,
  allKnownDomains: Set<string>,
  opts: FeedQueryOptions = {},
): Promise<FeedResponse> {
  // D1 caps bound parameters per query (100): the posts IN (...) query binds
  // one per returned cluster, so the effective limit can never exceed 100.
  // NaN / non-finite fall back to the default instead of failing SQL.
  const rawLimit = Number(opts.limit);
  const safeLimit = Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 100;
  const limit = Math.min(100, Math.max(1, safeLimit));
  const since = Number.isFinite(opts.since) ? Number(opts.since) : 0;
  const riskClause = opts.risk === 'exclude' ? `AND risk_level != 'risk'` : '';
  // Deterministic total order: score/last_seen ties are broken by id, so two
  // cache-miss builds of the same data produce byte-identical bodies (and
  // therefore the same ETag) regardless of row return order.
  const orderCol =
    opts.sort === 'new' ? 'last_seen DESC, score DESC, id ASC' : 'score DESC, last_seen DESC, id ASC';

  const clusterRows = await db
    .prepare(
      `SELECT id, project, ticker, domain, chains, task_types, summary, summary_source,
              risk_level, risk_reasons, score, source_count, surf_tier, surf_rank, first_seen, last_seen
       FROM clusters
       WHERE last_seen >= ?1 ${riskClause}
       ORDER BY ${orderCol}
       LIMIT ?2`,
    )
    .bind(since, limit)
    .all<{
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
    }>();

  const clusters = clusterRows.results ?? [];
  if (clusters.length === 0) {
    // Constant: an empty payload must produce a byte-identical body (and ETag)
    // on every cache miss. Date.now() here would invalidate the validator even
    // though no content changed.
    return { generatedAt: opts.contentTs ?? 0, items: [] };
  }

  const clusterIds = clusters.map(c => c.id);
  const placeholders = clusterIds.map((_, idx) => `?${idx + 1}`).join(',');
  const postRows = await db
    .prepare(
      `SELECT p.cluster_id, p.post_url, p.posted_at, p.urls, s.platform, s.handle
       FROM posts p
       LEFT JOIN sources s ON s.id = p.source_id
       WHERE p.cluster_id IN (${placeholders})
       ORDER BY p.posted_at DESC, p.post_url ASC`,
    )
    .bind(...clusterIds)
    .all<{
      cluster_id: string;
      post_url: string;
      posted_at: number;
      urls: string;
      platform: 'telegram' | 'x' | 'surf' | null;
      handle: string | null;
    }>();

  const postsByCluster = new Map<string, { sources: FeedSourceRef[]; urls: Set<string> }>();
  for (const row of postRows.results ?? []) {
    let entry = postsByCluster.get(row.cluster_id);
    if (!entry) {
      entry = { sources: [], urls: new Set() };
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
    try {
      const parsedUrls = JSON.parse(row.urls) as string[];
      for (const u of parsedUrls) entry.urls.add(u);
    } catch {
      // Ignore malformed URL JSON
    }
  }

  const items: FeedItem[] = clusters.map(c => {
    const postData = postsByCluster.get(c.id);
    const links = [...(postData?.urls ?? [])].slice(0, 8).map(url => {
      const dom = getRegistrableDomain(url);
      return { url, known: Boolean(dom && allKnownDomains.has(dom)) };
    });
    const item: FeedItem = {
      id: c.id,
      project: c.project,
      chains: JSON.parse(c.chains) as string[],
      taskTypes: JSON.parse(c.task_types) as TaskType[],
      summary: c.summary,
      summarySource: c.summary_source,
      links,
      sources: postData?.sources ?? [],
      sourceCount: c.source_count,
      score: c.score,
      risk: {
        level: c.risk_level,
        reasons: JSON.parse(c.risk_reasons) as string[],
      },
      firstSeen: c.first_seen,
      lastSeen: c.last_seen,
    };
    if (c.ticker) item.ticker = c.ticker;
    if (c.domain) item.domain = c.domain;
    if (c.surf_tier || c.surf_rank != null) {
      item.surf = {
        tier: c.surf_tier ?? undefined,
        cardRank: c.surf_rank ?? undefined,
      };
    }
    return item;
  });

  // Content-derived freshness: newest cluster activity, kept stable while the
  // payload is unchanged so the ETag (which excludes generatedAt) stays valid.
  const contentTs = opts.contentTs ?? items.reduce((m, it) => Math.max(m, it.lastSeen), 0);

  return {
    generatedAt: contentTs,
    items,
  };
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
