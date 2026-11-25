import type { AirdropFeed, Badge, Card, CardTask, Grade, Tge } from '../../../shared/types';
import { FETCH_TIMEOUT_MS, USER_AGENT, fmtIsoDate, fmtPct, fmtUsd } from '../lib/format';
import { safeHttpsUrl } from '../lib/url';
import {
  buildSurfIndex,
  ingestPostIntoCluster,
  normalizeProjectKey,
  type IngestPostResult,
  type SurfIndex,
} from '../normalize/cluster';
import {
  BENIGN_DNS_IPS,
  cleanUrl,
  extractSuspiciousRawIpUrls,
  extractUrls,
  getRegistrableDomain,
  isRawIpHost,
} from '../normalize/domains';
import { stripOrTranslateCjk } from '../normalize/i18n';
import { extractTicker, parseDropPost, type ParseContext } from '../normalize/parse';
import { isStopName, MAJOR_TICKERS } from '../normalize/text';
import { loadKnownDomains } from '../safety';
import { getSeedSourceById, type SourceConfig } from './registry';
import { decodeHtmlEntities } from './telegram';

export const AIRDROPALERT_CALENDAR_URL =
  'https://airdropalert.com/wp-json/wp/v2/aa_calendar_event?per_page=30';
export const GALXE_GRAPHQL_URL = 'https://graphigo.prd.galaxy.eco/query';
export const PENDLE_POINTS_URL = 'https://api-v2.pendle.finance/core/v1/markets/all?isActive=true';
export const MERKL_OPPORTUNITIES_URL =
  'https://api.merkl.xyz/v4/opportunities?items=50&status=LIVE&sort=tvl&order=desc';

export interface ParsedFeedPost {
  id: string;
  legacyId?: string;
  postUrl: string;
  postedAt: number;
  text: string;
  urls: string[];
}

const GALXE_TRENDING_QUERY = `query TrendingCampaigns {
  campaigns(input: { first: 15, listType: Trending, statuses: [Active], isVerified: [1], orderByParticipation: true }) {
    list {
      id
      name
      status
      startTime
      endTime
      chain
      space {
        id
        name
        alias
        followersCount
        isVerified
      }
    }
  }
}`;

const SUBSTACK_DROP_RE =
  /\b(?:airdrop|airdrops|points?|tge|testnet|claim|checker|farming|farm|season\s*\d+|epoch|waitlist|whitelist|quest|incentiv\w*|pre-?token|snapshot)\b/i;

const PENDLE_CHAIN_NAMES: Record<number, { name: string; slug: string }> = {
  1: { name: 'Ethereum', slug: 'ethereum' },
  10: { name: 'Optimism', slug: 'optimism' },
  56: { name: 'BNB', slug: 'bnbchain' },
  143: { name: 'Monad', slug: 'monad' },
  146: { name: 'Sonic', slug: 'sonic' },
  999: { name: 'HyperEVM', slug: 'hyperevm' },
  5000: { name: 'Mantle', slug: 'mantle' },
  8453: { name: 'Base', slug: 'base' },
  42161: { name: 'Arbitrum', slug: 'arbitrum' },
  80094: { name: 'Berachain', slug: 'berachain' },
};

const GALXE_CHAIN_NAMES: Record<string, string> = {
  ETHEREUM: 'Ethereum',
  ARBITRUM: 'Arbitrum',
  BASE: 'Base',
  OPTIMISM: 'Optimism',
  BSC: 'BNB',
  MATIC: 'Polygon',
  SOLANA: 'Solana',
  MONAD: 'Monad',
  BERACHAIN: 'Berachain',
  SUI: 'Sui',
  AVALANCHE: 'Avalanche',
  LINEA: 'Linea',
  SCROLL: 'Scroll',
  ZKSYNC: 'zkSync',
  SONIC: 'Sonic',
  ABSTRACT: 'Abstract',
  MANTLE: 'Mantle',
};

const FEED_EXTRA_ENTITIES: Record<string, string> = {
  rsquo: '\u2019',
  lsquo: '\u2018',
  ldquo: '\u201C',
  rdquo: '\u201D',
  mdash: '\u2014',
  ndash: '\u2013',
  hellip: '\u2026',
};

function decodeFeedHtmlEntities(input: string): string {
  const expanded = input.replace(
    /&(rsquo|lsquo|ldquo|rdquo|mdash|ndash|hellip);/gi,
    (m, name: string) => FEED_EXTRA_ENTITIES[name.toLowerCase()] ?? m,
  );
  return decodeHtmlEntities(expanded);
}

const KNOWN_ESCAPED_HTML_TAG_RE =
  /<\/?(?:p|div|span|a|br|img|ul|ol|li|strong|em|b|i|h[1-6]|table|tr|td|blockquote|script|style)(?:\s[^>]*)?\/?>/gi;

function stripCdata(raw: string): string {
  return raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1').trim();
}

function extractHrefsFromHtml(html: string, preserveRawIp = false): string[] {
  const urls: string[] = [];
  const re = /href\s*=\s*["'](https?:\/\/[^"'\s>]+)["']/gi;
  for (const m of html.matchAll(re)) {
    const rawHref = decodeFeedHtmlEntities(m[1]).trim();
    try {
      const parsed = new URL(rawHref);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        const host = parsed.hostname.toLowerCase();
        if (isRawIpHost(host)) {
          if (preserveRawIp && !BENIGN_DNS_IPS.has(host)) {
            urls.push(parsed.toString());
          }
          continue;
        }
      }
    } catch {
      continue;
    }
    const cleaned = cleanUrl(rawHref);
    if (cleaned) urls.push(cleaned);
  }
  return urls;
}

