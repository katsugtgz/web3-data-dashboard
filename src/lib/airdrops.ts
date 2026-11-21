import type { AirdropFeed, Badge, Card, CardTask, FitKey, Grade, Tge } from '../../shared/types';
import { formatRaiseShort } from './format';

export const AIRDROPS_URL = 'https://import-command-query-8ca052.surf.computer/api/airdrops';
export const POLL_MS = 60_000;

interface UpstreamTask {
  title?: string;
  type?: string;
  status?: string;
  is_exclusive?: boolean;
  cost?: number;
  time_minutes?: number | null;
  external_link?: string | null;
  blockchains?: ({ name?: string } | string)[];
}

interface UpstreamProject {
  project_name: string;
  chains?: { name: string }[];
  coin_symbol?: string | null;
  status?: string;
  tier?: string;
  tags?: { key: string; label?: string }[];
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

interface UpstreamBody {
  active: UpstreamProject[];
  tge?: UpstreamProject[];
  counts?: { active_total?: number; active_unlaunched?: number };
}

const FIT_KEYS: Record<string, FitKey> = {
  冲榜党: 'climber',
  多号党: 'multi',
  小资金党: 'small',
  技术党: 'technical',
  社区贡献党: 'community',
  零成本党: 'zero',
};

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

function normalizeGrade(tier?: string): Grade {
  if (tier === 'S' || tier === 'A' || tier === 'B' || tier === 'C') return tier;
  return 'B';
}

function normalizeTaskType(raw?: string): string {
  if (!raw) return '';
  return TASK_TYPE[raw] ?? raw;
}

function safeNum(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function ago(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '—';
  const days = Math.max(0, (Date.now() / 1000 - ts) / 86400);
  if (days < 1) return 'today';
  return days < 30 ? `${Math.floor(days)}d` : `${Math.floor(days / 30)}mo`;
}

function formatIsoDate(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return 'TBA';
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

function extractChains(p: UpstreamProject): string[] {
  const set = new Set<string>();
  for (const c of p.chains ?? []) {
    if (c?.name) set.add(c.name);
  }
  for (const bc of p.best_task?.blockchains ?? []) {
    const name = typeof bc === 'string' ? bc : bc?.name;
    if (name) set.add(name);
  }
  return [...set];
}

function extractRiskLabel(tags?: { key: string; label?: string }[]): string | undefined {
  const riskTag = tags?.find(t => t.key === 'risk');
  if (!riskTag) return undefined;
  const m = riskTag.label?.match(/(\d+)/);
  if (m) {
    const n = Number(m[1]);
    return n === 1 ? '1 risk flag' : `${n} risk flags`;
  }
  return 'Risk flag';
}

function mapTasks(tasks?: UpstreamTask[]): CardTask[] | undefined {
  if (!Array.isArray(tasks) || tasks.length === 0) return undefined;
  return tasks.map(t => ({
    title: t.title || 'Task',
    type: normalizeTaskType(t.type),
    status: t.status || 'OPEN',
    cost: safeNum(t.cost, 0),
    timeMinutes: typeof t.time_minutes === 'number' && t.time_minutes > 0 ? t.time_minutes : null,
    url: t.external_link || null,
    isExclusive: Boolean(t.is_exclusive),
  }));
}

function mapProject(p: UpstreamProject, rank: number): Card {
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

  return {
    r: rank,
    n: p.project_name,
    chain: chains[0],
    chains: chains.length > 0 ? chains : undefined,
    t: p.coin_symbol || null,
    g: normalizeGrade(p.tier),
    b: badges,
    x: null,
    img: p.logo_url ?? '',
    f: formatRaiseShort(raise),
    raiseNum: raise,
    tk: `${ts.open ?? 0}/${ts.total ?? 0}`,
    h: safeNum(p.xscore, 0),
    u: ago(updatedTs),
    updatedTs: updatedTs > 0 ? updatedTs : undefined,
    fit: (p.fit ?? []).flatMap(f => {
      const k = FIT_KEYS[f];
      return k ? [k] : [];
    }),
    best: {
      n: bt.title ?? '—',
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
    url: bt.external_link || null,
  };
}

function mapTge(p: UpstreamProject): Tge {
  const dateTs = safeNum(p.reward_date, 0) || safeNum(p.last_status_update, 0);
  const raise = safeNum(p.total_raise, 0);
  return {
    n: p.project_name,
    t: p.coin_symbol ?? '',
    s: p.status ?? 'Upcoming',
    d: formatIsoDate(dateTs),
    logo: p.logo_url ?? null,
    tier: normalizeGrade(p.tier),
    raise: raise > 0 ? formatRaiseShort(raise) : undefined,
    url: p.best_task?.external_link ?? p.tasks?.find(t => t.external_link)?.external_link ?? null,
  };
}

export async function fetchAirdrops(signal?: AbortSignal): Promise<AirdropFeed> {
  const res = await fetch(AIRDROPS_URL, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as UpstreamBody | null;
  if (!body || !Array.isArray(body.active) || !body.active.length) {
    throw new Error('unexpected airdrops payload');
  }
  const cards = body.active.map((p, i) => mapProject(p, i + 1));
  const tge = Array.isArray(body.tge) ? body.tge.map(mapTge) : [];
  const preToken = body.counts?.active_unlaunched ?? cards.filter(c => !c.b.includes('token')).length;
  return {
    cards,
    tge,
    counts: {
      active: body.counts?.active_total ?? cards.length,
      preToken,
    },
    fetchedAt: Date.now(),
  };
}
