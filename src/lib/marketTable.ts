import type { MarketRow, MarketSectionId } from '../../shared/types';
import { isHttpUrl, sortVal } from './format';
import { extractTickerFallback, getCryptoVisual } from './visualAssets';

const PLACEHOLDER_RE = /^(?:—|–|-|n\/a|tba)$/i;
const RANK_RE = /^#\d+(?:,\d+)*$/;
const POSITIVE_SIGN_RE = /^[+▲]\s*\$?\d/;
const NEGATIVE_SIGN_RE = /^[-▼]\s*\$?\d/;
const UNSIGNED_PCT_RE = /^\d[\d,]*(?:\.\d+)?%$/;
const SIGNED_ZERO_PCT_RE = /^[-+\u2212](0+(?:\.0+)?%)$/;

const ENTITY_TICKER_RE = /^(.+?)\s+\(([A-Z0-9][A-Z0-9.$_-]{0,11})\)$/;
const BARE_TICKER_RE = /^[A-Z0-9][A-Z0-9._-]{0,11}$/;
const POOL_TOKEN_RE = /^[A-Z][A-Z0-9.]{0,11}$/;
const SHORT_ADDR_RE = /^(?:0x)?[A-Za-z0-9]{3,10}(?:\u2026|\.\.\.)[A-Za-z0-9]{2,8}$/;
const OVERFLOW_SUFFIX_RE = /\s+(\+\d+)$/;
const VERSION_SLUG_RE = /^v(\d+)$/i;

const NON_TICKER_PARENS = new Set([
  'V1',
  'V2',
  'V3',
  'V4',
  'EUR',
  'USD',
  'GBP',
  'JPY',
  'BETA',
  'ALPHA',
  'TESTNET',
  'MAINNET',
  'LIVE',
  'NEW',
  'OLD',
  'LEGACY',
  'TBA',
  'TBD',
]);

const PROTOCOL_TOKEN_LABELS: Record<string, string> = {
  eth: 'ETH',
  sol: 'SOL',
  btc: 'BTC',
  bnb: 'BNB',
  usd: 'USD',
  usdc: 'USDC',
  usdt: 'USDT',
  usde: 'USDe',
  usd0: 'USD0',
  usds: 'USDS',
  usdy: 'USDY',
  usyc: 'USYC',
  ustb: 'USTB',
  buidl: 'BUIDL',
  ai: 'AI',
  meth: 'mETH',
  khype: 'kHYPE',
  steth: 'stETH',
  wsteth: 'wstETH',
  weeth: 'weETH',
  wbeth: 'wBETH',
  reth: 'rETH',
  rseth: 'rsETH',
  cbbtc: 'cbBTC',
  wbtc: 'WBTC',
  dao: 'DAO',
  dex: 'DEX',
  defi: 'DeFi',
  rwa: 'RWA',
  amm: 'AMM',
  lst: 'LST',
  lrt: 'LRT',
  'ether.fi': 'Ether.fi',
  sparklend: 'SparkLend',
  justlend: 'JustLend',
  blackrock: 'BlackRock',
  defillama: 'DefiLlama',
  hyperliquid: 'Hyperliquid',
  pancakeswap: 'PancakeSwap',
  sushiswap: 'SushiSwap',
  eigenlayer: 'EigenLayer',
  eigencloud: 'EigenCloud',
  layerzero: 'LayerZero',
  openocean: 'OpenOcean',
};

const TRAILING_DANGLING_WORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'for',
  'nor',
  'of',
  'to',
  'in',
  'on',
  'at',
  'by',
  'with',
  'from',
  'into',
  'onto',
  'over',
  'under',
  'about',
  'as',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'this',
  'that',
  'these',
  'those',
  'no',
  'not',
  'so',
  'up',
  'out',
  'off',
  'your',
  'our',
  'my',
  'its',
  'their',
  'his',
  'her',
  'who',
  'which',
  'where',
  'when',
  'while',
  'than',
  'then',
  'because',
]);

