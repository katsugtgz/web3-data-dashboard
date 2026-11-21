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

export interface DemoRow {
  cells: string[];
  chain: string;
}

export interface DemoSection {
  id: string;
  blurb: string;
  cols: string[];
  rows: DemoRow[];
}

export interface Counts {
  active: number;
  preToken: number;
}

export interface AirdropFeed {
  cards: Card[];
  tge: Tge[];
  counts: Counts;
  fetchedAt: number;
}

export interface Dashboard {
  FIT: Record<FitKey, string>;
  CARDS: Card[];
  BADGES: Record<Badge, string>;
  TGE: Tge[];
  TABS: Tab[];
  TYPES: string[];
  COUNTS: Counts;
  CATEGORIES: string[];
  TYPE_MAP: Record<string, string[]>;
  DEMO: DemoSection[];
  IMGS: Record<string, string>;
}

export interface SectionSummary {
  source: 'harvest' | 'harvest-net';
  name: string;
}
