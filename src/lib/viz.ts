import type { Card, Grade, MarketSection } from '../../shared/types';
import { sortVal } from './format';
import { GRADE_ORDER } from './labels';
import { classifyDeltaCell, formatDeltaCell } from './marketTable';

/* ---- Micro-chart math: KPI sparklines, distribution bars, market momentum bars. No chart library. ---- */

export const SPARK_WIDTH = 96;
export const SPARK_HEIGHT = 22;
export const ACTIVITY_DAYS = 7;
const DAY_MS = 86_400_000;

/** Counts timestamps (ms) per UTC day, oldest first, over the `days` days that end today. */
export function bucketDaily(timestamps: readonly number[], now: number, days = ACTIVITY_DAYS): number[] {
  const buckets = new Array<number>(days).fill(0);
  const today = Math.floor(now / DAY_MS);
  for (const ts of timestamps) {
    if (!Number.isFinite(ts) || ts <= 0) continue;
    const age = today - Math.floor(ts / DAY_MS);
    if (age < 0 || age >= days) continue;
    buckets[days - 1 - age] += 1;
  }
  return buckets;
}

/** Short caption such as "12 today · peak 30" for a daily series (newest bucket last). */
export function describeBuckets(buckets: readonly number[]): string {
  const latest = buckets[buckets.length - 1] ?? 0;
  const peak = buckets.length > 0 ? Math.max(...buckets) : 0;
  return `${latest} today · peak ${peak}/${ACTIVITY_DAYS}d`;
}