function htmlToPlainText(html: string): string {
  const unwrapped = stripCdata(html);
  const hadRawTags = /<\/?[a-z!][^>]*>/i.test(unwrapped);
  const stripped = unwrapped
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  let decoded = decodeFeedHtmlEntities(stripped);
  if (!hadRawTags && KNOWN_ESCAPED_HTML_TAG_RE.test(decoded)) {
    KNOWN_ESCAPED_HTML_TAG_RE.lastIndex = 0;
    decoded = decoded
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|div|li|h[1-6])>/gi, '\n')
      .replace(KNOWN_ESCAPED_HTML_TAG_RE, ' ');
  }
  KNOWN_ESCAPED_HTML_TAG_RE.lastIndex = 0;

  return decoded
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function extractXmlTag(block: string, tagName: string): string {
  const re = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)</${tagName}>`, 'i');
  const m = block.match(re);
  return m ? stripCdata(m[1]) : '';
}

function extractTagAttr(tag: string, attrName: string): string | null {
  const escaped = attrName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
  const m = tag.match(re);
  return m ? (m[1] ?? m[2] ?? '') : null;
}

function resolveXmlBase(rawBase: string | null | undefined, inheritedBase?: string): string | undefined {
  const decoded = rawBase ? decodeFeedHtmlEntities(rawBase).trim() : '';
  if (!decoded) return inheritedBase;
  try {
    return inheritedBase ? new URL(decoded, inheritedBase).toString() : new URL(decoded).toString();
  } catch {
    return inheritedBase;
  }
}

function resolveAtomHref(rawHref: string, base?: string): string {
  const decoded = decodeFeedHtmlEntities(rawHref).trim();
  if (!decoded) return '';
  if (!base) return decoded;
  try {
    return new URL(decoded, base).toString();
  } catch {
    return decoded;
  }
}

function extractAtomLink(block: string, entryBase?: string): string {
  const linkTags = block.match(/<link\b[^>]*\/?>/gi) ?? [];
  let fallbackHref = '';
  let anyHref = '';
  for (const tag of linkTags) {
    const href = extractTagAttr(tag, 'href');
    if (!href) continue;
    const linkBase = resolveXmlBase(extractTagAttr(tag, 'xml:base'), entryBase);
    const resolvedHref = resolveAtomHref(href, linkBase);
    if (!resolvedHref) continue;
    if (!anyHref) anyHref = resolvedHref;
    const rel = extractTagAttr(tag, 'rel')?.trim().toLowerCase() ?? '';
    if (rel === 'alternate' || rel === '') {
      return resolvedHref;
    }
    if (!fallbackHref && rel !== 'enclosure' && rel !== 'self') {
      fallbackHref = resolvedHref;
    }
  }
  if (fallbackHref) return fallbackHref;
  if (anyHref) return anyHref;
  return resolveAtomHref(extractXmlTag(block, 'link'), entryBase);
}

const UTF8_ENCODER = new TextEncoder();
const CLEAN_POST_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;

function fnv1a32Hex(input: string): string {
  let hash = 0x811c9dc5;
  for (const byte of UTF8_ENCODER.encode(input)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function fnv1a64Hex(input: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of UTF8_ENCODER.encode(input)) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}

function legacyNormalizePostId(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/[^A-Za-z0-9._:-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!cleaned) return '';
  return cleaned.length > 80 ? cleaned.slice(-80) : cleaned;
}

function normalizePostId(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (CLEAN_POST_ID_RE.test(trimmed)) return trimmed;

  const sanitized = trimmed
    .replace(/^https?:\/\//i, '')
    .replace(/[^A-Za-z0-9._:-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!sanitized) return '';
  const prefix = sanitized.slice(0, 48).replace(/-+$/, '') || sanitized.slice(0, 48);
  return `${prefix}~${fnv1a64Hex(trimmed)}`;
}

function normalizePostIdPair(raw: string): { id: string; legacyId?: string } {
  const id = normalizePostId(raw);
  if (!id) return { id: '' };
  const legacy = legacyNormalizePostId(raw);
  return legacy && legacy !== id ? { id, legacyId: legacy } : { id };
}

function slugify(raw: string): string {
  return (
    raw
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'item'
  );
}

/**
 * Assigns deterministic, rank-order-independent card IDs. Canonical slug keys keep
 * `<prefix>:<slug>`; non-canonical keys use `<prefix>:<slug>~<hash>` (`~` cannot appear
 * in `slugify` output, so hashed IDs never collide with canonical IDs), and any rare
 * 32-bit hash collision upgrades all colliding keys to 64-bit regardless of sort order.
 */
function buildStableCardIdMap(prefix: string, identityKeys: readonly string[]): Map<string, string> {
  const primary = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const identityKey of identityKeys) {
    if (primary.has(identityKey)) continue;
    const slug = slugify(identityKey);
    const cardId =
      identityKey === slug ? `${prefix}:${slug}` : `${prefix}:${slug}~${fnv1a32Hex(identityKey)}`;
    primary.set(identityKey, cardId);
    counts.set(cardId, (counts.get(cardId) ?? 0) + 1);
  }

  const resolved = new Map<string, string>();
  for (const [identityKey, cardId] of primary) {
    if ((counts.get(cardId) ?? 0) > 1) {
      const slug = slugify(identityKey);
      resolved.set(identityKey, `${prefix}:${slug}~${fnv1a64Hex(identityKey)}`);
    } else {
      resolved.set(identityKey, cardId);
    }
  }
  return resolved;
}

/**
 * Lightweight zero-dependency RSS 2.0 & Atom XML parser suitable for Workers.
 * Undated/invalid entries are strictly dropped (never stamped with Date.now()).
 */
export function parseRssOrAtomXml(xml: string, baseUrl?: string): ParsedFeedPost[] {
  const posts: ParsedFeedPost[] = [];
  const seen = new Set<string>();

  const itemBlocks = xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) ?? [];
  const entryBlocks = itemBlocks.length === 0 ? (xml.match(/<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/gi) ?? []) : [];
  const isAtom = itemBlocks.length === 0 && entryBlocks.length > 0;
  const blocks = isAtom ? entryBlocks : itemBlocks;
  const feedOpenTag = isAtom ? (xml.match(/<feed\b[^>]*>/i)?.[0] ?? '') : '';
  const feedBase = isAtom ? resolveXmlBase(extractTagAttr(feedOpenTag, 'xml:base'), baseUrl) : baseUrl;

  for (const block of blocks) {
    const rawTitle = extractXmlTag(block, 'title');
    const entryOpenTag = isAtom ? (block.match(/^<entry\b[^>]*>/i)?.[0] ?? '') : '';
    const entryBase = isAtom ? resolveXmlBase(extractTagAttr(entryOpenTag, 'xml:base'), feedBase) : feedBase;
    const rawLink = isAtom ? extractAtomLink(block, entryBase) : extractXmlTag(block, 'link');
    const rawGuid = isAtom ? extractXmlTag(block, 'id') : extractXmlTag(block, 'guid');
    const rawDate = isAtom
      ? extractXmlTag(block, 'published') || extractXmlTag(block, 'updated')
      : extractXmlTag(block, 'pubDate') || extractXmlTag(block, 'dc:date');
    const rawDescTag = isAtom ? extractXmlTag(block, 'summary') : extractXmlTag(block, 'description');
    const rawContentTag = isAtom ? extractXmlTag(block, 'content') : extractXmlTag(block, 'content:encoded');
    const rawDesc = rawDescTag || rawContentTag;

    const postedAt = rawDate ? Date.parse(decodeFeedHtmlEntities(rawDate).trim()) : NaN;
    if (!Number.isFinite(postedAt)) continue;

    const postUrl = cleanUrl(decodeFeedHtmlEntities(rawLink));
    if (!postUrl) continue;

    const { id, legacyId } = normalizePostIdPair(decodeFeedHtmlEntities(rawGuid) || postUrl);
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const title = htmlToPlainText(rawTitle);
    const descPlain = htmlToPlainText(rawDesc);
    const text = [title, descPlain].filter(Boolean).join('\n').trim();
    if (!text) continue;

    const htmlForHrefs = [rawDescTag, rawContentTag]
      .filter(Boolean)
      .map(part => decodeFeedHtmlEntities(stripCdata(part)))
      .join('\n');
    const hrefUrls = extractHrefsFromHtml(htmlForHrefs, true);
    // Put extracted external hrefs ahead of postUrl so direct project domains
    // take priority while postUrl remains on FeedSourceRef.postUrl.
    const cleanTextUrls = extractUrls(text, [...hrefUrls, postUrl]);
    const rawIpUrls = extractSuspiciousRawIpUrls(text, hrefUrls);
    const textUrls = [...cleanTextUrls, ...rawIpUrls];

    posts.push({
      id,
      ...(legacyId ? { legacyId } : {}),
      postUrl,
      postedAt,
      text,
      urls: textUrls,
    });
  }

  return posts;
}

interface WpCalendarEvent {
  id?: number | string;
  date?: string;
  date_gmt?: string;
  modified?: string;
  slug?: string;
  title?: { rendered?: string };
  content?: { rendered?: string };
  excerpt?: { rendered?: string };
  link?: string;
  jetpack_featured_media_url?: string;
  yoast_head_json?: {
    og_image?: { url?: string }[];
  };
  _embedded?: {
    'wp:featuredmedia'?: { source_url?: string }[];
  };
}

const FEED_NON_TICKER_PARENS = new Set([
  'TGE', 'DEX', 'CEX', 'NFT', 'NFTS', 'V1', 'V2', 'V3', 'L1', 'L2', 'TBA', 'LIVE', 'NEW', 'S1', 'S2', 'S3', 'AI', 'DAO', 'DEFI', 'KYC',
]);

function extractParenthesizedTicker(text: string): string | undefined {
  for (const m of text.matchAll(/\(\s*\$?([A-Z][A-Z0-9]{1,9})\s*\)/g)) {
    const sym = m[1];
    if (!sym || MAJOR_TICKERS.has(sym) || isStopName(sym) || FEED_NON_TICKER_PARENS.has(sym)) continue;
    return sym;
  }
  return undefined;
}

const IGNORED_IMG_URL_RE = /(?:\/images\/core\/emoji\/|gravatar\.com|\/1x1\.|\/pixel\.|\/spacer\.)/i;

function extractFirstHttpsImgFromHtml(html: string): string | null {
  if (!html) return null;
  const tags = html.match(/<img\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const rawSrc = extractTagAttr(tag, 'src');
    if (!rawSrc) continue;
    const decoded = decodeFeedHtmlEntities(rawSrc).trim();
    if (!decoded || IGNORED_IMG_URL_RE.test(decoded)) continue;
    const safe = safeHttpsUrl(decoded);
    if (safe) return safe;
  }
  return null;
}

function extractWpCalendarLogo(item: WpCalendarEvent, bodyHtml: string): string | null {
  const candidates = [
    item.jetpack_featured_media_url,
    item._embedded?.['wp:featuredmedia']?.[0]?.source_url,
    item.yoast_head_json?.og_image?.[0]?.url,
  ];
  for (const raw of candidates) {
    if (!raw || IGNORED_IMG_URL_RE.test(raw)) continue;
    const safe = safeHttpsUrl(raw);
    if (safe) return safe;
  }
  return extractFirstHttpsImgFromHtml(bodyHtml);
}

function parseWpDateMs(ev: WpCalendarEvent): number {
  if (ev.date_gmt) {
    const withTz = /Z|[+-]\d{2}:?\d{2}$/i.test(ev.date_gmt) ? ev.date_gmt : `${ev.date_gmt}Z`;
    const ts = Date.parse(withTz);
    if (Number.isFinite(ts)) return ts;
  }
  const fallback = ev.date || ev.modified || '';
  return fallback ? Date.parse(fallback) : NaN;
}

export function parseWpCalendarToFeedPosts(raw: unknown): ParsedFeedPost[] {
  if (!Array.isArray(raw)) return [];
  const out: ParsedFeedPost[] = [];
  for (const item of raw as WpCalendarEvent[]) {
    const postedAt = parseWpDateMs(item);
    if (!Number.isFinite(postedAt)) continue;
    const postUrl = item.link ? cleanUrl(item.link) : null;
    if (!postUrl) continue;

    const title = htmlToPlainText(item.title?.rendered ?? '');
    const bodyHtml = item.content?.rendered ?? item.excerpt?.rendered ?? '';
    const bodyText = htmlToPlainText(bodyHtml);
    const text = [title, bodyText].filter(Boolean).join('\n').trim();
    if (!text) continue;

    const { id, legacyId } = normalizePostIdPair(String(item.id ?? item.slug ?? postUrl));
    if (!id) continue;

    const hrefs = extractHrefsFromHtml(bodyHtml, true);
    const urls = [...extractUrls(text, [...hrefs, postUrl]), ...extractSuspiciousRawIpUrls(text, hrefs)];

    out.push({ id, ...(legacyId ? { legacyId } : {}), postUrl, postedAt, text, urls });
  }
  return out;
}

export function parseWpCalendarFeedPayload(raw: unknown): ParsedFeedPost[] {
  if (!Array.isArray(raw)) {
    throw new Error('Malformed WP calendar payload: expected event array');
  }
  return parseWpCalendarToFeedPosts(raw);
}

function inferCalendarStatus(text: string): string {
  const lower = text.toLowerCase();
  if (/\b(?:ended|stopped|closed|expired)\b/.test(lower)) return 'Ended';
  if (/\b(?:claim|checker|claimable|eligibility)\b/.test(lower)) return 'Claimable';
  if (/\b(?:snapshot)\b/.test(lower)) return 'Snapshot';
  if (/\b(?:tge|launch|listing)\b/.test(lower)) return 'TGE';
  return 'Upcoming';
}

export function parseWpCalendarToAirdropFeed(raw: unknown, nowMs = Date.now()): AirdropFeed {
  if (!Array.isArray(raw)) {
    return { cards: [], tge: [], counts: { active: 0, preToken: 0 }, fetchedAt: nowMs };
  }
  const tge: Tge[] = [];
  const seen = new Set<string>();
  for (const item of raw as WpCalendarEvent[]) {
    const title = stripOrTranslateCjk(htmlToPlainText(item.title?.rendered ?? ''));
    if (!title) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const bodyHtml = item.content?.rendered ?? item.excerpt?.rendered ?? '';
    const bodyText = htmlToPlainText(bodyHtml);
    const combined = `${title} ${bodyText}`;
    const ticker = extractTicker(combined) ?? extractParenthesizedTicker(title) ?? '';
    const logo = extractWpCalendarLogo(item, bodyHtml);
    const dateMs = parseWpDateMs(item);
    const hrefs = extractHrefsFromHtml(bodyHtml, false);
    const externalHref = hrefs.find(u => {
      const reg = getRegistrableDomain(u);
      return Boolean(reg && reg !== 'airdropalert.com');
    });
    const fallbackLink = item.link ? cleanUrl(item.link) : null;

    tge.push({
      n: title,
      t: ticker,
      s: inferCalendarStatus(combined),
      d: Number.isFinite(dateMs) ? fmtIsoDate(dateMs) : 'TBA',
      ...(logo ? { logo } : {}),
      url: externalHref ?? fallbackLink,
      source: 'AirdropAlert',
    });
  }

  return {
    cards: [],
    tge,
    counts: { active: 0, preToken: 0 },
    fetchedAt: nowMs,
  };
}

interface SubstackPost {
  id?: number | string;
  slug?: string;
  title?: string;
  subtitle?: string;
  post_date?: string;
  audience?: string;
  canonical_url?: string;
}

export function parseSubstackArchive(raw: unknown): ParsedFeedPost[] {
  const list = Array.isArray(raw)
    ? (raw as SubstackPost[])
    : raw && typeof raw === 'object' && Array.isArray((raw as { posts?: unknown }).posts)
      ? ((raw as { posts: SubstackPost[] }).posts)
      : [];

  const out: ParsedFeedPost[] = [];
  for (const post of list) {
    if (post.audience && post.audience !== 'everyone') continue;
    const postedAt = post.post_date ? Date.parse(post.post_date) : NaN;
    if (!Number.isFinite(postedAt)) continue;
    const postUrl = post.canonical_url ? cleanUrl(post.canonical_url) : null;
    if (!postUrl) continue;

    const title = stripOrTranslateCjk(post.title ?? '');
    const subtitle = stripOrTranslateCjk(post.subtitle ?? '');
    const text = [title, subtitle].filter(Boolean).join(' — ').trim();
    if (!text || !SUBSTACK_DROP_RE.test(text)) continue;

    const { id, legacyId } = normalizePostIdPair(String(post.id ?? post.slug ?? postUrl));
    if (!id) continue;

    out.push({
      id,
      ...(legacyId ? { legacyId } : {}),
      postUrl,
      postedAt,
      text,
      urls: extractUrls(text, [postUrl]),
    });
  }
  return out;
}

interface GalxeCampaign {
  id?: string;
  name?: string;
  status?: string;
  startTime?: number;
  endTime?: number;
  chain?: string;
  participantsCount?: number;
  space?: {
    id?: string;
    name?: string;
    alias?: string;
    followersCount?: number;
    isVerified?: boolean;
  };
}

export function parseGalxeCampaigns(raw: unknown, nowMs = Date.now()): ParsedFeedPost[] {
  const list = (raw as { data?: { campaigns?: { list?: GalxeCampaign[] } } } | null)?.data?.campaigns?.list ?? [];
  const out: ParsedFeedPost[] = [];

  for (const c of list) {
    if (!c?.id || !c.name || !c.space) continue;
    if (c.space.isVerified !== true) continue;
    if (c.status !== 'Active') continue;
    // Strict spam gate: require >= 10,000 verified space followers.
    if (typeof c.space.followersCount !== 'number' || c.space.followersCount < 10_000) continue;

    const startSec = Number(c.startTime);
    if (!Number.isFinite(startSec) || startSec <= 0) continue;
    const postedAt = startSec * 1000;

    if (c.endTime != null && c.endTime !== 0) {
      const endSec = Number(c.endTime);
      if (!Number.isFinite(endSec) || endSec * 1000 < nowMs) continue;
    }

    const { id, legacyId } = normalizePostIdPair(c.id);
    if (!id) continue;

    const cleanAlias = stripOrTranslateCjk(c.space.alias ?? '');
    const spaceName = stripOrTranslateCjk(c.space.name ?? '') || cleanAlias || 'Galxe Space';
    const campaignName = stripOrTranslateCjk(c.name) || 'Verified Campaign';
    const spaceSlug = cleanAlias || c.space.id || '';
    if (!spaceSlug) continue;

    const postUrl = `https://app.galxe.com/quest/${encodeURIComponent(spaceSlug)}/${encodeURIComponent(c.id)}`;
    const chainLabel = c.chain ? GALXE_CHAIN_NAMES[c.chain.toUpperCase()] : undefined;
    const chainSuffix = chainLabel ? ` on ${chainLabel}` : '';
    const text = `${spaceName} — ${campaignName} (Galxe verified quest${chainSuffix})`;

    out.push({
      id,
      ...(legacyId ? { legacyId } : {}),
      postUrl,
      postedAt,
      text,
      urls: [postUrl],
    });
  }
  return out;
}

