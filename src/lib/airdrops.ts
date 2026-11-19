import type { Badge, Card, FitKey, Grade } from '../../shared/types';

export const AIRDROPS_URL = 'https://import-command-query-8ca052.surf.computer/api/airdrops';
export const POLL_MS = 60_000;

interface UpstreamProject {
  project_name: string;
  chains?: { name: string }[];
  coin_symbol?: string | null;
  tier: Grade;
  tags?: { key: string }[];
  is_launched?: boolean;
  logo_url?: string | null;
  total_raise?: number | string | null;
  task_summary?: { open?: number; total?: number };
  best_task?: {
    title?: string;
    type?: string;
    cost?: number;
    time_minutes?: number;
    external_link?: string | null;
  };
  xscore?: number | string;
  last_status_update?: number | string;
  fit?: string[];
  score?: number | string;
  token_launch_score?: number | string;
  cost_perf_score?: number | string;
}

interface UpstreamBody {
  active: UpstreamProject[];
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
  'bounty-platforms': 'bounty',
  node: 'depin',
};

function ago(ts: number): string {
  if (!ts) return '—';
  const days = Math.max(0, (Date.now() / 1000 - ts) / 86400);
  if (days < 1) return 'today';
  return days < 30 ? `${Math.floor(days)}d` : `${Math.floor(days / 30)}mo`;
}

function mapProject(p: UpstreamProject, rank: number): Card {
  const ts = p.task_summary ?? {};
  const bt = p.best_task ?? {};
  const chains = p.chains ?? [];
  const badges = (p.tags ?? []).flatMap(t => {
    const b = BADGE_KEYS[t.key];
    return b ? [b] : [];
  });
  if (p.is_launched) badges.push('token');
  const raise = Number(p.total_raise);
  return {
    r: rank,
    n: p.project_name,
    chain: chains.length ? chains[0].name : undefined,
    t: p.coin_symbol ?? null,
    g: p.tier,
    b: badges,
    x: null,
    img: p.logo_url ?? '',
    f: raise ? `$${(raise / 1e6).toFixed(2)}M` : '—',
    tk: `${ts.open ?? 0}/${ts.total ?? 0}`,
    h: Number(p.xscore),
    u: ago(Number(p.last_status_update)),
    fit: (p.fit ?? []).flatMap(f => {
      const k = FIT_KEYS[f];
      return k ? [k] : [];
    }),
    best: {
      n: bt.title ?? '—',
      ty: (bt.type && TASK_TYPE[bt.type]) ?? bt.type ?? '',
      c: bt.cost && bt.cost > 0 ? `$${bt.cost}` : 'Free',
      m: `${bt.time_minutes} min`,
    },
    sc: Number(p.score),
    sub: [Number(p.token_launch_score), Number(p.cost_perf_score), null],
    url: bt.external_link || null,
  };
}

export async function fetchAirdrops(signal?: AbortSignal): Promise<Card[]> {
  const res = await fetch(AIRDROPS_URL, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as UpstreamBody | null;
  if (!body || !Array.isArray(body.active) || !body.active.length) {
    throw new Error('unexpected airdrops payload');
  }
  return body.active.map((p, i) => mapProject(p, i + 1));
}