/** Polyline points for a sparkline. An all-zero series flattens to the middle. */
export function sparklinePoints(values: readonly number[], width = SPARK_WIDTH, height = SPARK_HEIGHT): string {
  if (values.length === 0) return '';
  const max = Math.max(...values);
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  return values
    .map((value, index) => {
      const y = max > 0 ? height - 1 - (value / max) * (height - 2) : height / 2;
      return `${(index * step).toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
}

/** Closed area path under a sparkline polyline. */
export function sparklineArea(points: string, width = SPARK_WIDTH, height = SPARK_HEIGHT): string {
  if (!points) return '';
  return `M0,${height} L${points.replace(/ /g, ' L')} L${width},${height} Z`;
}

/** One slice of a stacked distribution bar. `tone` names a color: s, a, b, c, accent, info, success, warning, neutral. */
export interface BarSegment {
  id: string;
  label: string;
  value: number;
  tone: string;
}

const SOURCE_TONES = ['accent', 'info', 'success', 'warning'] as const;
const MAX_NAMED_SOURCES = SOURCE_TONES.length;

/** Ranks counts into bar segments: the top entries keep their own tone, the tail folds into "Other". */
function rankedSegments(counts: ReadonlyMap<string, number>, labelOf: (id: string) => string = id => id): BarSegment[] {
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const named = ranked.slice(0, MAX_NAMED_SOURCES).map(([id, value], index) => ({
    id,
    label: labelOf(id),
    value,
    tone: SOURCE_TONES[index],
  }));
  const otherCount = ranked.slice(MAX_NAMED_SOURCES).reduce((sum, [, value]) => sum + value, 0);
  return otherCount > 0 ? [...named, { id: '__other', label: 'Other', value: otherCount, tone: 'neutral' }] : named;
}

/** Distribution data behind the Airdrops KPI micro-charts. */
export interface CardMix {
  /** `updatedTs` (ms) of every card that carries one. */
  updated: number[];
  tiers: BarSegment[];
  /** Cards per upstream source, most frequent first; the tail folds into "Other". */
  sources: BarSegment[];
}

export function summarizeCardMix(cards: readonly Pick<Card, 'g' | 'source' | 'updatedTs'>[]): CardMix {
  const tierCounts: Record<Grade, number> = { S: 0, A: 0, B: 0, C: 0 };
  const sourceCounts = new Map<string, number>();
  const updated: number[] = [];

  for (const card of cards) {
    if (card.g in tierCounts) tierCounts[card.g] += 1;
    if (typeof card.updatedTs === 'number' && card.updatedTs > 0) updated.push(card.updatedTs * 1000);
    const source = card.source?.trim();
    if (source) sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + 1);
  }

  return {
    updated,
    tiers: GRADE_ORDER.map(grade => ({
      id: grade,
      label: `Tier ${grade}`,
      value: tierCounts[grade],
      tone: grade.toLowerCase(),
    })),
    sources: rankedSegments(sourceCounts),
  };
}

const DROP_PLATFORM_LABEL: Record<string, string> = {
  telegram: 'Telegram',
  x: 'X',
  feed: 'Feeds',
  sheet: 'Sheets',
  surf: 'Surf',
};

const DROP_PLATFORM_TONE: Record<string, string> = {
  telegram: 'info',
  x: 'neutral',
  feed: 'success',
  sheet: 'warning',
  surf: 'accent',
};

/** Distribution data behind the Drops KPI micro-charts. */
export interface DropMix {
  /** `lastSeen` (ms) of every drop, one entry per drop. */
  lastSeen: number[];
  /** Source posts per platform, most frequent first. */
  platforms: BarSegment[];
  corroboration: BarSegment[];
  verification: BarSegment[];
}

interface DropMixInput {
  sources: ReadonlyArray<{ platform: string }>;
  sourceCount: number;
  links: ReadonlyArray<{ known: boolean }>;
  lastSeen: number;
}

export function summarizeDropMix(items: readonly DropMixInput[]): DropMix {
  const platformCounts = new Map<string, number>();
  let multiSource = 0;
  let verified = 0;
  const lastSeen: number[] = [];

  for (const item of items) {
    lastSeen.push(item.lastSeen);
    if (item.sourceCount >= 2) multiSource += 1;
    if (item.links.some(link => link.known)) verified += 1;
    for (const source of item.sources) {
      const platform = source.platform.trim().toLowerCase();
      if (platform) platformCounts.set(platform, (platformCounts.get(platform) ?? 0) + 1);
    }
  }

  return {
    lastSeen,
    platforms: rankedSegments(platformCounts, id => DROP_PLATFORM_LABEL[id] ?? id).map(segment => ({
      ...segment,
      tone: DROP_PLATFORM_TONE[segment.id] ?? 'neutral',
    })),
    corroboration: [
      { id: 'multi', label: '2+ sources', value: multiSource, tone: 'accent' },
      { id: 'single', label: '1 source', value: items.length - multiSource, tone: 'neutral' },
    ],
    verification: [
      { id: 'verified', label: 'Known link', value: verified, tone: 'success' },
      { id: 'unknown', label: 'No known link', value: items.length - verified, tone: 'neutral' },
    ],
  };
}

/* ---- Market momentum ---- */

/** Absolute size of a signed change such as "+4.61%" or "-0.61%"; 0 for anything else (plain values, an em dash). */
export function changeMagnitude(raw: string): number {
  const normalized = raw.trim().replace(/\u2212/g, '-');
  if (!classifyDeltaCell(normalized).isPercentOrSigned) return 0;
  const value = sortVal(normalized);
  return value !== null && Number.isFinite(value) ? Math.abs(value) : 0;
}

/** Bar width as a percent of the widest bar. Tiny moves keep a visible stub; a missing scale fills the bar. */
export function momentumPercent(magnitude: number, scale: number): number {
  if (!(magnitude > 0)) return 0;
  if (!(scale > 0)) return 100;
  return Math.min(100, Math.max(6, (magnitude / scale) * 100));
}

export type MoveIntensity = 'strong' | 'mid' | 'soft' | 'flat';

/** Grades a 24h move so sector chips can carry three steps of color plus a flat state. */
export function sectorIntensity(magnitude: number): MoveIntensity {
  if (!(magnitude > 0)) return 'flat';
  if (magnitude >= 10) return 'strong';
  if (magnitude >= 3) return 'mid';
  return 'soft';
}

/** Per column: the largest absolute signed change among the rows. Columns without signed changes scale to 0. */
export function scaleDeltaColumns(section: MarketSection): number[] {
  return section.cols.map((_, columnIndex) => {
    let max = 0;
    for (const row of section.rows) {
      const cell = row.cells[columnIndex];
      if (!cell || classifyDeltaCell(formatDeltaCell(cell)).tone === 'neutral') continue;
      max = Math.max(max, changeMagnitude(cell));
    }
    return max;
  });
}