interface PendleMarket {
  name?: string;
  address?: string;
  protocol?: string;
  proIcon?: string;
  icon?: string;
  chainId?: number;
  expiry?: string;
  categoryIds?: string[];
  details?: {
    liquidity?: number;
    impliedApy?: number;
  };
  isNew?: boolean;
}

function gradeFromLiquidity(liq: number): Grade {
  if (liq >= 50_000_000) return 'S';
  if (liq >= 15_000_000) return 'A';
  if (liq >= 3_000_000) return 'B';
  return 'C';
}

export function parsePendlePoints(raw: unknown, nowMs = Date.now()): AirdropFeed {
  const list = Array.isArray(raw)
    ? (raw as PendleMarket[])
    : raw && typeof raw === 'object' && Array.isArray((raw as { markets?: unknown }).markets)
      ? ((raw as { markets: PendleMarket[] }).markets)
      : [];

  const grouped = new Map<
    string,
    {
      key: string;
      name: string;
      icon: string;
      chains: Set<string>;
      liquidity: number;
      isNew: boolean;
      markets: { liq: number; url: string; task: CardTask }[];
    }
  >();

  for (const m of list) {
    const cats = (m.categoryIds ?? []).map(c => String(c).toLowerCase());
    if (!cats.includes('points')) continue;
    const expiryMs = m.expiry ? Date.parse(m.expiry) : NaN;
    if (Number.isFinite(expiryMs) && expiryMs < nowMs) continue;

    const protoRaw = m.protocol || m.name || '';
    const protoName = stripOrTranslateCjk(protoRaw);
    if (!protoName) continue;

    const chainInfo = m.chainId != null ? PENDLE_CHAIN_NAMES[m.chainId] : undefined;
    const chainName = chainInfo?.name ?? 'Multi-Chain';
    const rawLiq = Number(m.details?.liquidity ?? 0);
    const liq = Number.isFinite(rawLiq) && rawLiq > 0 ? rawLiq : 0;
    const impliedApy = typeof m.details?.impliedApy === 'number' ? m.details.impliedApy * 100 : null;
    const marketUrl =
      m.address && chainInfo
        ? `https://app.pendle.finance/trade/markets/${encodeURIComponent(m.address)}/swap?view=yt&chain=${chainInfo.slug}`
        : 'https://app.pendle.finance/points';
    const marketName = stripOrTranslateCjk(m.name ?? protoName) || protoName;
    const expLabel = m.expiry ? fmtIsoDate(m.expiry) : 'Active';
    const apySuffix = impliedApy != null && Number.isFinite(impliedApy) ? ` · ${fmtPct(impliedApy).replace(/^\+/, '')} implied APY` : '';
    const marketIcon = safeHttpsUrl(m.proIcon ?? m.icon) ?? '';

    const key = protoName.toLowerCase();
    let bucket = grouped.get(key);
    if (!bucket) {
      bucket = {
        key,
        name: protoName,
        icon: marketIcon,
        chains: new Set<string>(),
        liquidity: 0,
        isNew: false,
        markets: [],
      };
      grouped.set(key, bucket);
    } else if (!bucket.icon && marketIcon) {
      bucket.icon = marketIcon;
    }
    bucket.chains.add(chainName);
    bucket.liquidity += liq;
    bucket.isNew ||= Boolean(m.isNew);
    bucket.markets.push({
      liq,
      url: marketUrl,
      task: {
        title: `Pendle YT/LP ${marketName} (exp ${expLabel}${apySuffix})`,
        type: 'staking',
        status: 'OPEN',
        cost: 100,
        timeMinutes: null,
        url: marketUrl,
      },
    });
  }

  const topGroups = [...grouped.values()]
    .sort((a, b) => b.liquidity - a.liquidity || a.name.localeCompare(b.name))
    .slice(0, 40);
  const cardIdByKey = buildStableCardIdMap(
    'pendle',
    topGroups.map(g => g.key),
  );
  const cards: Card[] = topGroups.map((g, idx) => {
      g.markets.sort((a, b) => b.liq - a.liq || a.task.title.localeCompare(b.task.title));
      const topMarkets = g.markets.slice(0, 5);
      const tasks = topMarkets.map(m => m.task);
      const primaryUrl = topMarkets[0]?.url ?? 'https://app.pendle.finance/points';
      const chains = [...g.chains];
      const grade = gradeFromLiquidity(g.liquidity);
      const sc = grade === 'S' ? 84 : grade === 'A' ? 74 : grade === 'B' ? 60 : 48;
      const badges: Badge[] = ['live'];
      if (g.isNew) badges.push('early');
      const best = tasks[0];

      const cardId = cardIdByKey.get(g.key)!;

      return {
        r: idx + 1,
        n: g.name,
        id: cardId,
        chain: chains[0],
        chains,
        t: null,
        g: grade,
        b: badges,
        x: null,
        img: g.icon,
        f: '—',
        raiseNum: 0,
        tk: `${tasks.length}/${tasks.length}`,
        h: Math.round(g.liquidity / 100_000),
        u: 'today',
        updatedTs: Math.floor(nowMs / 1000),
        fit: ['small', 'climber'],
        best: {
          n: best ? best.title : `Farm ${g.name} points on Pendle`,
          ty: 'staking',
          c: 'Deposit',
          m: '—',
        },
        costNum: 100,
        taskTypes: ['staking', 'liquidity'],
        tasks,
        sc,
        sub: [7, 7, null],
        url: primaryUrl,
        source: 'Pendle',
      };
    });

  return {
    cards,
    tge: [],
    counts: { active: cards.length, preToken: cards.length },
    fetchedAt: nowMs,
  };
}

