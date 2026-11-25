import type { AirdropFeed, Badge, Card, CardTask, FitKey, Grade, Tge } from '../../../shared/types';
import { FETCH_TIMEOUT_MS, USER_AGENT, fmtUsd } from '../lib/format';
import { cleanUrl, isPlatformDomain } from '../normalize/domains';
import {
  type AssoBannerKind,
  type AssoCategoryInfo,
  classifyAssoBanner,
  classifyAssoCategory,
  isAssoDroppedOrRug,
  isAssoEcosystemStatusCell,
  isAssoHeaderRow,
  isAssoMetaBannerRow,
  parseAssoAttention,
  parseAssoBookmarkDate,
  parseAssoUpdatedTimestamp,
  parseCjkRaiseUsd,
  stripOrTranslateCjk,
  translateAssoCost,
  translateAssoEcosystem,
  translateAssoInteraction,
  translateAssoInvestor,
  translateAssoMultiAccount,
  translateAssoParticipation,
  translateAssoPotential,
  translateAssoProjectName,
  translateAssoReward,
  translateAssoStatus,
  translateAssoStep,
  translateAssoTge,
} from '../normalize/i18n';
import { normalizeExternalUrl } from './surf';
import { isStopName, MAJOR_TICKERS } from '../normalize/text';

export const ASSO7878_SHEET_URL =
  'https://docs.google.com/spreadsheets/d/1q0_lHlDxgYASN_lcB8TFlIOKealVPPCQY5_aA7R3h60/gviz/tq?tqx=out:csv';

export const ARNDXT_SHEET_URL =
  'https://docs.google.com/spreadsheets/d/148Hzh_qNz6pfj623Z3dmQE4SN4gjTtrDfkIIFmpBaQo/gviz/tq?tqx=out:csv&gid=0';

/**
 * Fast slice-based RFC 4180 CSV parser supporting UTF-8 BOM, CRLF/LF newlines,
 * quoted fields with embedded commas/newlines, and escaped double quotes.
 */
export function parseCsv(input: string): string[][] {
  const len = input.length;
  let i = len > 0 && input.charCodeAt(0) === 0xfeff ? 1 : 0;
  const rows: string[][] = [];
  let row: string[] = [];

  while (i < len) {
    const ch = input.charCodeAt(i);
    if (ch === 34 /* " */) {
      i++;
      let field = '';
      let segStart = i;
      let closed = false;
      while (i < len) {
        const c = input.charCodeAt(i);
        if (c === 34 /* " */) {
          if (i + 1 < len && input.charCodeAt(i + 1) === 34) {
            field += input.slice(segStart, i) + '"';
            i += 2;
            segStart = i;
            continue;
          }
          field += input.slice(segStart, i);
          i++;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) {
        field += input.slice(segStart, i);
      }
      row.push(field);
      // Ignore horizontal whitespace between closing quote and delimiter/newline
      while (i < len) {
        const ws = input.charCodeAt(i);
        if (ws === 32 || ws === 9) i++;
        else break;
      }
      // Skip optional delimiter or newline after closing quote
      if (i < len) {
        const next = input.charCodeAt(i);
        if (next === 44 /* , */) {
          i++;
          if (i === len) row.push('');
        } else if (next === 13 /* \r */) {
          i += i + 1 < len && input.charCodeAt(i + 1) === 10 ? 2 : 1;
          rows.push(row);
          row = [];
        } else if (next === 10 /* \n */) {
          i++;
          rows.push(row);
          row = [];
        }
      }
    } else {
      const start = i;
      while (i < len) {
        const c = input.charCodeAt(i);
        if (c === 44 || c === 13 || c === 10) break;
        i++;
      }
      row.push(input.slice(start, i));
      if (i < len) {
        const next = input.charCodeAt(i);
        if (next === 44 /* , */) {
          i++;
          if (i === len) row.push('');
        } else if (next === 13 /* \r */) {
          i += i + 1 < len && input.charCodeAt(i + 1) === 10 ? 2 : 1;
          rows.push(row);
          row = [];
        } else if (next === 10 /* \n */) {
          i++;
          rows.push(row);
          row = [];
        }
      }
    }
  }

  if (row.length > 0) {
    rows.push(row);
  }

  return rows;
}

function slugify(name: string): string {
  let out = '';
  let prevDash = true;
  for (let i = 0; i < name.length; i++) {
    let c = name.charCodeAt(i);
    if (c >= 65 && c <= 90) c += 32; // A-Z -> a-z
    if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) {
      out += String.fromCharCode(c);
      prevDash = false;
    } else if (!prevDash) {
      out += '-';
      prevDash = true;
    }
  }
  if (out.endsWith('-')) out = out.slice(0, -1);
  return out || 'project';
}

function fnv1a32Hex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function computeSheetBaseId(prefix: 'asso7878' | 'arndxt', name: string): string {
  const nameKey = name.trim().toLowerCase();
  const slug = slugify(name);
  return nameKey === slug ? `${prefix}:${slug}` : `${prefix}:${slug}-${fnv1a32Hex(nameKey)}`;
}

function sheetCardUrlIdentity(card: Card): string {
  return `${card.n.trim().toLowerCase()}\u001e${(card.url ?? '').trim()}`;
}

function sheetCardDisambiguator(card: Card): string {
  const taskSig = (card.tasks ?? [])
    .map(t => `${t.title.trim().toLowerCase()}\u0000${t.type.trim().toLowerCase()}\u0000${(t.url ?? '').trim()}`)
    .join('\u001f');
  return [
    card.n.trim().toLowerCase(),
    (card.url ?? '').trim(),
    taskSig,
    card.best.n.trim().toLowerCase(),
    (card.chain ?? '').trim().toLowerCase(),
    String(card.raiseNum ?? 0),
  ].join('\u001e');
}

