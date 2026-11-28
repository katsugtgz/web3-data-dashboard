import type { AirdropFeed, Badge, Card, CardTask, FitKey, Grade, Tge } from '../../../shared/types';
import { filterGamblingAirdropFeed } from '../../../shared/gamblingFilter';
import { fmtUsd, USER_AGENT } from '../lib/format';
import { safeHttpUrl, safeHttpsUrl } from '../lib/url';
import {
  mapFitKey,
  stripOrTranslateCjk,
  translateRiskItem,
  translateTagLabel,
  translateTgeStatus,
} from '../normalize/i18n';

export const SURF_AIRDROPS_URL = 'https://import-command-query-8ca052.surf.computer/api/airdrops';

export interface UpstreamTag {
  key: string;
  label?: string;
  risks?: string[];
}

export interface UpstreamTask {
  title?: string;
  type?: string;
  status?: string;
  is_exclusive?: boolean;
  cost?: number;
  time_minutes?: number | null;
  external_link?: string | null;
  blockchains?: ({ name?: string } | string)[];
}

export interface UpstreamProject {
  project_id?: string;
  project_name: string;
  chains?: { name: string }[];
  coin_symbol?: string | null;
  status?: string;
  tier?: string;
  tags?: UpstreamTag[];
  is_launched?: boolean;
  is_us_stock_token?: boolean;
  logo_url?: string | null;
  total_raise?: number | string | null;
  reward_date?: number | string | null;
  task_summary?: { open?: number; total?: number; types?: string[] };
  tasks?: UpstreamTask[];
  best_task?: UpstreamTask;
  xscore?: number | string;
  last_status_update?: number | string;
  fit?: string[];
  score?: number | string;
  token_launch_score?: number | string;
  cost_perf_score?: number | string;
}

export interface UpstreamBody {
  active: UpstreamProject[];
  tge?: UpstreamProject[];
  counts?: { active_total?: number; active_unlaunched?: number };
}

const BADGE_KEYS: Record<string, Badge> = {
  announced: 'live',
  early: 'early',
  zerocost: 'zero',
  rerun: 'rerun',
  risk: 'risk',
};

const TASK_TYPE: Record<string, string> = {
  'mint-nft': 'mint',
  'mint-domain': 'mint',
  'bounty-platforms': 'bounty',
  node: 'depin',
  hold: 'staking',
};

/**
 * Normalizes upstream task links: upgrades scheme-less links like
 * `t.me/DoodlesUP_bot` to `https://t.me/DoodlesUP_bot` while rejecting
 * non-http(s) schemes (`javascript:`, `data:`), whitespace, and userinfo.
 */
export function normalizeExternalUrl(raw?: string | null): string | null {
  return safeHttpUrl(raw, { allowBareDomain: true });
}

function normalizeGrade(tier?: string): Grade {
  if (tier === 'S' || tier === 'A' || tier === 'B' || tier === 'C') return tier;
  return 'B';
}

function normalizeTaskType(raw?: string): string {
  if (!raw) return '';
  const cleaned = stripOrTranslateCjk(raw);
  // Unmapped CJK-only types strip to ''; TASK_TYPES needs a non-empty entry
  // so type labels and filter chips stay populated.
  return TASK_TYPE[cleaned] ?? (cleaned || 'other');
}