interface MerklToken {
  symbol?: string;
  icon?: string;
}

interface MerklOpportunity {
  id?: string;
  identifier?: string;
  name?: string;
  chain?: { name?: string; icon?: string };
  protocol?: { id?: string; name?: string; icon?: string };
  tokens?: MerklToken[];
  rewardsRecord?: {
    breakdowns?: { token?: MerklToken }[];
  };
  action?: string;
  status?: string;
  tvl?: number;
  apr?: number;
  dailyRewards?: number;
  depositUrl?: string;
  tags?: string[];
}

function mapMerklAction(action?: string): string {
  const upper = (action ?? '').toUpperCase();
  if (upper === 'SWAP' || upper === 'TRADE') return 'trading';
  if (upper === 'HOLD' || upper === 'STAKE') return 'staking';
  return 'liquidity';
}

function extractMerklTokenFallbackIcon(op: MerklOpportunity): string {
  const tokens = op.tokens ?? [];
  for (const tok of tokens) {
    const sym = tok?.symbol?.trim().toUpperCase();
    if (sym && !MAJOR_TICKERS.has(sym)) {
      const icon = safeHttpsUrl(tok.icon);
      if (icon) return icon;
    }
  }
  for (const tok of tokens) {
    const icon = safeHttpsUrl(tok?.icon);
    if (icon) return icon;
  }
  for (const b of op.rewardsRecord?.breakdowns ?? []) {
    const icon = safeHttpsUrl(b?.token?.icon);
    if (icon) return icon;
  }
  return '';
}

