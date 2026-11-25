import type { MarketRow } from '../../shared/types';
import { isHttpUrl, sortVal } from './format';

const PLACEHOLDER_RE = /^(?:—|–|-|n\/a|tba)$/i;
const RANK_RE = /^#\d+(?:,\d+)*$/;
const POSITIVE_SIGN_RE = /^[+▲]\s*\$?\d/;
const NEGATIVE_SIGN_RE = /^[-▼]\s*\$?\d/;
const UNSIGNED_PCT_RE = /^\d[\d,]*(?:\.\d+)?%$/;

function isColumnNumeric(colIdx: number, rows: readonly MarketRow[]): boolean {
  if (colIdx === 0 || rows.length === 0) return false;

  let numAnchors = 0;
  let strAnchors = 0;
  for (const row of rows) {
    const sv = row.sortValues?.[colIdx];
    if (typeof sv === 'number' && Number.isFinite(sv)) {
      numAnchors++;
    } else if (typeof sv === 'string' && sv.trim().length > 0) {
      strAnchors++;
    }
  }
  if (numAnchors + strAnchors > 0) {
    return numAnchors > 0 && numAnchors >= strAnchors;
  }

  let numHits = 0;
  let textHits = 0;
  for (const row of rows) {
    const raw = row.cells[colIdx];
    if (!raw) continue;
    const trimmed = raw.trim();
    if (!trimmed || PLACEHOLDER_RE.test(trimmed)) continue;
    if (isHttpUrl(trimmed)) {
      textHits++;
    } else if (sortVal(trimmed) !== null || RANK_RE.test(trimmed)) {
      numHits++;
    } else {
      textHits++;
    }
  }
  return numHits > 0 && numHits >= textHits;
}

/**
 * Determines per column whether it holds numeric/financial values for
 * right-aligned tabular rendering. Column 0 (primary label/entity) is always false.
 */
export function detectNumericColumns(cols: readonly string[], rows: readonly MarketRow[]): boolean[] {
  if (cols.length === 0) return [];
  if (rows.length === 0) return cols.map(() => false);
  return cols.map((_, idx) => isColumnNumeric(idx, rows));
}

/**
 * Classifies a market table cell for signed delta pill styling while leaving
 * plain currency values, counts, and labels as neutral tabular text.
 */
export function classifyDeltaCell(rawCell: string): {
  tone: 'up' | 'down' | 'neutral';
  isPercentOrSigned: boolean;
} {
  const trimmed = rawCell.trim();
  if (!trimmed) return { tone: 'neutral', isPercentOrSigned: false };

  const normalized = trimmed.replace(/\u2212/g, '-');
  const isPositiveSign = POSITIVE_SIGN_RE.test(normalized);
  const isNegativeSign = NEGATIVE_SIGN_RE.test(normalized);

  if (isPositiveSign || isNegativeSign) {
    const val = sortVal(normalized);
    if (val === null || !Number.isFinite(val)) {
      return { tone: 'neutral', isPercentOrSigned: false };
    }
    if (val === 0) {
      return { tone: 'neutral', isPercentOrSigned: true };
    }
    return {
      tone: isPositiveSign && val > 0 ? 'up' : 'down',
      isPercentOrSigned: true,
    };
  }

  if (UNSIGNED_PCT_RE.test(normalized)) {
    return { tone: 'neutral', isPercentOrSigned: true };
  }

  return { tone: 'neutral', isPercentOrSigned: false };
}