function safeNum(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function ago(ts: number, nowMs: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '—';
  const days = Math.max(0, (nowMs / 1000 - ts) / 86400);
  if (days < 1) return 'today';
  return days < 30 ? `${Math.floor(days)}d` : `${Math.floor(days / 30)}mo`;
}

function formatIsoDate(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return 'TBA';
  const d = new Date(ts * 1000);
  if (Number.isNaN(d.getTime())) return 'TBA';
  return d.toISOString().slice(0, 10);
}

function sanitizeLogo(url?: string | null): string {
  const safe = safeHttpsUrl(url);
  if (!safe) return '';
  const host = new URL(safe).hostname.toLowerCase();
  if (host === 'surf.computer' || host.endsWith('.surf.computer')) return '';
  return safe;
}

function extractChains(p: UpstreamProject): string[] {
  const set = new Set<string>();
  for (const c of p.chains ?? []) {
    const clean = c?.name ? stripOrTranslateCjk(c.name) : '';
    if (clean) set.add(clean);
  }
  for (const bc of p.best_task?.blockchains ?? []) {
    const raw = typeof bc === 'string' ? bc : bc?.name;
    const clean = raw ? stripOrTranslateCjk(raw) : '';
    if (clean) set.add(clean);
  }
  return [...set];
}

function extractRiskLabel(tags?: UpstreamTag[]): string | undefined {
  const riskTag = tags?.find(t => t.key === 'risk');
  if (!riskTag) return undefined;
  const risks = (riskTag.risks ?? []).map(translateRiskItem).filter(Boolean);
  if (risks.length > 0) return risks.join(', ');
  const label = translateTagLabel(riskTag.label);
  return label || 'Risk flag';
}

function mapTasks(tasks?: UpstreamTask[]): CardTask[] | undefined {
  if (!Array.isArray(tasks) || tasks.length === 0) return undefined;
  const seen = new Set<string>();
  const out: CardTask[] = [];
  for (const t of tasks) {
    const title = stripOrTranslateCjk(t.title || 'Task') || 'Task';
    const type = normalizeTaskType(t.type);
    const status = stripOrTranslateCjk(t.status || 'OPEN') || 'OPEN';
    const cost = safeNum(t.cost, 0);
    const timeMinutes = typeof t.time_minutes === 'number' && t.time_minutes > 0 ? t.time_minutes : null;
    const url = normalizeExternalUrl(t.external_link);
    const isExclusive = Boolean(t.is_exclusive);
    const key = `${title.toLowerCase()}\0${type.toLowerCase()}\0${status.toLowerCase()}\0${cost}\0${timeMinutes ?? ''}\0${url ?? ''}\0${isExclusive ? '1' : '0'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      title,
      type,
      status,
      cost,
      timeMinutes,
      url,
      isExclusive,
    });
  }
  return out;
}

function mapProject(p: UpstreamProject, rank: number, nowMs: number): Card {
  const ts = p.task_summary ?? {};
  const bt = p.best_task ?? {};
  const chains = extractChains(p);
  const badges: Badge[] = [];
  const seenBadges = new Set<Badge>();
  for (const t of p.tags ?? []) {
    const b = BADGE_KEYS[t.key];
    if (b && !seenBadges.has(b)) {
      seenBadges.add(b);
      badges.push(b);
    }
  }
  if (p.is_launched && !seenBadges.has('token')) badges.push('token');

  const raise = safeNum(p.total_raise, 0);
  const costNum = safeNum(bt.cost, 0);
  const updatedTs = safeNum(p.last_status_update, 0);
  const bestType = normalizeTaskType(bt.type);
  const allTypes = new Set<string>();
  if (bestType) allTypes.add(bestType);
  for (const ty of ts.types ?? []) {
    const norm = normalizeTaskType(ty);
    if (norm) allTypes.add(norm);
  }

  const fitSet = new Set<FitKey>();
  for (const rawFit of p.fit ?? []) {
    const mapped = mapFitKey(rawFit);
    if (mapped) fitSet.add(mapped);
  }
  const fitList = [...fitSet];

  const bestTitle = stripOrTranslateCjk(bt.title ?? '') || '—';
  const name = stripOrTranslateCjk(p.project_name) || 'Unknown project';
  const symbol = p.coin_symbol ? stripOrTranslateCjk(p.coin_symbol) || null : null;
  const id = typeof p.project_id === 'string' && p.project_id ? p.project_id : null;

  return {
    r: rank,
    n: name,
    id,
    chain: chains[0],
    chains: chains.length > 0 ? chains : undefined,
    t: symbol,
    g: normalizeGrade(p.tier),
    b: badges,
    x: null,
    img: sanitizeLogo(p.logo_url),
    f: fmtUsd(raise),
    raiseNum: raise,
    tk: `${ts.open ?? 0}/${ts.total ?? 0}`,
    h: safeNum(p.xscore, 0),
    u: ago(updatedTs, nowMs),
    updatedTs: updatedTs > 0 ? updatedTs : undefined,
    fit: fitList,
    best: {
      n: bestTitle,
      ty: bestType,
      c: costNum > 0 ? `$${costNum}` : 'Free',
      m: typeof bt.time_minutes === 'number' && bt.time_minutes > 0 ? `${bt.time_minutes} min` : '—',
    },
    costNum,
    taskTypes: allTypes.size > 0 ? [...allTypes] : undefined,
    tasks: mapTasks(p.tasks),
    isStockToken: Boolean(p.is_us_stock_token),
    riskLabel: extractRiskLabel(p.tags),
    sc: safeNum(p.score, 0),
    sub: [safeNum(p.token_launch_score, 0), safeNum(p.cost_perf_score, 0), null],
    url: normalizeExternalUrl(bt.external_link),
    source: 'Surf',
  };
}

function mapTge(p: UpstreamProject): Tge {
  const dateTs = safeNum(p.reward_date, 0);
  const raise = safeNum(p.total_raise, 0);
  return {
    n: stripOrTranslateCjk(p.project_name) || 'Unknown project',
    t: p.coin_symbol ? stripOrTranslateCjk(p.coin_symbol) : '',
    s: translateTgeStatus(p.status),
    d: formatIsoDate(dateTs),
    logo: sanitizeLogo(p.logo_url) || null,
    tier: normalizeGrade(p.tier),
    raise: raise > 0 ? fmtUsd(raise) : undefined,
    url: normalizeExternalUrl(p.best_task?.external_link ?? p.tasks?.find(t => t.external_link)?.external_link),
    source: 'Surf',
  };
}

export function normalizeSurf(raw: unknown, nowMs = Date.now()): AirdropFeed {
  const body = raw as UpstreamBody | null;
  if (!body || !Array.isArray(body.active) || body.active.length === 0) {
    throw new Error('Unexpected surf airdrops payload');
  }
  const cards = body.active.map((p, i) => mapProject(p, i + 1, nowMs));
  const tge = Array.isArray(body.tge) ? body.tge.map(mapTge) : [];
  const preToken = body.counts?.active_unlaunched ?? cards.filter(c => !c.b.includes('token')).length;
  return filterGamblingAirdropFeed({
    cards,
    tge,
    counts: {
      active: body.counts?.active_total ?? cards.length,
      preToken,
    },
    fetchedAt: nowMs,
  });
}

/**
 * Total time budget for one Surf refresh. Surf is an optional source that
 * hangs in production, so both attempts share a single short deadline instead
 * of the 15s default fetch timeout.
 */
export const SURF_TIMEOUT_MS = 4000;

export async function fetchSurfAirdrops(
  url = SURF_AIRDROPS_URL,
  nowMs = Date.now(),
  timeoutMs = SURF_TIMEOUT_MS,
): Promise<AirdropFeed> {
  const maxAttempts = 2;
  const deadline = AbortSignal.timeout(timeoutMs);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: deadline,
      });
    } catch (err) {
      if (attempt + 1 >= maxAttempts) throw err;
      continue;
    }

    if (!res.ok) {
      await res.body?.cancel();
      if (res.status >= 500 && attempt + 1 < maxAttempts) continue;
      throw new Error(`Surf HTTP ${res.status}`);
    }

    const raw = await res.json();
    return normalizeSurf(raw, nowMs);
  }

  throw new Error('Surf fetch exhausted retries');
}