function extractMerklProtocolTicker(op: MerklOpportunity, protoName: string): string | null {
  const protoKey = normalizeProjectKey(protoName);
  if (protoKey.length < 3) return null;
  const candidates: MerklToken[] = [
    ...(op.rewardsRecord?.breakdowns?.map(b => b?.token).filter((t): t is MerklToken => Boolean(t)) ?? []),
    ...(op.tokens ?? []),
  ];
  for (const tok of candidates) {
    const sym = stripOrTranslateCjk(tok?.symbol ?? '').trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9]{2,9}$/.test(sym)) continue;
    if (MAJOR_TICKERS.has(sym) || isStopName(sym)) continue;
    const symLower = sym.toLowerCase();
    if (protoKey === symLower || protoKey.startsWith(symLower)) {
      return sym;
    }
  }
  return null;
}

export function parseMerklOpportunities(raw: unknown, nowMs = Date.now()): AirdropFeed {
  if (!Array.isArray(raw)) {
    return { cards: [], tge: [], counts: { active: 0, preToken: 0 }, fetchedAt: nowMs };
  }

  const grouped = new Map<
    string,
    {
      key: string;
      rawProtoId: string;
      name: string;
      icon: string;
      hasProtocolIcon: boolean;
      ticker: string | null;
      chains: Set<string>;
      tvl: number;
      maxApr: number;
      tasks: CardTask[];
      taskTypes: Set<string>;
      primaryUrl: string | null;
    }
  >();

  for (const op of raw as MerklOpportunity[]) {
    if (op.status && op.status.toUpperCase() !== 'LIVE') continue;
    const tvl = Number(op.tvl ?? 0);
    if (!Number.isFinite(tvl) || tvl < 100_000) continue;

    const protoName = stripOrTranslateCjk(op.protocol?.name || op.name || '');
    if (!protoName) continue;

    const url = op.depositUrl ? cleanUrl(op.depositUrl) : null;
    const chainName = stripOrTranslateCjk(op.chain?.name ?? '') || 'Multi-Chain';
    const opName = stripOrTranslateCjk(op.name ?? protoName) || protoName;
    const apr = typeof op.apr === 'number' && Number.isFinite(op.apr) ? op.apr : null;
    const type = mapMerklAction(op.action);
    const rawProtoId = typeof op.protocol?.id === 'string' ? op.protocol.id.trim() : '';
    const key = (rawProtoId || protoName).toLowerCase();
    const protoIcon = safeHttpsUrl(op.protocol?.icon) ?? '';
    const fallbackTokenIcon = protoIcon ? '' : extractMerklTokenFallbackIcon(op);
    const matchedTicker = extractMerklProtocolTicker(op, protoName);

    let bucket = grouped.get(key);
    if (!bucket) {
      bucket = {
        key,
        rawProtoId,
        name: protoName,
        icon: protoIcon || fallbackTokenIcon,
        hasProtocolIcon: Boolean(protoIcon),
        ticker: matchedTicker,
        chains: new Set<string>(),
        tvl: 0,
        maxApr: 0,
        tasks: [],
        taskTypes: new Set<string>(),
        primaryUrl: url,
      };
      grouped.set(key, bucket);
    } else {
      if (!bucket.rawProtoId && rawProtoId) {
        bucket.rawProtoId = rawProtoId;
      }
      if (protoIcon && !bucket.hasProtocolIcon) {
        bucket.icon = protoIcon;
        bucket.hasProtocolIcon = true;
      } else if (!bucket.icon && fallbackTokenIcon) {
        bucket.icon = fallbackTokenIcon;
      }
      if (!bucket.ticker && matchedTicker) {
        bucket.ticker = matchedTicker;
      }
    }
    bucket.chains.add(chainName);
    bucket.tvl += tvl;
    if (apr != null && apr > bucket.maxApr) bucket.maxApr = apr;
    bucket.taskTypes.add(type);
    if (!bucket.primaryUrl && url) bucket.primaryUrl = url;
    if (bucket.tasks.length < 4) {
      const aprText = apr != null && apr > 0 ? ` · ${apr.toFixed(1)}% APR` : '';
      bucket.tasks.push({
        title: `${opName} (${fmtUsd(tvl)} TVL${aprText})`,
        type,
        status: 'OPEN',
        cost: 100,
        timeMinutes: null,
        url,
      });
    }
  }

  const topGroups = [...grouped.values()]
    .sort((a, b) => b.tvl - a.tvl || a.name.localeCompare(b.name))
    .slice(0, 25);
  const cardIdByKey = buildStableCardIdMap(
    'merkl',
    topGroups.map(g => (g.rawProtoId ? g.rawProtoId.toLowerCase() : g.key)),
  );
  const cards: Card[] = topGroups.map((g, idx) => {
      const chains = [...g.chains];
      const grade = gradeFromLiquidity(g.tvl);
      const sc = grade === 'S' ? 82 : grade === 'A' ? 72 : grade === 'B' ? 58 : 46;
      const best = g.tasks[0];

      const identityKey = g.rawProtoId ? g.rawProtoId.toLowerCase() : g.key;
      const cardId = cardIdByKey.get(identityKey)!;

      return {
        r: idx + 1,
        n: g.name,
        id: cardId,
        chain: chains[0],
        chains,
        t: g.ticker,
        g: grade,
        b: ['live'],
        x: null,
        img: g.icon,
        f: '—',
        raiseNum: 0,
        tk: `${g.tasks.length}/${g.tasks.length}`,
        h: Math.round(g.tvl / 100_000),
        u: 'today',
        updatedTs: Math.floor(nowMs / 1000),
        fit: ['small', 'climber'],
        best: {
          n: best ? best.title : `Earn Merkl rewards on ${g.name}`,
          ty: best?.type ?? 'liquidity',
          c: 'Deposit',
          m: '—',
        },
        costNum: 100,
        taskTypes: [...g.taskTypes],
        tasks: g.tasks,
        sc,
        sub: [7, 7, null],
        url: g.primaryUrl,
        source: 'Merkl',
      };
    });

  return {
    cards,
    tge: [],
    counts: { active: cards.length, preToken: cards.length },
    fetchedAt: nowMs,
  };
}