/**
 * Assigns deterministic, CSV row-order-independent IDs to sheet cards.
 * Canonical lowercase-slug names keep `<prefix>:<slug>`; non-canonical names get
 * `<prefix>:<slug>-<hash(nameKey)>`; duplicate-baseId rows within the same sheet
 * are disambiguated with `~<hash>` (preferring stable name+URL identity so task
 * and fundraising edits do not churn IDs, falling back to full row fields only
 * when duplicate rows share the same URL).
 */
function assignDeterministicSheetCardIds(prefix: 'asso7878' | 'arndxt', cards: Card[]): void {
  const baseIds = cards.map(card => computeSheetBaseId(prefix, card.n));
  const baseCounts = new Map<string, number>();
  for (const baseId of baseIds) {
    baseCounts.set(baseId, (baseCounts.get(baseId) ?? 0) + 1);
  }

  const urlIdentityCounts = new Map<string, number>();
  const urlIdentities: (string | null)[] = cards.map((card, i) => {
    if ((baseCounts.get(baseIds[i]) ?? 0) <= 1) return null;
    const key = `${baseIds[i]}\u001d${sheetCardUrlIdentity(card)}`;
    urlIdentityCounts.set(key, (urlIdentityCounts.get(key) ?? 0) + 1);
    return key;
  });

  const seenIds = new Set<string>();
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    const baseId = baseIds[i];
    const urlIdentity = urlIdentities[i];
    const candidate =
      urlIdentity !== null
        ? (urlIdentityCounts.get(urlIdentity) ?? 0) === 1
          ? `${baseId}~${fnv1a32Hex(sheetCardUrlIdentity(card))}`
          : `${baseId}~${fnv1a32Hex(sheetCardDisambiguator(card))}`
        : baseId;
    let cardId = candidate;
    let suffix = 2;
    while (seenIds.has(cardId)) {
      cardId = `${candidate}-${suffix++}`;
    }
    seenIds.add(cardId);
    card.id = cardId;
  }
}

function gradeFromScore(sc: number): Grade {
  if (sc >= 80) return 'S';
  if (sc >= 62) return 'A';
  if (sc >= 42) return 'B';
  return 'C';
}

function agoLabel(updatedTsSec: number | undefined, nowMs: number): string {
  if (!updatedTsSec || !Number.isFinite(updatedTsSec) || updatedTsSec <= 0) return '—';
  const days = Math.max(0, (nowMs / 1000 - updatedTsSec) / 86_400);
  if (days < 1) return 'today';
  return days < 30 ? `${Math.floor(days)}d` : `${Math.floor(days / 30)}mo`;
}

function countStars(raw?: string): number {
  if (!raw) return 0;
  let count = 0;
  let idx = raw.indexOf('\u2B50');
  while (idx !== -1) {
    count++;
    idx = raw.indexOf('\u2B50', idx + 1);
  }
  return count;
}