const GITHUB_LANGUAGE_COLORS: Record<string, string> = {
  typescript: '#3178C6',
  javascript: '#D4B830',
  python: '#3572A5',
  solidity: '#AA6746',
  rust: '#DEA584',
  go: '#00ADD8',
  html: '#E34C26',
  css: '#563D7C',
  shell: '#89E051',
  bash: '#89E051',
  'c++': '#F34B7D',
  c: '#555555',
  'c#': '#178600',
  java: '#B07219',
  move: '#4A90E2',
  cairo: '#FF4A00',
  vyper: '#2B2B68',
  'jupyter notebook': '#DA5B0B',
  vue: '#41B883',
  svelte: '#FF3E00',
  dart: '#00B4AB',
  kotlin: '#A97BFF',
  swift: '#F05138',
  ruby: '#701516',
  php: '#4F5D95',
  dockerfile: '#384D54',
  nix: '#7E7EFF',
  zig: '#EC915C',
};

export type MarketColumnKind = 'entity' | 'chain' | 'project' | 'language' | 'ilRisk' | 'data';

export interface ParsedEntityLabel {
  name: string;
  ticker: string | null;
}

export interface ParsedTrendingEntity {
  shortAddr: string | null;
  description: string | null;
  ticker: string | null;
}

export interface ParsedChainCell {
  chains: string[];
  overflow: string | null;
}

export interface LanguageVisual {
  label: string;
  color: string;
  isUnknown: boolean;
}

export interface EntityCellMeta {
  rawCell: string;
  displayName: string;
  displayTicker: string | null;
  avatarTicker: string | null;
  protocolSlug: string | null;
  repoParts: { owner: string; repo: string } | null;
  avatarShape: 'circle' | 'rounded';
}

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
 * Normalizes signed zero percentage strings (e.g. "-0.00%", "+0.00%") into
 * unsigned zero ("0.00%") while leaving non-zero deltas and other cells intact.
 */
export function formatDeltaCell(rawCell: string): string {
  const trimmed = rawCell.trim();
  const match = trimmed.match(SIGNED_ZERO_PCT_RE);
  return match ? match[1] : rawCell;
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

/**
 * Splits primary market entity labels like "Bitcoin (BTC)", "MemeCore (M)",
 * or bare Binance Vision tickers ("BTC") into display name + ticker symbol.
 */
export function splitEntityLabel(raw: string, sectionId?: MarketSectionId): ParsedEntityLabel {
  const trimmed = raw.trim();
  if (!trimmed) return { name: '', ticker: null };

  const match = trimmed.match(ENTITY_TICKER_RE);
  if (match && !NON_TICKER_PARENS.has(match[2])) {
    return { name: match[1].trim(), ticker: match[2] };
  }

  if (sectionId === 'crypto' && BARE_TICKER_RE.test(trimmed)) {
    const visual = getCryptoVisual(trimmed);
    return { name: visual?.name ?? trimmed, ticker: trimmed };
  }

  return { name: trimmed, ticker: null };
}

/**
 * Extracts a primary token ticker from a DeFi yield pool symbol (e.g. "STETH",
 * "USDC-ETH", "WETH/USDT") for coin SVG matching when protocol icons are absent.
 */
export function extractYieldPoolTicker(poolSymbol: string): string | null {
  const trimmed = poolSymbol.trim().toUpperCase();
  if (!trimmed) return null;

  const parts = trimmed.split(/[-/\s+]+/).filter(Boolean);
  for (const part of parts) {
    if (getCryptoVisual(part)) return part;
  }
  for (const part of parts) {
    if (POOL_TOKEN_RE.test(part) && !NON_TICKER_PARENS.has(part)) {
      return part;
    }
  }
  return null;
}

function titleCaseSlugToken(token: string): string {
  const lower = token.toLowerCase();
  const known = PROTOCOL_TOKEN_LABELS[lower];
  if (known) return known;

  const versionMatch = lower.match(VERSION_SLUG_RE);
  if (versionMatch) return `V${versionMatch[1]}`;

  if (lower.includes('.')) {
    const [head, ...rest] = lower.split('.');
    const headLabel = head ? head[0].toUpperCase() + head.slice(1) : '';
    return [headLabel, ...rest].join('.');
  }

  return lower ? lower[0].toUpperCase() + lower.slice(1) : '';
}

/**
 * Formats raw lowercase DefiLlama protocol slugs (e.g. "binance-staked-eth",
 * "ether.fi-stake", "aave-v3") into readable labels while preserving already
 * formatted protocol names.
 */
export function formatProtocolSlugLabel(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || PLACEHOLDER_RE.test(trimmed)) return trimmed || '—';

  if (/\s/.test(trimmed) || /[A-Z]/.test(trimmed)) {
    return trimmed;
  }

  const wholeKnown = PROTOCOL_TOKEN_LABELS[trimmed];
  if (wholeKnown) return wholeKnown;

  const formatted = trimmed
    .split(/[-_]+/)
    .filter(Boolean)
    .map(titleCaseSlugToken)
    .join(' ');
  return formatted || trimmed;
}

