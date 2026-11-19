export type Grade = 'S' | 'A' | 'B';

export type Badge = 'live' | 'token' | 'early' | 'zero' | 'rerun' | 'risk';

export type FitKey = 'zero' | 'multi' | 'small' | 'climber' | 'community' | 'technical';

export interface Card {
  r: number;
  n: string;
  chain?: string;
  t: string | null;
  g: Grade;
  b: Badge[];
  x?: string | null;
  img?: string | null;
  f: string;
  tk: string;
  h: number;
  u: string;
  fit: FitKey[];
  best: { n: string; ty: string; c: string; m: string };
  sc: number;
  sub: [number, number, number | null];
  url: string | null;
}

export interface Tge {
  n: string;
  t: string;
  s: string;
  d: string;
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
