import type { TASK_TYPES } from './constants';

export type Grade = 'S' | 'A' | 'B' | 'C';

export type Badge = 'live' | 'token' | 'early' | 'zero' | 'rerun' | 'risk';

export type FitKey = 'zero' | 'multi' | 'small' | 'climber' | 'community' | 'technical';

export interface CardTask {
  title: string;
  type: string;
  status: string;
  cost: number;
  timeMinutes: number | null;
  url: string | null;
  isExclusive?: boolean;
  source?: string;
}

export interface Card {
  r: number;
  n: string;
  /** Stable upstream project id (surf): unique storage key for watchlist/done-tasks. */
  id?: string | null;
  chain?: string;
  chains?: string[];
  t: string | null;
  g: Grade;
  b: Badge[];
  x?: string | null;
  img?: string | null;
  f: string;
  raiseNum?: number;
  tk: string;
  h: number;
  u: string;
  /** Unix timestamp in seconds. */
  updatedTs?: number;
  fit: FitKey[];
  best: { n: string; ty: string; c: string; m: string };
  costNum?: number;
  taskTypes?: string[];
  tasks?: CardTask[];
  isStockToken?: boolean;
  riskLabel?: string;
  sc: number;
  sub: [number, number, number | null];
  url: string | null;
  source?: string;
  ogImage?: string | null;
  description?: string;
  tvlUsd?: number;
  apy?: string;
  deadline?: string;
  rewardPool?: string;
  verifiedDomain?: boolean;
}

export interface Tge {
  n: string;
  t: string;
  s: string;
  d: string;
  logo?: string | null;
  tier?: Grade;
  raise?: string;
  url?: string | null;
  source?: string;
}

export interface Tab {
  id: string;
  label: string;
}

export interface Counts {
  active: number;
  preToken: number;
}

export interface AirdropFeed {
  cards: Card[];
  tge: Tge[];
  counts: Counts;
  /** Unix timestamp in milliseconds (Date.now()). */
  fetchedAt: number;
}

export type MarketSectionId = 'crypto' | 'defi' | 'yields' | 'predictions' | 'trending' | 'github';

export interface MarketRow {
  cells: string[];
  /** Stable row identity (source-native id, e.g. coin id, pool id, repo full name). */
  id?: string;
  /**
   * Sort anchors per column, aligned with `cells` by index. Raw numeric values
   * (exact signed percentages, USD amounts, counts, Unix-ms timestamps) let the
   * frontend sort without guessing from display strings. `null` marks an
   * unsortable/absent value ("—").
   */
  sortValues?: (string | number | null)[];
  chain?: string;
  chains?: string[];
  href?: string;
  /** Authoritative HTTPS logo/avatar URL for the row's primary entity, when available. */
  icon?: string | null;
}

export interface MarketSection {
  id: MarketSectionId;
  title: string;
  blurb: string;
  cols: string[];
  rows: MarketRow[];
  source: string;
  sourceUrl: string;
  fetchedAt: number;
  stale: boolean;
}

export interface MarketSector {
  name: string;
  change24h: string;
  marketCap: string;
}

export interface MarketsResponse {
  generatedAt: number;
  sections: MarketSection[];
  sectors?: MarketSector[];
}

export interface HealthSnapshotStatus {
  fetchedAt: number;
  ok: boolean;
  error?: string | null;
}

export interface HealthResponse {
  ok: boolean;
  snapshots: Record<string, HealthSnapshotStatus>;
}

export type TaskType = (typeof TASK_TYPES)[number];

export type RiskLevel = 'ok' | 'warn' | 'risk';

export interface FeedSourceRef {
  platform: 'telegram' | 'x' | 'surf' | 'sheet' | 'feed';
  handle: string;
  postUrl: string;
  postedAt: number;
}

export interface FeedItem {
  id: string;
  project: string;
  ticker?: string;
  domain?: string;
  /** Authoritative HTTPS project logo URL enriched from trusted Surf/curated indexes. */
  logo?: string | null;
  chains: string[];
  taskTypes: TaskType[];
  summary: string;
  summarySource?: 'rule' | 'ai';
  links: { url: string; known: boolean }[];
  sources: FeedSourceRef[];
  sourceCount: number;
  score: number;
  risk: { level: RiskLevel; reasons: string[] };
  verifiedDomain?: boolean;
  rewardPool?: string;
  deadline?: string;
  cost?: string;
  steps?: string[];
  ogImage?: string | null;
  ogTitle?: string;
  ogDescription?: string;
  tvlUsd?: number;
  funding?: string;
  radarId?: string;
  surf?: { tier?: Grade; cardRank?: number };
  firstSeen: number;
  lastSeen: number;
}

export interface DomainMeta {
  domain: string;
  logoUrl?: string | null;
  ogImage?: string | null;
  ogTitle?: string | null;
  ogDescription?: string | null;
  tvlUsd?: number | null;
  category?: string | null;
  source: 'defillama' | 'coingecko' | 'html' | 'curated';
  fetchedAt: number;
  expiresAt: number;
  error?: string | null;
}

export interface SourceHealth {
  id: string;
  platform: string;
  handle: string;
  status: 'ok' | 'degraded' | 'down';
  lastOkAt: number | null;
}

export interface FeedResponse {
  generatedAt: number;
  items: FeedItem[];
  cursor?: string;
}

export interface AgentProfile {
  agent: 'hermes' | 'openclaw' | 'claude-computer-use' | 'browser-use' | 'other';
  agentNote?: string;
  host: 'local-pc' | 'vps' | 'cloud-vm';
  os: 'windows' | 'macos' | 'linux';
  specs?: string;
  browserMode: 'headless' | 'headed' | 'computer-use';
  residentialIp: boolean;
  wallet: 'browser-extension' | 'hardware' | 'burner-extension' | 'none';
  walletNote?: string;
  budgetUsd: number;
  maxMinutes: number;
  language: 'en';
}