const TRAILING_SEP_RE = /[,;:\-\u2013\u2014\u00b7\u2022|*+/([{\s]+$/u;
const SENTENCE_ORPHAN_TAIL_RE = /^(.{16,}[.!?])\s+([^.!?]{1,14})$/;

function stripTrailingDanglingTail(text: string): string {
  let out = text.trim();

  // Drop unclosed trailing parenthetical stubs like "(TikTok, Instagram"
  const lastOpen = out.lastIndexOf('(');
  const lastClose = out.lastIndexOf(')');
  if (lastOpen > lastClose && lastOpen >= 8) {
    out = out.slice(0, lastOpen).trim();
  }

  out = out.replace(TRAILING_SEP_RE, '').trim();

  let changed = true;
  while (changed) {
    changed = false;
    const words = out.split(/\s+/);
    if (words.length <= 2) break;
    const lastWord = words[words.length - 1]
      .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
      .toLowerCase();
    if (lastWord && TRAILING_DANGLING_WORDS.has(lastWord)) {
      words.pop();
      out = words.join(' ').replace(TRAILING_SEP_RE, '').trim();
      changed = true;
    }
  }

  const orphanMatch = out.match(SENTENCE_ORPHAN_TAIL_RE);
  if (orphanMatch) {
    out = orphanMatch[1].trim();
  }

  return out;
}

function cleanTrendingDescription(rawDesc: string): string | null {
  const collapsed = rawDesc.replace(/\s+/g, ' ').trim();
  if (!collapsed) return null;

  // Legacy live Worker sliced DexScreener descriptions at 42 chars without word boundary.
  const endsWithSentencePunct = /[.!?\u2026]$/.test(collapsed);
  if (rawDesc.length === 42 && !endsWithSentencePunct) {
    const endedOnSpace = /\s$/.test(rawDesc);
    let candidate = collapsed;
    if (!endedOnSpace) {
      const lastSpace = candidate.lastIndexOf(' ');
      if (lastSpace > 8) {
        candidate = candidate.slice(0, lastSpace);
      }
    }
    const cleaned = stripTrailingDanglingTail(candidate) || collapsed;
    return /[.!?\u2026]$/.test(cleaned) ? cleaned : `${cleaned}\u2026`;
  }

  if (collapsed.endsWith('\u2026')) {
    const stem = collapsed.slice(0, -1).trim();
    const cleaned = stripTrailingDanglingTail(stem) || stem;
    return /[.!?\u2026]$/.test(cleaned) ? cleaned : `${cleaned}\u2026`;
  }

  return collapsed;
}

/**
 * Splits a DexScreener Trending token cell ("shortAddr · description") into
 * a mono address pill, optional extracted $TICKER, and clean wrapped description
 * with legacy 42-char mid-word stubs trimmed cleanly.
 */
export function parseTrendingEntityCell(raw: string): ParsedTrendingEntity {
  const trimmed = raw.trim();
  if (!trimmed) return { shortAddr: null, description: null, ticker: null };

  const sepIdx = raw.indexOf(' · ');
  if (sepIdx > 0) {
    const left = raw.slice(0, sepIdx).trim();
    const right = raw.slice(sepIdx + 3);
    if (SHORT_ADDR_RE.test(left)) {
      return {
        shortAddr: left,
        description: cleanTrendingDescription(right),
        ticker: extractTickerFallback(right),
      };
    }
  }

  if (SHORT_ADDR_RE.test(trimmed)) {
    return { shortAddr: trimmed, description: null, ticker: null };
  }

  return {
    shortAddr: null,
    description: cleanTrendingDescription(raw),
    ticker: extractTickerFallback(raw),
  };
}

/**
 * Parses a Chain or Chains table cell ("Ethereum", "Polygon, Ethereum +89",
 * "Ethereum, Robinhood Chain +21") into discrete chain labels + optional overflow.
 */
export function parseChainCell(rawCell: string): ParsedChainCell {
  const trimmed = rawCell.trim();
  if (!trimmed || PLACEHOLDER_RE.test(trimmed)) {
    return { chains: [], overflow: null };
  }

  const parts = trimmed
    .split(/,\s*/)
    .map(p => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return { chains: [], overflow: null };

  let overflow: string | null = null;
  const last = parts[parts.length - 1];
  const overflowMatch = last.match(OVERFLOW_SUFFIX_RE);
  if (overflowMatch) {
    overflow = overflowMatch[1];
    parts[parts.length - 1] = last.slice(0, overflowMatch.index).trim();
  }

  return {
    chains: parts.filter(Boolean),
    overflow,
  };
}

/**
 * Splits a GitHub "owner/repo" cell into owner and repository segments for
 * slash-boundary wrapping without clipping.
 */
export function splitGithubRepo(raw: string): { owner: string; repo: string } | null {
  const parts = raw.trim().split('/');
  if (parts.length !== 2) return null;
  const owner = parts[0].trim();
  const repo = parts[1].trim();
  if (!owner || !repo) return null;
  return { owner, repo };
}

/**
 * Maps a GitHub repository language label to its canonical Linguist dot color.
 */
export function getLanguageVisual(language: string): LanguageVisual {
  const trimmed = language.trim();
  if (!trimmed || trimmed.toLowerCase() === 'unknown' || PLACEHOLDER_RE.test(trimmed)) {
    return {
      label: trimmed || 'Unknown',
      color: 'var(--color-text-supporting)',
      isUnknown: true,
    };
  }

  const color = GITHUB_LANGUAGE_COLORS[trimmed.toLowerCase()];
  return {
    label: trimmed,
    color: color ?? 'var(--color-accent)',
    isUnknown: false,
  };
}

/**
 * Identifies the semantic rendering role of a market table column.
 */
export function resolveColumnKind(
  sectionId: MarketSectionId,
  colHeader: string,
  colIdx: number,
): MarketColumnKind {
  if (colIdx === 0) return 'entity';
  const lower = colHeader.trim().toLowerCase();
  if (lower === 'chain' || lower === 'chains') return 'chain';
  if (sectionId === 'yields' && lower === 'project') return 'project';
  if (sectionId === 'yields' && lower === 'il risk') return 'ilRisk';
  if (sectionId === 'github' && lower === 'language') return 'language';
  return 'data';
}

/**
 * Resolves display name, ticker, protocol slug, GitHub owner/repo split, and
 * avatar shape for non-trending market entity cells.
 */
export function resolveEntityCellMeta(row: MarketRow, sectionId: MarketSectionId): EntityCellMeta {
  const rawCell = row.cells[0] ?? '';
  const entity = sectionId === 'crypto' ? splitEntityLabel(rawCell, 'crypto') : { name: rawCell.trim(), ticker: null };
  const poolTicker = sectionId === 'yields' ? extractYieldPoolTicker(rawCell) : null;
  const protocolSlug =
    sectionId === 'yields'
      ? (row.cells[1] ?? '').trim() || null
      : sectionId === 'defi'
        ? (row.id ?? null)
        : null;

  return {
    rawCell,
    displayName: entity.name || '—',
    displayTicker: entity.ticker,
    avatarTicker: entity.ticker ?? poolTicker,
    protocolSlug,
    repoParts: sectionId === 'github' ? splitGithubRepo(rawCell) : null,
    avatarShape: sectionId === 'crypto' || sectionId === 'github' ? 'circle' : 'rounded',
  };
}