async function fetchJsonWithTimeout(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, {
    ...init,
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Feed HTTP ${res.status} for ${url}`);
  return res.json();
}

async function fetchTextWithTimeout(url: string): Promise<{ text: string; url: string }> {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml,application/xml,text/xml,*/*' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Feed HTTP ${res.status} for ${url}`);
  return { text: await res.text(), url: res.url || url };
}

export async function fetchPendlePoints(url = PENDLE_POINTS_URL, nowMs = Date.now()): Promise<AirdropFeed> {
  const raw = await fetchJsonWithTimeout(url);
  const feed = parsePendlePoints(raw, nowMs);
  if (feed.cards.length === 0) {
    throw new Error('Empty Pendle points payload');
  }
  return feed;
}

export async function fetchMerklOpportunities(url = MERKL_OPPORTUNITIES_URL, nowMs = Date.now()): Promise<AirdropFeed> {
  const raw = await fetchJsonWithTimeout(url);
  const feed = parseMerklOpportunities(raw, nowMs);
  if (feed.cards.length === 0) {
    throw new Error('Empty Merkl opportunities payload');
  }
  return feed;
}

export async function fetchWpCalendarAirdrops(
  url = AIRDROPALERT_CALENDAR_URL,
  nowMs = Date.now(),
): Promise<AirdropFeed> {
  const raw = await fetchJsonWithTimeout(url);
  const feed = parseWpCalendarToAirdropFeed(raw, nowMs);
  if (feed.tge.length === 0) {
    throw new Error('Empty AirdropAlert calendar payload');
  }
  return feed;
}

