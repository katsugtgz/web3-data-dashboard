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
}

export interface Card {
  r: number;
  n: string;
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
  chain?: string;
  href?: string;
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

export type TaskType =
  | 'testnet'
  | 'faucet'
  | 'quest'
  | 'waitlist'
  | 'bridge'
  | 'stake'
  | 'mint'
  | 'points'
  | 'trade'
  | 'social'
  | 'node'
  | 'other';

export type RiskLevel = 'ok' | 'warn' | 'risk';

export interface FeedSourceRef {
  platform: 'telegram' | 'x' | 'surf';
  handle: string;
  postUrl: string;
  postedAt: number;
}

export interface FeedItem {
  id: string;
  project: string;
  ticker?: string;
  domain?: string;
  chains: string[];
  taskTypes: TaskType[];
  summary: string;
  summarySource?: 'rule' | 'ai';
  links: { url: string; known: boolean }[];
  sources: FeedSourceRef[];
  sourceCount: number;
  score: number;
  risk: { level: RiskLevel; reasons: string[] };
  surf?: { tier?: Grade; cardRank?: number };
  firstSeen: number;
  lastSeen: number;
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
