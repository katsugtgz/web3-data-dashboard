import type { MarketRow } from '../../shared/types';

const textCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * Compares two market rows by raw sort anchor for `col`, applying `dir`
 * internally so invariants hold in BOTH directions:
 * - missing anchors (absent array, `null`, or short array) always sort AFTER
 *   anchored rows, ascending or descending;
 * - rows with no `sortValues` at all are legacy payloads: they keep their
 *   original relative order (0) — we never guess numbers from display strings.
 */
export function cmpRows(a: MarketRow, b: MarketRow, col: number, dir: 1 | -1): number {
  const aAnchored = a.sortValues !== undefined;
  const bAnchored = b.sortValues !== undefined;
  if (!aAnchored && !bAnchored) return 0;

  const av = a.sortValues?.[col];
  const bv = b.sortValues?.[col];
  const aMissing = !aAnchored || av === undefined || av === null;
  const bMissing = !bAnchored || bv === undefined || bv === null;
  if (aMissing || bMissing) {
    if (aMissing && bMissing) return 0;
    return aMissing ? 1 : -1; // missing anchors sink regardless of direction
  }

  const base =
    typeof av === 'number' && typeof bv === 'number'
      ? av - bv
      : typeof av === 'number'
        ? -1 // numeric anchor vs text anchor: numbers first
        : typeof bv === 'number'
          ? 1
          : textCollator.compare(av, bv);
  return dir * base;
}

/** Stable row identity: source id when present, else a composite from content. Never positional. */
export function rowKey(row: MarketRow, sectionId: string): string {
  if (row.id) return `${sectionId}:${row.id}`;
  return `${sectionId}:${row.cells.join('¦')}${row.chain ? `¦${row.chain}` : ''}`;
}