export async function fetchDropFeedPosts(src: SourceConfig, nowMs = Date.now()): Promise<ParsedFeedPost[]> {
  if (!src.url) throw new Error(`Missing URL for feed source ${src.handle}`);
  switch (src.parser) {
    case 'rss': {
      const { text: xml, url: finalUrl } = await fetchTextWithTimeout(src.url);
      return parseRssOrAtomXml(xml, finalUrl);
    }
    case 'wp_calendar': {
      const raw = await fetchJsonWithTimeout(src.url);
      return parseWpCalendarFeedPayload(raw);
    }
    case 'substack': {
      const raw = await fetchJsonWithTimeout(src.url);
      return parseSubstackArchive(raw);
    }
    case 'galxe': {
      const raw = (await fetchJsonWithTimeout(src.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: GALXE_TRENDING_QUERY }),
      })) as { errors?: unknown; data?: unknown } | null;
      if (!raw || (Array.isArray(raw.errors) && raw.errors.length > 0) || raw.data == null) {
        const firstErr =
          Array.isArray(raw?.errors) && raw.errors.length > 0
            ? typeof (raw.errors[0] as { message?: unknown })?.message === 'string'
              ? (raw.errors[0] as { message: string }).message
              : 'GraphQL error'
            : 'Missing data payload';
        throw new Error(`Galxe GraphQL error: ${firstErr}`);
      }
      return parseGalxeCampaigns(raw, nowMs);
    }
    default:
      throw new Error(`Unsupported drop feed parser "${String(src.parser)}" for ${src.handle}`);
  }
}

const FEED_TTL_MS = 30 * 60_000;
const TWENTY_FOUR_H_MS = 24 * 3_600_000;
const SIX_H_MS = 6 * 3_600_000;
const FOURTEEN_DAYS_MS = 14 * 86_400_000;
const MAX_POSTS_PER_POLL = 10;
const D1_EXISTING_CHECK_CHUNK = 50;

export function computeFeedBackoff(
  prevFailCount: number,
  prevFirstFailAt: number | null,
  nowMs: number,
): {
  failCount: number;
  firstFailAt: number;
  status: 'degraded' | 'down';
  nextPollAt: number;
} {
  const failCount = prevFailCount + 1;
  const firstFailAt = prevFirstFailAt ?? nowMs;
  if (nowMs - firstFailAt >= TWENTY_FOUR_H_MS) {
    return {
      failCount,
      firstFailAt,
      status: 'down',
      nextPollAt: nowMs + SIX_H_MS,
    };
  }
  const expMinutes = Math.min(120, 15 * 2 ** Math.min(4, failCount - 1));
  return {
    failCount,
    firstFailAt,
    status: 'degraded',
    nextPollAt: nowMs + expMinutes * 60_000,
  };
}

interface FeedSourceRow {
  id: string;
  handle: string;
  lang: string | null;
  trust: number;
  last_seen_id: string | null;
  fail_count: number;
  first_fail_at: number | null;
}

export interface FeedPollSummary {
  polled: number;
  insertedPosts: number;
  degraded: number;
  ingestedResults: IngestPostResult[];
}