const SHEET_STRIP_QUERY_PARAMS = new Set([
  'icode',
  'accesscode',
  'access_code',
  'refid',
  'ref_id',
  'referral',
  'referralcode',
  'referral_code',
  'refcode',
  'ref_code',
  'referrer',
  'ref',
  'inviter',
  'invite',
  'invitecode',
  'invite_code',
  'code',
  'r',
]);
const SHEET_REF_START_TOKEN_RE = /^(?:ref|inv(?:ite)?|aff|r)[_-]/i;
const SHEET_REF_START_WORD_RE = /(?:^|[_-])(?:ref|invite)(?:[_-]|$)/i;
const SHEET_REF_PATH_SEGMENT_RE = /\/(r|ref|referral|invite|join|share)\/([A-Za-z0-9._-]{2,48})\/?$/i;
const SHEET_CLEAN_JOIN_SUBPATHS = new Set([
  'waitlist',
  'whitelist',
  'beta',
  'early-access',
  'quest',
  'airdrop',
  'rewards',
  'creator',
  'creators',
]);
const SHEET_AT_HANDLE_PATH_RE = /\/@[A-Za-z0-9._-]{2,48}\/?$/;
const SHEET_MAY_HAVE_REF_RE = /[?#]|\/(?:r|ref|referral|invite|join|share)\/|\/@/i;
const SHEET_HTTP_URL_RE = /https?:\/\/[^\s<>"'`]+/i;

function stripSearchParamsInPlace(params: URLSearchParams, isRoot: boolean, isTelegram: boolean): boolean {
  let changed = false;
  for (const key of new Set(params.keys())) {
    const lowerKey = key.toLowerCase();
    if (SHEET_STRIP_QUERY_PARAMS.has(lowerKey)) {
      params.delete(key);
      changed = true;
    } else if (lowerKey === 'join' && isRoot) {
      params.delete(key);
      changed = true;
    } else if (lowerKey === 'start' || lowerKey === 'startapp') {
      const vals = params.getAll(key).map(v => v.trim());
      if (isTelegram || vals.some(val => SHEET_REF_START_TOKEN_RE.test(val) || SHEET_REF_START_WORD_RE.test(val))) {
        params.delete(key);
        changed = true;
      }
    }
  }
  return changed;
}

function stripSheetReferralParams(cleanedUrl: string): string {
  // Fast path: skip URL parsing entirely when no query, hash, referral path, or /@ handle is present.
  if (!SHEET_MAY_HAVE_REF_RE.test(cleanedUrl)) return cleanedUrl;

  // Fast path for path-only referral links (/r/<code>, /ref/<code>, /@handle) with no query/hash.
  if (!cleanedUrl.includes('?') && !cleanedUrl.includes('#')) {
    const schemeEnd = cleanedUrl.indexOf('://');
    if (schemeEnd > 0) {
      const pathStart = cleanedUrl.indexOf('/', schemeEnd + 3);
      if (pathStart > 0) {
        const pathname = cleanedUrl.slice(pathStart);
        const pathRefMatch = pathname.match(SHEET_REF_PATH_SEGMENT_RE);
        if (pathRefMatch) {
          const kind = pathRefMatch[1].toLowerCase();
          const seg = pathRefMatch[2].toLowerCase();
          if (!(kind === 'join' && SHEET_CLEAN_JOIN_SUBPATHS.has(seg))) {
            const nextPath = pathname.slice(0, pathname.length - pathRefMatch[0].length);
            return `${cleanedUrl.slice(0, pathStart)}${nextPath || '/'}`;
          }
          return cleanedUrl;
        }
        if (pathname.includes('/@')) {
          const hostPort = cleanedUrl.slice(schemeEnd + 3, pathStart).toLowerCase();
          const colonIdx = hostPort.indexOf(':');
          const hostLower = colonIdx >= 0 ? hostPort.slice(0, colonIdx) : hostPort;
          if (!isPlatformDomain(hostLower) && SHEET_AT_HANDLE_PATH_RE.test(pathname)) {
            const nextPath = pathname.replace(SHEET_AT_HANDLE_PATH_RE, '');
            return `${cleanedUrl.slice(0, pathStart)}${nextPath || '/'}`;
          }
        }
        return cleanedUrl;
      }
    }
  }

  try {
    const u = new URL(cleanedUrl);
    const hostLower = u.hostname.toLowerCase();
    const isTelegram =
      hostLower === 't.me' ||
      hostLower.endsWith('.t.me') ||
      hostLower === 'telegram.me' ||
      hostLower.endsWith('.telegram.me');
    let changed = false;

    const pathRefMatch = u.pathname.match(SHEET_REF_PATH_SEGMENT_RE);
    if (pathRefMatch) {
      const kind = pathRefMatch[1].toLowerCase();
      const seg = pathRefMatch[2].toLowerCase();
      if (!(kind === 'join' && SHEET_CLEAN_JOIN_SUBPATHS.has(seg))) {
        const nextPath = u.pathname.slice(0, u.pathname.length - pathRefMatch[0].length);
        u.pathname = nextPath || '/';
        changed = true;
      }
    } else if (u.pathname.includes('/@') && !isPlatformDomain(hostLower) && SHEET_AT_HANDLE_PATH_RE.test(u.pathname)) {
      const nextPath = u.pathname.replace(SHEET_AT_HANDLE_PATH_RE, '');
      u.pathname = nextPath || '/';
      changed = true;
    }

    const isRoot = u.pathname === '/' || u.pathname === '';
    if (u.search.length > 1 && stripSearchParamsInPlace(u.searchParams, isRoot, isTelegram)) {
      changed = true;
    }

    if (u.hash.includes('?')) {
      const qIdx = u.hash.indexOf('?');
      const hashBase = u.hash.slice(0, qIdx);
      const hashQuery = u.hash.slice(qIdx + 1);
      const hp = new URLSearchParams(hashQuery);
      const isHashRoot = hashBase === '#' || hashBase === '#/';
      if (stripSearchParamsInPlace(hp, isHashRoot, isTelegram)) {
        const nextHashQuery = hp.toString();
        u.hash = nextHashQuery ? `${hashBase}?${nextHashQuery}` : isHashRoot ? '' : hashBase;
        changed = true;
      }
    }

    return changed ? u.toString() : cleanedUrl;
  } catch {
    return cleanedUrl;
  }
}

function tryCleanSheetUrlCandidate(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || !trimmed.includes('.')) return null;
  if (isAssoEcosystemStatusCell(trimmed)) return null;
  let candidate: string;
  if (/\s/.test(trimmed)) {
    if (!trimmed.includes('://')) return null;
    candidate = trimmed.match(SHEET_HTTP_URL_RE)?.[0] ?? '';
    if (!candidate) return null;
  } else {
    candidate = trimmed;
  }
  const normalized = normalizeExternalUrl(candidate);
  if (!normalized) return null;
  const cleaned = cleanUrl(normalized);
  return cleaned ? stripSheetReferralParams(cleaned) : null;
}

function extractCleanSheetUrl(c0?: string, c1?: string, c2?: string): string | null {
  return tryCleanSheetUrlCandidate(c0) ?? tryCleanSheetUrlCandidate(c1) ?? tryCleanSheetUrlCandidate(c2);
}

const KNOWN_CHAINS = [
  'Ethereum',
  'Base',
  'Arbitrum',
  'Optimism',
  'Solana',
  'BNB',
  'Sui',
  'Aptos',
  'Monad',
  'Berachain',
  'HyperEVM',
  'Starknet',
  'zkSync',
  'Linea',
  'Scroll',
  'Polygon',
  'TON',
  'Sei',
  'Injective',
  'Avalanche',
  'Mantle',
  'Blast',
  'Abstract',
  'Sonic',
  'MegaETH',
] as const;

// Pre-compiled single regex + canonical map avoids per-row RegExp compilation inside Workers' 10ms CPU budget.
const CHAIN_LABEL_RE = new RegExp(`\\b(${KNOWN_CHAINS.join('|')})\\b`, 'i');
const CHAIN_CANONICAL = new Map<string, string>(KNOWN_CHAINS.map(c => [c.toLowerCase(), c]));

const SHEET_NON_TICKER_LABELS = new Set([
  'L1', 'L2', 'L3', 'V1', 'V2', 'V3', 'V4',
  'DEFI', 'GAMEFI', 'SOCIALFI', 'INFOFI', 'DEPIN', 'RWA', 'PERP', 'PERPS',
  'TGE', 'IDO', 'IEO', 'ICO', 'TVL', 'APR', 'APY',
  'EVM', 'SVM', 'TVM', 'ZKP', 'ZK', 'HOT', 'TOP', 'VIP',
  'BETA', 'ALPHA', 'MAINNET', 'TESTNET', 'SEED', 'TOTAL', 'REPORTED', 'EST',
  'OLD', 'PRO', 'APP', 'BOT', 'SDK', 'API', 'RPC', 'MEV', 'AMM', 'CLOB',
  'LST', 'LRT', 'CDP', 'LP', 'YT', 'PT', 'S1', 'S2', 'S3', 'Q1', 'Q2', 'Q3', 'Q4',
]);

const SHEET_TICKER_TOKEN_RE = /^[A-Z][A-Z0-9]{1,9}$/;
const SHEET_TRAILING_PAREN_TICKER_RE = /\s*(?:\(|\uFF08)\s*\$?([A-Z][A-Z0-9]{1,9})\s*(?:\)|\uFF09)\s*$/;
const SHEET_TRAILING_DOLLAR_TICKER_RE = /\s+\$([A-Z][A-Z0-9]{1,9})\s*$/;
const SHEET_INLINE_DOLLAR_TICKER_RE = /(?:^|[\s([\-/])\$([A-Z][A-Z0-9]{1,9})\b/;
const SHEET_INLINE_PAREN_TICKER_RE = /(?:\(|\uFF08)\s*\$?([A-Z][A-Z0-9]{1,9})\s*(?:\)|\uFF09)/;
const ARNDXT_TGE_TOKEN_LAUNCH_RE = /\(\s*\$?([A-Z][A-Z0-9]{1,9})\s+token\s+launch(?:ed)?\s*\)/;

function isValidSheetTicker(sym: string): boolean {
  return (
    SHEET_TICKER_TOKEN_RE.test(sym) &&
    !MAJOR_TICKERS.has(sym) &&
    !isStopName(sym) &&
    !SHEET_NON_TICKER_LABELS.has(sym)
  );
}

/**
 * Extracts an inline `$TICKER` or `(TICKER)` from a sheet project cell without
 * false-positiving on generic version/category labels like `(V2)` or `(DEX)`.
 * Strips a trailing ticker suffix from the display name only when a valid
 * project prefix remains.
 */
function extractSheetProjectAndTicker(
  rawCell: string,
  translatedName: string,
): { name: string; ticker: string | null } {
  const trailingParen = translatedName.match(SHEET_TRAILING_PAREN_TICKER_RE);
  if (trailingParen && isValidSheetTicker(trailingParen[1])) {
    const stripped = translatedName.slice(0, trailingParen.index).trim();
    if (stripped.length >= 2 && !isStopName(stripped)) {
      return { name: stripped, ticker: trailingParen[1] };
    }
    return { name: translatedName, ticker: trailingParen[1] };
  }

  const trailingDollar = translatedName.match(SHEET_TRAILING_DOLLAR_TICKER_RE);
  if (trailingDollar && isValidSheetTicker(trailingDollar[1])) {
    const stripped = translatedName.slice(0, trailingDollar.index).trim();
    if (stripped.length >= 2 && !isStopName(stripped)) {
      return { name: stripped, ticker: trailingDollar[1] };
    }
    return { name: translatedName, ticker: trailingDollar[1] };
  }

  for (const sourceText of [translatedName, rawCell]) {
    const dollarMatch = sourceText.match(SHEET_INLINE_DOLLAR_TICKER_RE);
    if (dollarMatch && isValidSheetTicker(dollarMatch[1])) {
      return { name: translatedName, ticker: dollarMatch[1] };
    }
    const parenMatch = sourceText.match(SHEET_INLINE_PAREN_TICKER_RE);
    if (parenMatch && isValidSheetTicker(parenMatch[1])) {
      return { name: translatedName, ticker: parenMatch[1] };
    }
  }

  return { name: translatedName, ticker: null };
}

function extractArndxtTgeTicker(tgeRaw: string): string | null {
  const m = tgeRaw.match(ARNDXT_TGE_TOKEN_LAUNCH_RE);
  if (m && isValidSheetTicker(m[1])) return m[1];
  const dollarMatch = tgeRaw.match(SHEET_INLINE_DOLLAR_TICKER_RE);
  if (dollarMatch && isValidSheetTicker(dollarMatch[1])) return dollarMatch[1];
  return null;
}

function inferChainFromLabel(label: string): string | undefined {
  const m = CHAIN_LABEL_RE.exec(label);
  return m ? CHAIN_CANONICAL.get(m[1].toLowerCase()) : undefined;
}

function isAssoBannerRow(row: readonly string[]): boolean {
  for (let i = 4; i < row.length; i++) {
    if (row[i]?.trim()) return false;
  }
  let nonEmptyLead = 0;
  const leadLimit = Math.min(4, row.length);
  for (let i = 0; i < leadLimit; i++) {
    if (row[i]?.trim()) {
      nonEmptyLead++;
      if (nonEmptyLead > 1) return false;
    }
  }
  return nonEmptyLead === 1;
}

function detectAssoBanner(row: readonly string[]): AssoBannerKind | null {
  if (!isAssoBannerRow(row)) return null;
  const leadLimit = Math.min(4, row.length);
  for (let i = 0; i < leadLimit; i++) {
    const cell = row[i];
    if (cell && cell.length >= 3) {
      const kind = classifyAssoBanner(cell);
      if (kind) return kind;
    }
  }
  return null;
}

/**
 * Parses ASSO7878's multi-layout Google Sheet CSV into 100% English curated
 * cards and post-TGE entries (skipping CEX promos, bankrupt, and abandoned rows).
 */
export function parseAsso7878Sheet(csv: string, nowMs = Date.now()): AirdropFeed {
  const rows = parseCsv(csv);
  const cards: Card[] = [];
  const tge: Tge[] = [];
  const seenTgeKeys = new Set<string>();

  type Section = 'pre_header' | 'active' | 'tge' | 'skip_bankrupt' | 'skip_abandoned';
  let section: Section = 'pre_header';
  let currentCatInfo: AssoCategoryInfo | null = null;
  let sheetUpdatedSec: number | undefined;
  const sheetYear = new Date(nowMs).getUTCFullYear();

  for (const row of rows) {
    if (row.length === 0) continue;

    if (section === 'pre_header') {
      if (isAssoMetaBannerRow(row)) {
        const parsedMs = parseAssoUpdatedTimestamp(row);
        if (parsedMs) sheetUpdatedSec = Math.floor(parsedMs / 1000);
        continue;
      }
      if (isAssoHeaderRow(row)) {
        section = 'active';
        currentCatInfo = null;
      }
      continue;
    }

    const banner = detectAssoBanner(row);
    if (banner) {
      section = banner;
      currentCatInfo = null;
      continue;
    }

    if (section === 'skip_bankrupt' || section === 'skip_abandoned') continue;
    const col0 = row[0] ? row[0].trim() : '';
    const col2 = row[2] ? row[2].trim() : '';
    if (!col0 && !col2) continue;
    if (isAssoHeaderRow(row)) continue;

    if (col0) currentCatInfo = classifyAssoCategory(col0);
    const catInfo = currentCatInfo;
    if (catInfo?.skip === 'cex' || catInfo?.skip === 'abandoned') continue;

    if (!col2) continue;
    const translatedName = translateAssoProjectName(col2);
    if (!translatedName) continue;
    const { name, ticker: sheetTicker } = extractSheetProjectAndTicker(col2, translatedName);

    const participation = translateAssoParticipation(row[13]);
    if (participation.isBankrupt) continue;

    const isEcosystemLayout = catInfo?.layout === 'ecosystem' || isAssoEcosystemStatusCell(row[21]);
    const isPostTge = section === 'tge';
    const potential = translateAssoPotential(row[8]);
    const isTgeRow = isPostTge || potential.isTokenLive || participation.isTge;

    const status = isEcosystemLayout ? translateAssoStatus(row[21]) : translateAssoStatus(row[18]);
    // Fast-skip dropped/rug/withdrawal-blocked rows (including Post-TGE) and ended active rows before URL parsing.
    if (isAssoDroppedOrRug(row[13], row[23])) continue;
    if (!isTgeRow && status.isEnded) continue;

    // Route Post-TGE section and explicitly launched rows into tge[], skipping active-only translators.
    if (isTgeRow) {
      const tgeKey = name.toLowerCase();
      if (seenTgeKeys.has(tgeKey)) continue;
      seenTgeKeys.add(tgeKey);

      const raiseNum = parseCjkRaiseUsd(row[3]);
      const bookmark = parseAssoBookmarkDate(row[9], sheetYear);
      const stars = countStars(row[10]);
      const attention = parseAssoAttention(row[11]);
      const cost = isEcosystemLayout ? translateAssoCost(row[23]) : translateAssoCost(row[20]);
      const tgeTimeline = isEcosystemLayout ? 'TBA' : translateAssoTge(row[23]);
      const raiseBonus = raiseNum >= 50_000_000 ? 12 : raiseNum >= 10_000_000 ? 8 : raiseNum >= 1_000_000 ? 4 : 0;
      const rawScore = stars * 12 + potential.scoreBonus + attention * 2 + raiseBonus + (cost.isZero ? 4 : 0);
      const sc = Math.max(15, Math.min(95, rawScore || 45));
      const url = extractCleanSheetUrl(row[21], row[16], row[17]);

      tge.push({
        n: name,
        t: sheetTicker ?? '',
        s: status.isEnded ? 'Ended' : 'Token live',
        d: bookmark.label || (tgeTimeline !== 'TBA' ? tgeTimeline : 'Launched'),
        tier: gradeFromScore(sc),
        raise: raiseNum > 0 ? fmtUsd(raiseNum) : undefined,
        url,
        source: 'ASSO7878',
      });
      continue;
    }

    const raiseNum = parseCjkRaiseUsd(row[3]);
    const investors = translateAssoInvestor(row[5] || row[4] || row[6]);
    const ecosystem = translateAssoEcosystem(row[7]);
    const bookmark = parseAssoBookmarkDate(row[9], sheetYear);
    const stars = countStars(row[10]);
    const attention = parseAssoAttention(row[11]);

    // Extract URL strictly in Col 21 -> Col 16 -> Col 17 order; reject CJK status cells and strip refs.
    const url = extractCleanSheetUrl(row[21], row[16], row[17]);

    // Layout B (Ecosystem Multi-Step) shifts Reward/Status/Multi/Cost to Cols 20-23.
    const interaction = translateAssoInteraction(row[14]);
    const reward = isEcosystemLayout ? translateAssoReward(row[20]) : translateAssoReward(row[17]);
    const multi = isEcosystemLayout ? translateAssoMultiAccount(row[22]) : translateAssoMultiAccount(row[19]);
    const cost = isEcosystemLayout ? translateAssoCost(row[23]) : translateAssoCost(row[20]);

    const raiseBonus = raiseNum >= 50_000_000 ? 12 : raiseNum >= 10_000_000 ? 8 : raiseNum >= 1_000_000 ? 4 : 0;
    const rawScore =
      stars * 12 + potential.scoreBonus + attention * 2 + raiseBonus + (cost.isZero ? 4 : 0);
    const sc = Math.max(15, Math.min(95, rawScore || 45));
    const grade = gradeFromScore(sc);

    const badges: Badge[] = [];
    if (potential.badge) badges.push(potential.badge);
    if (status.badge && !badges.includes(status.badge)) badges.push(status.badge);
    if (cost.isZero && !badges.includes('zero')) badges.push('zero');
    if (interaction.isRisk && !badges.includes('risk')) badges.push('risk');
    const hasRiskBadge = interaction.isRisk || status.badge === 'risk' || potential.badge === 'risk';

    const fit: FitKey[] = [];
    if (cost.fit) fit.push(cost.fit);
    if (multi.fit && !fit.includes(multi.fit)) fit.push(multi.fit);
    if ((interaction.cardType === 'social' || interaction.cardType === 'bounty') && !fit.includes('community')) {
      fit.push('community');
    }
    if ((interaction.cardType === 'depin' || interaction.cardType === 'testnet') && !fit.includes('technical')) {
      fit.push('technical');
    }

    const tasks: CardTask[] = [];
    if (isEcosystemLayout) {
      for (let col = 14; col <= 19; col++) {
        const stepTitle = translateAssoStep(row[col]);
        if (!stepTitle) continue;
        tasks.push({
          title: stepTitle,
          type: inferArndxtTaskType(stepTitle),
          status: status.label || 'Ongoing',
          cost: cost.costNum,
          timeMinutes: null,
          url,
        });
      }
    }

    if (tasks.length === 0) {
      let summaryTitle = interaction.label;
      const mid = reward || catInfo?.label;
      if (mid) summaryTitle += ` · ${mid}`;
      if (ecosystem) summaryTitle += ` · ${ecosystem}`;
      tasks.push({
        title: investors ? `${summaryTitle} (${investors})` : summaryTitle,
        type: catInfo?.layout === 'waitlist' ? 'form' : interaction.cardType,
        status: status.label || 'Ongoing',
        cost: cost.costNum,
        timeMinutes: null,
        url,
      });
    }

    const bestTask = tasks[0];
    let taskTypes: string[];
    if (tasks.length === 1) {
      taskTypes = [bestTask.type || 'other'];
    } else {
      const seenTypes = new Set<string>();
      for (const t of tasks) {
        if (t.type) seenTypes.add(t.type);
      }
      taskTypes = seenTypes.size > 0 ? [...seenTypes] : ['other'];
    }
    const inferredChain =
      inferChainFromLabel(name) ??
      (ecosystem ? inferChainFromLabel(ecosystem) : undefined) ??
      (catInfo?.label ? inferChainFromLabel(catInfo.label) : undefined);
    const updatedTs = bookmark.updatedTs ?? sheetUpdatedSec;
    const launchSub = Math.max(1, Math.min(10, Math.round(potential.scoreBonus / 2) + (stars >= 4 ? 1 : 0)));
    const valueSub = Math.max(1, Math.min(10, Math.round((cost.isZero ? 8 : 5) + (raiseBonus >= 8 ? 2 : 0))));

    cards.push({
      r: cards.length + 1,
      n: name,
      id: '',
      chain: inferredChain,
      chains: inferredChain ? [inferredChain] : undefined,
      t: sheetTicker,
      g: grade,
      b: badges,
      x: null,
      img: '',
      f: fmtUsd(raiseNum),
      raiseNum,
      tk: `${tasks.length}/${tasks.length}`,
      h: stars * 100 + attention * 20,
      u: agoLabel(updatedTs, nowMs),
      updatedTs,
      fit,
      best: {
        n: bestTask.title,
        ty: bestTask.type,
        c: cost.isZero ? 'Free' : cost.label,
        m: '—',
      },
      costNum: cost.costNum,
      taskTypes,
      tasks,
      riskLabel: hasRiskBadge ? (interaction.isRisk ? 'Sybil / negative EV' : 'Status risk') : undefined,
      sc,
      sub: [launchSub, valueSub, stars > 0 ? stars * 2 : null],
      url,
      source: 'ASSO7878',
    });
  }

  assignDeterministicSheetCardIds('asso7878', cards);

  return {
    cards,
    tge,
    counts: {
      active: cards.length,
      preToken: cards.filter(c => !c.b.includes('token')).length,
    },
    fetchedAt: nowMs,
  };
}

const ARNDXT_TESTNET_RE = /\b(?:testnet|faucet|sepolia|devnet)\b/i;
const ARNDXT_TRADING_RE = /\b(?:perp|perps|trade|trading|swap|volume|dex)\b/i;
const ARNDXT_STAKING_RE = /\b(?:stake|staking|restake|lend|borrow|deposit|lp|liquidity|vault|yield)\b/i;
const ARNDXT_FORM_RE = /\b(?:waitlist|whitelist|form|early access)\b/i;
const ARNDXT_DEPIN_RE = /\b(?:depin|node|validator|extension|idle)\b/i;
const ARNDXT_MINT_RE = /\b(?:mint|nft|badge|sbt)\b/i;
const ARNDXT_SOCIAL_RE = /\b(?:social|discord|twitter|follow|yap|post)\b/i;
const ARNDXT_BOUNTY_RE = /\b(?:quest|galxe|zealy|layer3|campaign)\b/i;
const ARNDXT_ZERO_RE = /\b(?:free|testnet|faucet|waitlist|zero[\s-]?cost|no[\s-]?cost)\b/i;
const ARNDXT_ZERO_NEGATED_RE =
  /\b(?:not|no|isn['\u2019]?t|aren['\u2019]?t|non|never)(?:[\s-]+(?:a|really|truly|actually|completely|entirely))?[\s-]+(?:free|zero[\s-]?cost|no[\s-]?cost)\b/i;
const ARNDXT_PAID_ACTION_RE =
  /\b(?:stake|staking|restake|restaking|deposit|deposits|lp|liquidity|vault|vaults|borrow|borrowing|lend|lending|perp|perps|trade|trading|volume|swap|swaps|buy|buying|pay|paid|capital|collateral|fees?)\b/i;

export function inferArndxtZeroCost(tasksRaw: string, reasoningRaw: string): boolean {
  if (ARNDXT_ZERO_NEGATED_RE.test(tasksRaw) || ARNDXT_ZERO_NEGATED_RE.test(reasoningRaw)) {
    return false;
  }
  if (ARNDXT_ZERO_RE.test(tasksRaw)) {
    return true;
  }
  if (ARNDXT_PAID_ACTION_RE.test(tasksRaw)) {
    return false;
  }
  return ARNDXT_ZERO_RE.test(reasoningRaw);
}

const ARNDXT_PAST_TGE_EXACT_RE = /^(?:launched|live|tge\s*live|done|completed)$/i;
const ARNDXT_PAST_TGE_PHRASE_RE =
  /\b(?:token\s+launched|tge\s*(?:reported\s*)?(?:concluded|completed|done|live)|already\s+launched)\b/i;
const ARNDXT_TOKEN_LAUNCH_RE = /\btoken\s+launch\b/i;
const ARNDXT_FUTURE_QUALIFIER_RE = /\b(?:expected|estimated|est\.?|target|planned|rumored|upcoming|tba)\b/i;
const ARNDXT_MONTH_YEAR_RE =
  /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(?:\d{1,2},?\s+)?(20\d{2})\b/i;
const ARNDXT_QUARTER_RE = /\bQ[1-4](?:\s+20\d{2})?\b/i;
const ARNDXT_YEAR_RE = /\b(20\d{2})\b/g;
const MONTH_NAME_INDEX: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

function hasArndxtFutureQualifier(tgeRaw: string, nowMs: number): boolean {
  if (ARNDXT_FUTURE_QUALIFIER_RE.test(tgeRaw)) return true;
  const currentYear = new Date(nowMs).getUTCFullYear();
  const monthMatch = tgeRaw.match(ARNDXT_MONTH_YEAR_RE);
  if (monthMatch) {
    const monthIdx = MONTH_NAME_INDEX[monthMatch[1].slice(0, 3).toLowerCase()];
    const year = Number(monthMatch[2]);
    if (monthIdx !== undefined && Number.isFinite(year)) {
      const monthEndMs = Date.UTC(year, monthIdx + 1, 0, 23, 59, 59, 999);
      if (monthEndMs > nowMs) return true;
    }
  }
  // Quarter windows (e.g. "Token launch Q4 2026") are projected schedules,
  // never launch confirmation merely because the quarter ended.
  if (ARNDXT_QUARTER_RE.test(tgeRaw)) return true;
  for (const m of tgeRaw.matchAll(ARNDXT_YEAR_RE)) {
    const year = Number(m[1]);
    if (Number.isFinite(year) && year > currentYear) return true;
  }
  return false;
}

function isArndxtPastTge(tgeRaw: string, nowMs: number): boolean {
  if (!tgeRaw) return false;
  if (ARNDXT_PAST_TGE_EXACT_RE.test(tgeRaw)) return true;
  if (ARNDXT_PAST_TGE_PHRASE_RE.test(tgeRaw)) return true;
  if (ARNDXT_TOKEN_LAUNCH_RE.test(tgeRaw) && !hasArndxtFutureQualifier(tgeRaw, nowMs)) return true;
  return false;
}

function inferArndxtTaskType(text: string): string {
  if (ARNDXT_TESTNET_RE.test(text)) return 'testnet';
  if (ARNDXT_TRADING_RE.test(text)) return 'trading';
  if (ARNDXT_STAKING_RE.test(text)) return 'staking';
  if (ARNDXT_FORM_RE.test(text)) return 'form';
  if (ARNDXT_DEPIN_RE.test(text)) return 'depin';
  if (ARNDXT_MINT_RE.test(text)) return 'mint';
  if (ARNDXT_SOCIAL_RE.test(text)) return 'social';
  if (ARNDXT_BOUNTY_RE.test(text)) return 'bounty';
  return 'mainnet';
}

/**
 * Parses arndxt's 2026 English Google Sheet CSV into curated cards and TGE entries.
 */
export function parseArndxtSheet(csv: string, nowMs = Date.now()): AirdropFeed {
  const rows = parseCsv(csv);
  const cards: Card[] = [];
  const tge: Tge[] = [];

  let headerIdx = -1;
  const colIndex: Record<string, number> = {};

  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const lowerCols = rows[i].map(c => c.trim().toLowerCase());
    const projIdx = lowerCols.findIndex(c => c === 'project' || c.startsWith('project'));
    if (projIdx >= 0 && lowerCols.some(c => c.includes('website') || c.includes('task') || c.includes('score'))) {
      headerIdx = i;
      lowerCols.forEach((col, idx) => {
        if (col.startsWith('project') && colIndex.project === undefined) colIndex.project = idx;
        else if ((col.includes('website') || col === 'url') && colIndex.website === undefined) colIndex.website = idx;
        else if ((col.includes('fundrais') || col.includes('raise')) && colIndex.raise === undefined) colIndex.raise = idx;
        else if (col.includes('reason') && colIndex.reasoning === undefined) colIndex.reasoning = idx;
        else if (col.includes('evidence')) return;
        else if (col.includes('tge') && colIndex.tge === undefined) colIndex.tge = idx;
        else if (col.includes('task') && colIndex.tasks === undefined) colIndex.tasks = idx;
        else if (col.includes('score') && colIndex.score === undefined) colIndex.score = idx;
      });
      break;
    }
  }

  if (headerIdx < 0) {
    return { cards: [], tge: [], counts: { active: 0, preToken: 0 }, fetchedAt: nowMs };
  }

  // Only apply canonical arndxt positional defaults (tasks=8, score=11) when
  // the header matches the standard 12-column arndxt layout and those columns
  // are not claimed by another named field; otherwise absent named columns stay missing.
  const isCanonicalArndxtLayout =
    rows[headerIdx].length >= 12 &&
    colIndex.project === 0 &&
    colIndex.website === 2 &&
    colIndex.raise === 3 &&
    colIndex.tge === 5 &&
    colIndex.reasoning === 6;
  if (isCanonicalArndxtLayout) {
    const claimedCols = new Set(Object.values(colIndex));
    if (colIndex.tasks === undefined && !claimedCols.has(8)) colIndex.tasks = 8;
    if (colIndex.score === undefined && !claimedCols.has(11)) colIndex.score = 11;
  }

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const cell = (idx: number | undefined): string | undefined => (idx !== undefined ? row[idx] : undefined);
    const rawProjectCell = cell(colIndex.project) ?? '';
    const cleanedName = stripOrTranslateCjk(rawProjectCell);
    if (!cleanedName) continue;
    const { name, ticker: sheetTicker } = extractSheetProjectAndTicker(rawProjectCell, cleanedName);

    const url = extractCleanSheetUrl(cell(colIndex.website));
    const raiseNum = parseCjkRaiseUsd(cell(colIndex.raise));
    const tgeRaw = stripOrTranslateCjk(cell(colIndex.tge) ?? '');
    const tasksRaw = stripOrTranslateCjk(cell(colIndex.tasks) ?? '');
    const reasoningRaw = stripOrTranslateCjk(cell(colIndex.reasoning) ?? '');
    const scoreRaw = Number.parseFloat((cell(colIndex.score) ?? '').trim());

    const sc = Number.isFinite(scoreRaw)
      ? Math.max(20, Math.min(95, Math.round(scoreRaw * 17 + 7)))
      : 55;
    const grade = gradeFromScore(sc);

    if (isArndxtPastTge(tgeRaw, nowMs)) {
      tge.push({
        n: name,
        t: sheetTicker ?? extractArndxtTgeTicker(tgeRaw) ?? '',
        s: 'Token live',
        d: tgeRaw.slice(0, 32) || 'Launched',
        tier: grade,
        raise: raiseNum > 0 ? fmtUsd(raiseNum) : undefined,
        url,
        source: 'arndxt',
      });
      continue;
    }

    const combinedText = `${tasksRaw} ${reasoningRaw}`;
    const cardType = inferArndxtTaskType(combinedText);
    const isZeroCost = inferArndxtZeroCost(tasksRaw, reasoningRaw);

    // Note: arndxt's "Farming risk" column rates competition/dilution, NOT scam
    // or drainer risk, so it must NOT emit the 'risk' badge (which disables Agent Brief).
    const badges: Badge[] = [];
    if (isZeroCost) badges.push('zero');
    if (sc >= 80) badges.push('early');

    const fit: FitKey[] = [];
    if (isZeroCost) fit.push('zero');
    else fit.push('small');
    if (cardType === 'testnet' || cardType === 'depin') fit.push('technical');
    if (cardType === 'trading' || cardType === 'staking') fit.push('climber');

    const taskTitle = (tasksRaw || reasoningRaw || 'Complete protocol tasks').slice(0, 140);
    const costNum = isZeroCost ? 0 : cardType === 'staking' ? 100 : 10;
    const inferredChain = inferChainFromLabel(`${name} ${combinedText}`);

    cards.push({
      r: cards.length + 1,
      n: name,
      id: '',
      chain: inferredChain,
      chains: inferredChain ? [inferredChain] : undefined,
      t: sheetTicker,
      g: grade,
      b: badges,
      x: null,
      img: '',
      f: fmtUsd(raiseNum),
      raiseNum,
      tk: '1/1',
      h: Number.isFinite(scoreRaw) ? Math.round(scoreRaw * 100) : 250,
      u: '—',
      fit,
      best: {
        n: taskTitle,
        ty: cardType,
        c: isZeroCost ? 'Free' : `$${costNum}`,
        m: '—',
      },
      costNum,
      taskTypes: [cardType],
      tasks: [
        {
          title: taskTitle,
          type: cardType,
          status: 'OPEN',
          cost: costNum,
          timeMinutes: null,
          url,
        },
      ],
      sc,
      sub: [
        Math.max(1, Math.min(10, Math.round(sc / 10))),
        isZeroCost ? 9 : 6,
        Number.isFinite(scoreRaw) ? Math.min(10, Math.round(scoreRaw * 2)) : null,
      ],
      url,
      source: 'arndxt',
    });
  }

  assignDeterministicSheetCardIds('arndxt', cards);

  return {
    cards,
    tge,
    counts: {
      active: cards.length,
      preToken: cards.filter(c => !c.b.includes('token')).length,
    },
    fetchedAt: nowMs,
  };
}

async function fetchCsvText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/csv,text/plain,*/*' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Sheet HTTP ${res.status} for ${url}`);
  return res.text();
}

export async function fetchAsso7878Sheet(url = ASSO7878_SHEET_URL, nowMs = Date.now()): Promise<AirdropFeed> {
  const csv = await fetchCsvText(url);
  const feed = parseAsso7878Sheet(csv, nowMs);
  if (feed.cards.length === 0 && feed.tge.length === 0) {
    throw new Error('Empty ASSO7878 sheet payload');
  }
  return feed;
}

export async function fetchArndxtSheet(url = ARNDXT_SHEET_URL, nowMs = Date.now()): Promise<AirdropFeed> {
  const csv = await fetchCsvText(url);
  const feed = parseArndxtSheet(csv, nowMs);
  if (feed.cards.length === 0 && feed.tge.length === 0) {
    throw new Error('Empty arndxt sheet payload');
  }
  return feed;
}