async function pollSingleFeedSource(
  db: D1Database,
  src: FeedSourceRow,
  parseCtx: ParseContext,
  surfIndex: SurfIndex,
  projectDomains: Map<string, string>,
  platformDomains: Set<string> | undefined,
  nowMs: number,
  fetcher: (cfg: SourceConfig) => Promise<ParsedFeedPost[]>,
): Promise<{ insertedPosts: number; degraded: boolean; ingestedResults: IngestPostResult[] }> {
  const cutoffMs = nowMs - FOURTEEN_DAYS_MS;
  const cfg = getSeedSourceById(src.id) ?? {
    platform: 'feed' as const,
    handle: src.handle,
    lang: src.lang ?? 'en',
    trust: src.trust,
    tags: ['drops'],
    enabled: true,
  };

  try {
    const posts = await fetcher(cfg);
    // Track newest post id as last_seen_id (sorted newest-first)
    const sorted = [...posts].sort((a, b) => b.postedAt - a.postedAt || a.id.localeCompare(b.id));
    const newestId = sorted[0]?.id ?? src.last_seen_id;

    // Deduplicate within the current response by full post key before querying D1
    // and applying MAX_POSTS_PER_POLL, so duplicate items never consume cap slots.
    const seenResponseKeys = new Set<string>();
    const recentPosts: ParsedFeedPost[] = [];
    for (const p of sorted) {
      if (p.postedAt < cutoffMs) continue;
      const fullKey = `feed:${src.handle}:${p.id}`;
      if (seenResponseKeys.has(fullKey)) continue;
      seenResponseKeys.add(fullKey);
      recentPosts.push(p);
    }
    const lookupIdSet = new Set<string>();
    for (const p of recentPosts) {
      lookupIdSet.add(`feed:${src.handle}:${p.id}`);
      if (p.legacyId) {
        lookupIdSet.add(`feed:${src.handle}:${p.legacyId}`);
      }
    }
    const candidateLookupIds = [...lookupIdSet];
    const existingPostUrlById = new Map<string, string>();
    for (let i = 0; i < candidateLookupIds.length; i += D1_EXISTING_CHECK_CHUNK) {
      const chunk = candidateLookupIds.slice(i, i + D1_EXISTING_CHECK_CHUNK);
      const placeholders = chunk.map((_, idx) => `?${idx + 1}`).join(', ');
      const existingRes = await db
        .prepare(`SELECT id, post_url FROM posts WHERE id IN (${placeholders})`)
        .bind(...chunk)
        .all<{ id: string; post_url: string }>();
      for (const row of existingRes.results ?? []) {
        existingPostUrlById.set(row.id, row.post_url);
      }
    }

    const freshPosts = recentPosts.filter(p => {
      if (existingPostUrlById.has(`feed:${src.handle}:${p.id}`)) return false;
      if (p.legacyId && existingPostUrlById.get(`feed:${src.handle}:${p.legacyId}`) === p.postUrl) {
        return false;
      }
      return true;
    });

    const sourceParseCtx: ParseContext = {
      ...parseCtx,
      sourceLang: src.lang ?? undefined,
      surfByDomain: surfIndex.byDomain,
      surfByTicker: surfIndex.byTicker,
    };

    const relevantPosts = freshPosts
      .map(post => ({ post, parsed: parseDropPost(post.text, post.urls, sourceParseCtx) }))
      .filter(entry => entry.parsed.isRelevantDrop)
      .slice(0, MAX_POSTS_PER_POLL);

    const ingestedResults = await Promise.all(
      relevantPosts.map(({ post: p, parsed }) =>
        ingestPostIntoCluster(
          db,
          {
            postId: `feed:${src.handle}:${p.id}`,
            sourceId: src.id,
            sourceTrust: src.trust,
            postUrl: p.postUrl,
            postedAt: p.postedAt,
            text: p.text,
            htmlUrls: p.urls,
            sourceLang: src.lang ?? undefined,
          },
          sourceParseCtx,
          surfIndex,
          projectDomains,
          platformDomains,
          nowMs,
          parsed,
        ),
      ),
    );

    await db
      .prepare(
        `UPDATE sources
         SET last_seen_id = ?2, last_ok_at = ?3, last_polled_at = ?3,
             status = 'ok', fail_count = 0, first_fail_at = NULL, next_poll_at = ?4
         WHERE id = ?1`,
      )
      .bind(src.id, newestId, nowMs, nowMs + FEED_TTL_MS)
      .run();

    return { insertedPosts: ingestedResults.length, degraded: false, ingestedResults };
  } catch (err) {
    console.error(`feed-poll-error:${src.id}`, err);
    const backoff = computeFeedBackoff(src.fail_count ?? 0, src.first_fail_at ?? null, nowMs);
    await db
      .prepare(
        `UPDATE sources
         SET last_polled_at = ?2, fail_count = ?3, first_fail_at = ?4, status = ?5, next_poll_at = ?6
         WHERE id = ?1`,
      )
      .bind(src.id, nowMs, backoff.failCount, backoff.firstFailAt, backoff.status, backoff.nextPollAt)
      .run();
    return { insertedPosts: 0, degraded: true, ingestedResults: [] };
  }
}

export async function pollFeedBatch(
  db: D1Database,
  batchSize = 3,
  nowMs = Date.now(),
  surfFeed?: AirdropFeed | null,
  fetcher: (cfg: SourceConfig) => Promise<ParsedFeedPost[]> = cfg => fetchDropFeedPosts(cfg, nowMs),
): Promise<FeedPollSummary> {
  // Uses sources_poll(platform, enabled, last_polled_at ASC) without TEMP B-TREE.
  const res = await db
    .prepare(
      `SELECT id, handle, lang, trust, last_seen_id, fail_count, first_fail_at
       FROM sources
       WHERE platform = 'feed' AND enabled = 1 AND tags LIKE '%"drops"%' AND (next_poll_at IS NULL OR next_poll_at <= ?1)
       ORDER BY last_polled_at ASC NULLS FIRST
       LIMIT ?2`,
    )
    .bind(nowMs, batchSize)
    .all<FeedSourceRow>();

  const sources = res.results ?? [];
  if (sources.length === 0) {
    return { polled: 0, insertedPosts: 0, degraded: 0, ingestedResults: [] };
  }

  let projectDomains: Map<string, string>;
  let platformDomains: Set<string> | undefined;
  try {
    ({ projectDomains, platformDomains } = await loadKnownDomains(db, nowMs));
  } catch (err) {
    console.error('feed-poll-error:loadKnownDomains', err);
    await Promise.all(
      sources.map(src =>
        db
          .prepare(`UPDATE sources SET last_polled_at = ?2, status = 'degraded' WHERE id = ?1`)
          .bind(src.id, nowMs)
          .run(),
      ),
    );
    return { polled: sources.length, insertedPosts: 0, degraded: sources.length, ingestedResults: [] };
  }

  const surfIndex = buildSurfIndex(surfFeed);
  const parseCtx: ParseContext = { knownDomains: projectDomains };

  const outcomes = await Promise.all(
    sources.map(async src => {
      try {
        return await pollSingleFeedSource(db, src, parseCtx, surfIndex, projectDomains, platformDomains, nowMs, fetcher);
      } catch (err) {
        console.error(`feed-poll-error:${src.id}`, err);
        return { insertedPosts: 0, degraded: true, ingestedResults: [] };
      }
    }),
  );

  let insertedPosts = 0;
  let degraded = 0;
  const ingestedResults: IngestPostResult[] = [];
  for (const o of outcomes) {
    insertedPosts += o.insertedPosts;
    if (o.degraded) degraded++;
    ingestedResults.push(...o.ingestedResults);
  }

  return { polled: sources.length, insertedPosts, degraded, ingestedResults };
}
