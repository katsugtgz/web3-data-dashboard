import { URL_SHORTENERS } from '../safety/shorteners';

/** Social / messaging platforms — never a project's canonical domain. */
export const SOCIAL_PLATFORM_DOMAINS = new Set<string>([
  't.me',
  'telegram.me',
  'x.com',
  'twitter.com',
  'youtube.com',
  'youtu.be',
  'discord.gg',
  'discord.com',
  'instagram.com',
  'tiktok.com',
  'reddit.com',
  'facebook.com',
  'linkedin.com',
  'twitch.tv',
  'farcaster.xyz',
  'warpcast.com',
  'bsky.app',
]);

/** General hosting, forms, link-in-bio, event, and mobile deep-link wrappers. */
export const CONTENT_HOST_DOMAINS = new Set<string>([
  'medium.com',
  'substack.com',
  'mirror.xyz',
  'paragraph.xyz',
  'notion.site',
  'notion.so',
  'docs.google.com',
  'drive.google.com',
  'google.com',
  'forms.gle',
  'typeform.com',
  'tally.so',
  'airtable.com',
  'linktr.ee',
  'bio.link',
  'beacons.ai',
  'github.com',
  'gitlab.com',
  'gitbook.io',
  'hackmd.io',
  'arxiv.org',
  'play.google.com',
  'apps.apple.com',
  'apple.com',
  'onelink.me',
  'luma.com',
  'lu.ma',
  'tokopedia.com',
  'bitget.cloud',
  'thedefinvestor.com',
  // Shared PaaS / static hosting domains (never a project's trusted registrable domain)
  'vercel.app',
  'netlify.app',
  'github.io',
  'pages.dev',
  'workers.dev',
  'web.app',
  'firebaseapp.com',
  'onrender.com',
  'fly.dev',
  'railway.app',
  'herokuapp.com',
]);

/** Quest / bounty / allowlist / claim platforms shared across many projects. */
export const QUEST_AGGREGATOR_DOMAINS = new Set<string>([
  'galxe.com',
  'app.galxe.com',
  'zealy.io',
  'layer3.xyz',
  'intract.io',
  'questn.com',
  'guild.xyz',
  'taskon.xyz',
  'soquest.xyz',
  'tideprotocol.xyz',
  'debank.com',
  'superboard.xyz',
  'alphabot.app',
  'premint.xyz',
  'heymint.xyz',
  'tokenops.xyz',
  'moongate.com',
]);

/** News outlets, wire services, newsletters, and regulatory portals. */
export const NEWS_MEDIA_DOMAINS = new Set<string>([
  'coindesk.com',
  'cointelegraph.com',
  'ct.com',
  'theblock.co',
  'decrypt.co',
  'dlnews.com',
  'blockworks.co',
  'chaincatcher.com',
  'watcherguru.com',
  'fortune.com',
  'bloomberg.com',
  'reuters.com',
  'ft.com',
  'wsj.com',
  'cnbc.com',
  'techcrunch.com',
  'theverge.com',
  'wired.com',
  'forbes.com',
  'businessinsider.com',
  'nytimes.com',
  'bbc.com',
  'bbc.co.uk',
  'cnn.com',
  'axios.com',
  'naver.com',
  'heraldcorp.com',
  'panewslab.com',
  'odaily.news',
  'wu-blockchain.com',
  'wublockchain.com',
  'coingape.com',
  'beincrypto.com',
  'cryptoslate.com',
  'bitcoinmagazine.com',
  'thedefiant.io',
  'unchainedcrypto.com',
  'protos.com',
  'cryptobriefing.com',
  'u.today',
  'ambcrypto.com',
  'newsbtc.com',
  'dailyhodl.com',
  'finbold.com',
  'benzinga.com',
  'marketwatch.com',
  'nasdaq.com',
  'yahoo.com',
  'globenewswire.com',
  'sec.gov',
  'cftc.gov',
  'gov.uk',
  'europa.eu',
  'chungdailynote.com',
  'ranked.plus',
]);

/** Shared NFT marketplaces, launchpads, price trackers, and block explorers. */
export const TRACKER_MARKETPLACE_DOMAINS = new Set<string>([
  'opensea.io',
  'magiceden.io',
  'magiceden.us',
  'blur.io',
  'tensor.trade',
  'rarible.com',
  'foundation.app',
  'zora.co',
  'satsea.xyz',
  'pump.fun',
  'dropstab.com',
  'cryptorank.io',
  'airdroptracker.io',
  'airdrops.io',
  'airdropalert.com',
  'coinmarketcap.com',
  'coingecko.com',
  'defillama.com',
  'dexscreener.com',
  'dextools.io',
  'dune.com',
  'arkhamintelligence.com',
  'nansen.ai',
  'whale-alert.io',
  'etherscan.io',
  'basescan.org',
  'arbiscan.io',
  'polygonscan.com',
  'bscscan.com',
  'solscan.io',
  'suiscan.xyz',
  'tonviewer.com',
  'snowtrace.io',
  'glassnode.com',
  'messari.io',
  'tokenterminal.com',
  // Major centralized exchanges
  'binance.com',
  'coinbase.com',
  'bybit.com',
  'okx.com',
  'kucoin.com',
  'bitget.com',
  'gate.io',
  'kraken.com',
  'mexc.com',
  'htx.com',
  'upbit.com',
  'bingx.com',
]);

/**
 * Union of every shared non-project host. Exported as PLATFORM_DOMAINS for
 * backward compatibility across parse, safety, and snapshot callers.
 */
export const PLATFORM_DOMAINS = new Set<string>([
  ...SOCIAL_PLATFORM_DOMAINS,
  ...CONTENT_HOST_DOMAINS,
  ...QUEST_AGGREGATOR_DOMAINS,
  ...NEWS_MEDIA_DOMAINS,
  ...TRACKER_MARKETPLACE_DOMAINS,
]);

/**
 * Curated aggregator hosts that serve third-party protocol campaigns (e.g.
 * Pendle Points markets, Merkl incentives). Kept OUT of PLATFORM_DOMAINS so
 * Pendle/Merkl themselves remain real protocols while third-party campaign
 * cards sourced from them don't collapse into one project or hijack domains.
 */
export const CURATED_AGGREGATOR_DOMAINS = new Set<string>([
  'pendle.finance',
  'merkl.xyz',
]);

const CURATED_AGGREGATOR_SELF_NAMES: Record<string, ReadonlySet<string>> = {
  'pendle.finance': new Set(['pendle', 'pendlefinance']),
  'merkl.xyz': new Set(['merkl', 'merklxyz']),
};

/** Hosts that enforce HTTPS globally (upgrading Telegram's http:// auto-links is safe). */
export const ALWAYS_HTTPS_DOMAINS = PLATFORM_DOMAINS;

/** Well-known public DNS resolver IPs that Telegram auto-links in setup guides (silently stripped). */
export const BENIGN_DNS_IPS = new Set<string>([
  '1.1.1.1',
  '1.0.0.1',
  '8.8.8.8',
  '8.8.4.4',
  '9.9.9.9',
]);

/** App-wrapper domains whose first subdomain label identifies the project (e.g. topnod.onelink.me). */
const SUBDOMAIN_PROJECT_WRAPPERS = new Set<string>(['onelink.me', 'gitbook.io']);

// Curated slice of the Public Suffix List covering multipart ccTLDs seen in feed URLs.
const MULTI_PART_TLDS = new Set([
  'co.uk',
  'org.uk',
  'gov.uk',
  'ac.uk',
  'com.au',
  'co.id',
  'com.br',
  'co.jp',
  'com.sg',
  'com.tr',
  'co.kr',
  'com.cn',
  'com.hk',
  'co.in',
  'com.mx',
  'co.nz',
  'com.ar',
  'co.za',
]);

const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const RAW_EMOJI_RE = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u;
// Percent-encoded UTF-8 sequences for 4-byte emoji (%F0%9F...) and common
// 3-byte symbol/dingbat/arrow emoji (%E2%9[0-9A-F]..., %E2%AC..., %EF%B8...).
const ENCODED_EMOJI_START_RE = /%(?:F0%9[0-9A-F]%[0-9A-F]{2}%[0-9A-F]{2}|E2%(?:8F|9[0-9A-F]|AC|AD)%[0-9A-F]{2}|EF%B8%[0-9A-F]{2})/i;
const ELLIPSIS_RE = /\u2026|%E2%80%A6/i;

// Bare domain with path or query string (e.g. `jrny.club/token-hub/claim`, `getclocked.com/?ref=HQAKP9`).
// Requires a known TLD plus a non-empty path/query so filenames like `config.json` or `index.html` never match.
const BARE_DOMAIN_PATH_RE =
  /(?<![:/@.\w-])(?:www\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.(?:com|io|xyz|fun|app|gg|ai|org|net|co|me|site|wtf|voyage|cc|one|pro|network|finance|exchange|market|markets|systems|bot|live|club|fi|sh|so|to|id|dev|tech|world|games|game|quest|money|trade|art|digital|cloud|run|zone|space|land|link|click|page|win|top|bet|tv|fm|vc|is|ch|de|uk|fr|jp|kr|sg|au|ca|in|us|eu|info|biz|news|media|studio|labs|foundation|protocol|capital|ventures|dao|nft|crypto|eth)(?:\/[^\s<>"'`\]).,;!?][^\s<>"'`\]]*|\/?\?[^\s<>"'`\]).,;!?][^\s<>"'`\]]*)/gi;

const ACTIONABLE_PATH_RANK_RE =
  /\/(?:claim|mint|waitlist|whitelist|faucet|quest|quests|apply|campaign|checker|rewards|early-access)/;

const GLOBAL_STRIP_PARAMS_RE =
  /^(?:utm_.*|fbclid|gclid|igshid|si|mc_cid|mc_eid|ref|ref_.*|referral|referralcode|referral_code|refcode|ref_code|referrer|invite|invitecode|invite_code|inviter|aff_id|affiliate|via)$/i;
const X_SHARE_PARAMS_RE = /^(?:s|t|a|mx)$/i;
const REFERRAL_SHORT_CODE_RE = /^[A-Za-z0-9_-]{4,24}$/;
const REFERRAL_CODE_PATH_RE = /^\/(?:r|ref|invite)\/([A-Za-z0-9_-]{3,24})\/?$/i;
const JOIN_PATH_RE = /^\/join\/([A-Za-z0-9_-]{3,24})\/?$/i;
const CLEAN_SUBPATH_WORDS = new Set([
  'creator',
  'creators',
  'waitlist',
  'whitelist',
  'rewards',
  'beta',
  'early-access',
  'quest',
  'airdrop',
]);

type ReferralPathKind = 'root' | 'join' | 'invite';

function referralPathKind(pathname: string): ReferralPathKind | null {
  const refMatch = pathname.match(REFERRAL_CODE_PATH_RE);
  if (refMatch) {
    if (CLEAN_SUBPATH_WORDS.has(refMatch[1].toLowerCase())) return null;
    return /^\/invite\//i.test(pathname) ? 'invite' : 'root';
  }
  const joinMatch = pathname.match(JOIN_PATH_RE);
  if (!joinMatch) return null;
  const seg = joinMatch[1];
  const isCode = /\d/.test(seg) || seg.length <= 3 || (/[A-Z]/.test(seg) && /[a-z]/.test(seg));
  return isCode ? 'join' : null;
}

function cleanEquivalentPath(kind: ReferralPathKind): string {
  if (kind === 'join') return '/join';
  if (kind === 'invite') return '/invite';
  return '/';
}

function normalizePathname(pathname: string): string {
  return pathname.replace(/\/+/g, '/').replace(/\/$/, '').toLowerCase() || '/';
}

function matchesDomainSet(domain: string, set: ReadonlySet<string>): boolean {
  let d = domain.toLowerCase();
  if (set.has(d)) return true;
  let dot = d.indexOf('.');
  while (dot !== -1) {
    d = d.slice(dot + 1);
    if (set.has(d)) return true;
    dot = d.indexOf('.');
  }
  return false;
}

export function isRawIpHost(host: string): boolean {
  const clean = host.trim().toLowerCase();
  if (!clean) return false;
  const c0 = clean.charCodeAt(0);
  if (c0 === 91) return clean.endsWith(']');
  if (c0 >= 48 && c0 <= 57) return IPV4_RE.test(clean);
  return false;
}

function registrableFromHost(hostRaw: string): string | undefined {
  if (!hostRaw) return undefined;
  let host = hostRaw.toLowerCase();
  if (host.startsWith('www.')) host = host.slice(4);
  const lastDot = host.lastIndexOf('.');
  if (lastDot <= 0) return undefined;
  const c0 = host.charCodeAt(0);
  if (c0 === 91 && host.endsWith(']')) return host;
  if (c0 >= 48 && c0 <= 57 && IPV4_RE.test(host)) return host;
  const prevDot = host.lastIndexOf('.', lastDot - 1);
  if (prevDot === -1) return host;
  const lastTwo = host.slice(prevDot + 1);
  if (MULTI_PART_TLDS.has(lastTwo)) {
    const thirdDot = host.lastIndexOf('.', prevDot - 1);
    return thirdDot === -1 ? host : host.slice(thirdDot + 1);
  }
  return lastTwo;
}

export function getRegistrableDomain(rawUrl: string): string | undefined {
  // Fast path for standard ASCII http(s)://host[/|?|#] URLs (skips new URL() overhead).
  let start = -1;
  if (rawUrl.startsWith('https://') || rawUrl.startsWith('HTTPS://')) start = 8;
  else if (rawUrl.startsWith('http://') || rawUrl.startsWith('HTTP://')) start = 7;

  if (start !== -1) {
    const len = rawUrl.length;
    let end = start;
    let valid = true;
    let hasDot = false;
    let prevDot = true;
    let lastDotIdx = -1;
    while (end < len) {
      const cc = rawUrl.charCodeAt(end);
      if (cc === 47 || cc === 63 || cc === 35) break; // '/', '?', '#'
      if (cc === 46) {
        if (prevDot) {
          valid = false;
          break;
        }
        hasDot = true;
        prevDot = true;
        lastDotIdx = end;
      } else if (
        (cc >= 97 && cc <= 122) || // a-z
        (cc >= 65 && cc <= 90) || // A-Z
        (cc >= 48 && cc <= 57) || // 0-9
        cc === 45 // '-'
      ) {
        prevDot = false;
      } else {
        // ':', '@', non-ASCII, whitespace, etc. -> fall back to WHATWG new URL()
        valid = false;
        break;
      }
      end++;
    }
    if (valid && hasDot && !prevDot && lastDotIdx + 1 < end) {
      const tldFirst = rawUrl.charCodeAt(lastDotIdx + 1);
      const isAlphaTld = (tldFirst >= 97 && tldFirst <= 122) || (tldFirst >= 65 && tldFirst <= 90);
      if (isAlphaTld) {
        const host = rawUrl.slice(start, end);
        if (!host.includes('xn--') && !host.includes('XN--')) {
          return registrableFromHost(host);
        }
      }
    }
  }

  try {
    return registrableFromHost(new URL(rawUrl).hostname);
  } catch {
    return undefined;
  }
}

export function isPlatformDomain(domain: string): boolean {
  return matchesDomainSet(domain, PLATFORM_DOMAINS);
}

export function isNewsDomain(domain: string): boolean {
  return matchesDomainSet(domain, NEWS_MEDIA_DOMAINS);
}

export function isQuestDomain(domain: string): boolean {
  return matchesDomainSet(domain, QUEST_AGGREGATOR_DOMAINS);
}

export function isSocialDomain(domain: string): boolean {
  return matchesDomainSet(domain, SOCIAL_PLATFORM_DOMAINS);
}

export function isTrackerOrMarketplaceDomain(domain: string): boolean {
  return matchesDomainSet(domain, TRACKER_MARKETPLACE_DOMAINS);
}

export function isAlwaysHttpsDomain(domain?: string): boolean {
  if (!domain) return false;
  return matchesDomainSet(domain, ALWAYS_HTTPS_DOMAINS);
}

/**
 * Returns true when `domain` is a shared curated-aggregator host (`pendle.finance`
 * or `merkl.xyz`) on any card whose project name is NOT that aggregator itself.
 * Applies regardless of `card.source` so merged Surf/sheet cards inheriting
 * Pendle/Merkl task URLs can never poison `known_domains` or `surfIndex`.
 */
export function isCuratedAggregatorDomain(
  domain: string,
  card: { n: string; source?: string },
): boolean {
  const reg = registrableFromHost(domain.trim().replace(/\.+$/, ''));
  if (!reg || !CURATED_AGGREGATOR_DOMAINS.has(reg)) return false;
  const normName = card.n.toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (CURATED_AGGREGATOR_SELF_NAMES[reg]?.has(normName)) return false;
  return true;
}

/**
 * Extracts a project hint from branded subdomains on deep-link wrappers
 * (e.g. `https://topnod.onelink.me/orvm/events` -> `"topnod"`).
 */
export function extractWrapperSubdomainHint(rawUrl: string): string | undefined {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, '');
    const reg = registrableFromHost(host);
    if (!reg || !SUBDOMAIN_PROJECT_WRAPPERS.has(reg)) return undefined;
    const prefix = host.slice(0, host.length - reg.length - 1);
    if (!prefix || prefix.includes('.')) return undefined;
    if (/^(?:app|go|www|link|links|docs|m|web)$/.test(prefix)) return undefined;
    return prefix;
  } catch {
    return undefined;
  }
}

/**
 * Detects Telegram's server-side bare-domain auto-link behavior:
 * `<a href="http://rgbstone.com/">rgbstone.com</a>` or
 * `<a href="http://getclocked.com/?ref=HQAKP9">getclocked.com/?ref=HQAKP9</a>`.
 * Returns false if the author explicitly wrote `http://` in the anchor text
 * or used unrelated display text (`Claim now`) for an unknown plain-HTTP host.
 */
export function isBareDomainAutoLink(href: string, anchorText: string): boolean {
  if (!/^http:\/\//i.test(href)) return false;
  const text = anchorText.trim();
  if (!text) return false;
  if (/^http:\/\//i.test(text)) return false;

  const hrefNoScheme = href.replace(/^http:\/\//i, '').replace(/\/+$/, '').toLowerCase();
  const textClean = text
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
    .replace(/\u2026$/, '')
    .toLowerCase();
  if (textClean.length < 4 || !textClean.includes('.')) return false;

  const hrefNoWww = hrefNoScheme.replace(/^www\./, '');
  const textNoWww = textClean.replace(/^www\./, '');
  if (hrefNoScheme === textClean || hrefNoWww === textNoWww) return true;
  if (text.endsWith('\u2026') && (hrefNoScheme.startsWith(textClean) || hrefNoWww.startsWith(textNoWww))) {
    return true;
  }
  return false;
}

function decodeAmpEntities(input: string): string {
  let out = input;
  for (let i = 0; i < 2; i++) {
    const next = out.replace(/&amp;/gi, '&');
    if (next === out) break;
    out = next;
  }
  return out;
}

const NON_ASCII_URL_RE = /[^\u0000-\u007f]/;

function stripTrailingUrlNoise(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  let cleaned = trimmed.includes('&') ? decodeAmpEntities(trimmed) : trimmed;

  // Strip raw trailing emoji and anything glued after an emoji BEFORE new URL(),
  // otherwise URL serialization percent-encodes raw emoji (`s=19🏂` -> `s=19%F0%9F%8F%82`).
  const hasNonAscii = NON_ASCII_URL_RE.test(cleaned);
  if (hasNonAscii) {
    const emojiMatch = cleaned.match(RAW_EMOJI_RE);
    if (emojiMatch && emojiMatch.index !== undefined) {
      cleaned = cleaned.slice(0, emojiMatch.index);
    }
  }
  if (cleaned.includes('%')) {
    const encodedEmojiMatch = cleaned.match(ENCODED_EMOJI_START_RE);
    if (encodedEmojiMatch && encodedEmojiMatch.index !== undefined) {
      cleaned = cleaned.slice(0, encodedEmojiMatch.index);
    }
  }
  if (!cleaned) return '';

  if (hasNonAscii) {
    cleaned = cleaned.replace(/[\uFE0E\uFE0F\u200B-\u200F]+$/g, '');
    if (!cleaned) return '';
  }
  const lastCode = cleaned.charCodeAt(cleaned.length - 1);
  // Only run trailing punctuation strip when last char isn't alphanumeric or '/'.
  if (
    !(
      (lastCode >= 97 && lastCode <= 122) ||
      (lastCode >= 65 && lastCode <= 90) ||
      (lastCode >= 48 && lastCode <= 57) ||
      lastCode === 47
    )
  ) {
    cleaned = cleaned.replace(/[),.;!?\]"'»]+$/, '');
  }
  return cleaned;
}

interface CleanedUrlParts {
  url: URL;
  href: string;
  host: string;
  reg: string;
  pathname: string;
  key: string;
}

/**
 * Fast path for already-clean lowercase `https://host[/safe-path]` URLs with no
 * query/hash/percent/entity/dot-segment/trailing-noise, avoiding WHATWG `new URL()`.
 */
function tryFastCleanHttpsUrl(cleaned: string): string | null {
  if (!cleaned.startsWith('https://')) return null;
  const len = cleaned.length;
  let hostEnd = 8;
  let hasDot = false;
  let prevDot = true;
  let lastDotIdx = -1;
  while (hostEnd < len) {
    const cc = cleaned.charCodeAt(hostEnd);
    if (cc === 47) break; // '/'
    if (cc === 46) {
      if (prevDot) return null;
      hasDot = true;
      prevDot = true;
      lastDotIdx = hostEnd;
    } else if (
      (cc >= 97 && cc <= 122) || // lowercase a-z only (uppercase falls back for host lowercasing)
      (cc >= 48 && cc <= 57) ||
      cc === 45
    ) {
      prevDot = false;
    } else {
      return null;
    }
    hostEnd++;
  }
  if (!hasDot || prevDot || lastDotIdx + 1 >= hostEnd) return null;
  const tldFirst = cleaned.charCodeAt(lastDotIdx + 1);
  if (tldFirst < 97 || tldFirst > 122) return null;
  if (cleaned.indexOf('xn--', 8) !== -1 && cleaned.indexOf('xn--', 8) < hostEnd) return null;

  if (hostEnd === len) {
    return `${cleaned}/`;
  }

  let lastSlash = hostEnd;
  for (let i = hostEnd + 1; i < len; i++) {
    const cc = cleaned.charCodeAt(i);
    if (cc === 47) {
      lastSlash = i;
    } else if (
      !(
        (cc >= 97 && cc <= 122) ||
        (cc >= 65 && cc <= 90) ||
        (cc >= 48 && cc <= 57) ||
        cc === 45 || // '-'
        cc === 95 || // '_'
        cc === 126 // '~'
      )
    ) {
      return null;
    }
  }

  // Defer long digit-prefixed trailing segments to full idGlue logic.
  const segLen = len - lastSlash - 1;
  if (segLen >= 9) {
    const segFirst = cleaned.charCodeAt(lastSlash + 1);
    if (segFirst >= 48 && segFirst <= 57) return null;
  }

  const pathLen = len - hostEnd;
  if (pathLen > 1 && cleaned.charCodeAt(len - 1) === 47) {
    let end = len - 1;
    while (end > hostEnd + 1 && cleaned.charCodeAt(end - 1) === 47) end--;
    return cleaned.slice(0, end);
  }
  return cleaned;
}

const TRAILING_ENCODED_PUNCT_RE = /(?:%(?:2C|2E|29|3B|3A|21|3F|22|27))+$/i;

function cleanUrlParts(raw: string): CleanedUrlParts | null {
  try {
    let cleaned = raw.trim();
    if (!cleaned) return null;
    if (cleaned.includes('&') && /&amp;/i.test(cleaned)) {
      cleaned = decodeAmpEntities(cleaned);
    }

    // Truncated Telegram preview URLs (`https://x.com/T%E2%80%A6lumayan`,
    // `https://discord.gg/acepyr...Musang:`) are broken links — reject them.
    if ((cleaned.includes('\u2026') || cleaned.includes('%')) && ELLIPSIS_RE.test(cleaned)) return null;

    cleaned = stripTrailingUrlNoise(cleaned);
    if (!cleaned) return null;

    // Strip only trailing percent-encoded punctuation, preserving valid %25, %20, %3D.
    if (cleaned.includes('%')) {
      cleaned = cleaned.replace(TRAILING_ENCODED_PUNCT_RE, '');
    }

    const u = new URL(cleaned);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.username || u.password) return null;

    // Trim glued prose after long numeric ID path segments (`.../status/<id>Update`),
    // operating strictly on pathname while skipping pure hex slugs and YYYYMMDD date slugs.
    const lastSlash = u.pathname.lastIndexOf('/');
    const lastSeg = lastSlash === -1 ? u.pathname : u.pathname.slice(lastSlash + 1);
    const isHexSlug = lastSeg.length >= 8 && /^[0-9a-f]+$/.test(lastSeg);
    const isDateSlug = /^20\d{6}[a-z]/.test(lastSeg);
    if (!isHexSlug && !isDateSlug) {
      const idGlue = lastSeg.match(/^(\d{8,})([A-Za-z][A-Za-z0-9]*)$/);
      if (idGlue) {
        u.pathname = u.pathname.slice(0, lastSlash + 1) + idGlue[1];
      }
    }

    const hostLower = u.hostname.toLowerCase();
    if (!hostLower || !hostLower.includes('.') || isRawIpHost(hostLower)) return null;

    const host = hostLower.startsWith('www.') ? hostLower.slice(4) : hostLower;
    const reg = registrableFromHost(host) ?? '';
    if (u.protocol === 'http:' && isAlwaysHttpsDomain(reg)) {
      u.protocol = 'https:';
    }

    if (u.search.length > 1) {
      const isX = reg === 'x.com' || reg === 'twitter.com';
      const isSubstack = reg === 'substack.com';
      const isTelegram = reg === 't.me' || reg === 'telegram.me';
      const isRoot = u.pathname === '/' || u.pathname === '';

      for (const key of [...u.searchParams.keys()]) {
        if (GLOBAL_STRIP_PARAMS_RE.test(key)) {
          u.searchParams.delete(key);
          continue;
        }
        if (isX && X_SHARE_PARAMS_RE.test(key)) {
          u.searchParams.delete(key);
          continue;
        }
        if (isSubstack && /^r$/i.test(key)) {
          u.searchParams.delete(key);
          continue;
        }
        if (isTelegram && /^boost$/i.test(key)) {
          u.searchParams.delete(key);
          continue;
        }
        // Root-path single-letter referral codes (e.g. `penguclash.io/?p=ggsk2i02`, `site.xyz/?r=abc123`).
        if (isRoot && /^(?:p|r)$/i.test(key)) {
          const val = u.searchParams.get(key) ?? '';
          if (REFERRAL_SHORT_CODE_RE.test(val)) {
            u.searchParams.delete(key);
          }
        }
      }
    }

    // Normalize non-root trailing slash so `/socialcamp/` and `/socialcamp` dedupe.
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.replace(/\/+$/, '');
    }
    if (u.hash === '#') {
      u.hash = '';
    }

    const href = u.toString();
    const pathname = u.pathname;
    const normPath = pathname.length > 1 ? pathname : '/';
    const search = u.search.length > 1 ? u.searchParams.toString() : '';
    const key = `${host}${normPath}${search ? `?${search}` : ''}${u.hash}`;
    return { url: u, href, host, reg, pathname, key };
  } catch {
    return null;
  }
}

export function cleanUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const fast = tryFastCleanHttpsUrl(trimmed);
  if (fast !== null) return fast;
  return cleanUrlParts(trimmed)?.href ?? null;
}

/**
 * Canonical deduplication key ignoring protocol (`http`/`https`), `www.` prefix,
 * and trailing slash differences.
 */
export function canonicalLinkKey(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, '') : '/';
    const search = u.searchParams.toString();
    return `${host}${path}${search ? `?${search}` : ''}${u.hash}`;
  } catch {
    return rawUrl.toLowerCase();
  }
}

/**
 * Extracts scheme-less bare domains with paths or query strings from text
 * (e.g. `jrny.club/token-hub/claim` -> `https://jrny.club/token-hub/claim`)
 * while skipping existing full URLs, ellipsis fragments, and filenames.
 */
export function extractBareDomainUrls(text: string): string[] {
  const withoutFullUrls = text.replace(/https?:\/\/[^\s<>"'`]+/gi, ' ');
  const matches = withoutFullUrls.match(BARE_DOMAIN_PATH_RE) ?? [];
  const out: string[] = [];
  for (const raw of matches) {
    if (raw.includes('...') || ELLIPSIS_RE.test(raw)) continue;
    const normalized = cleanUrl(`https://${raw}`);
    if (normalized) out.push(normalized);
  }
  return out;
}

/**
 * Extracts explicit raw-IP URLs (`http(s)://<ip>...`) excluding benign public
 * DNS resolver IPs (`1.1.1.1`, `8.8.8.8`, etc.). `cleanUrl` intentionally
 * rejects raw IPs so they never appear in displayed feed links, while this
 * helper preserves them for `evaluateSafety` risk flagging.
 */
export function extractSuspiciousRawIpUrls(text: string, htmlUrls: string[] = []): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const textMatches = text.match(/https?:\/\/[^\s<>"'`]+/gi) ?? [];

  for (const raw of [...htmlUrls, ...textMatches]) {
    const cleaned = stripTrailingUrlNoise(raw);
    if (!cleaned) continue;
    try {
      const u = new URL(cleaned);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
      const host = u.hostname.toLowerCase();
      if (!isRawIpHost(host) || BENIGN_DNS_IPS.has(host)) continue;
      const serialized = u.toString();
      if (seen.has(serialized)) continue;
      seen.add(serialized);
      out.push(serialized);
    } catch {
      // Ignore malformed URL
    }
  }

  return out;
}

export function extractUrls(text: string, htmlUrls: string[] = []): string[] {
  const byKey = new Map<string, string>();
  const bareMatches = text.match(/https?:\/\/[^\s<>"'`]+/gi) ?? [];
  const bareDomainMatches = extractBareDomainUrls(text);

  for (const raw of [...htmlUrls, ...bareMatches, ...bareDomainMatches]) {
    const normalized = cleanUrl(raw);
    if (!normalized) continue;
    const key = canonicalLinkKey(normalized);
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, normalized);
      continue;
    }
    // Prefer https over http, and non-www over www when collapsing twins.
    const prevHttps = prev.startsWith('https://');
    const nextHttps = normalized.startsWith('https://');
    if (nextHttps && !prevHttps) {
      byKey.set(key, normalized);
    } else if (nextHttps === prevHttps && prev.includes('://www.') && !normalized.includes('://www.')) {
      byKey.set(key, normalized);
    }
  }
  return [...byKey.values()];
}

function isNoisyLinkParsed(
  u: URL,
  host: string,
  reg: string,
  sourceHandles?: ReadonlySet<string>,
): boolean {
  const pathLower = u.pathname.toLowerCase();

  // Telegram boost, private chat, addlist, and channel self-promo links.
  if (reg === 't.me' || reg === 'telegram.me') {
    if (u.searchParams.has('boost')) return true;
    const segs = u.pathname.split('/').filter(Boolean);
    if (segs.length === 0) return true;
    const first = segs[0].toLowerCase();
    if (first === 'c' || first === 'addlist' || first === 'share') return true;
    if (sourceHandles && sourceHandles.has(first)) return true;
    // Channel chat companion links (e.g. atoms_chat when source is atoms_research).
    if (sourceHandles) {
      for (const h of sourceHandles) {
        const stem = h.split('_')[0];
        if (stem && stem.length >= 4 && first.startsWith(`${stem}_`)) return true;
      }
    }
    // Keep Telegram bot links (`*_bot`) when relevant; treat channel posts as noisy.
    if (!first.endsWith('bot')) return true;
  }

  // Linktree/YouTube self-promo for a source channel.
  if ((reg === 'linktr.ee' || reg === 'youtube.com') && sourceHandles) {
    const seg = u.pathname.split('/').filter(Boolean)[0]?.replace(/^@/, '').toLowerCase() ?? '';
    if (seg && sourceHandles.has(seg)) return true;
  }
  if (reg === 'linktr.ee') return true;

  // X cashtag search pages (`https://x.com/search?q=$ZXO`).
  if ((reg === 'x.com' || reg === 'twitter.com') && pathLower.startsWith('/search')) return true;

  // Cointelegraph footer nav links (`ct.com/category/markets`, `ct.com/`).
  if (host === 'ct.com' && (pathLower === '/' || pathLower.startsWith('/category'))) return true;

  return false;
}

export function isNoisyLink(rawUrl: string, sourceHandles?: ReadonlySet<string>): boolean {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const reg = registrableFromHost(host) ?? '';
    return isNoisyLinkParsed(u, host, reg, sourceHandles);
  } catch {
    return true;
  }
}

export interface SelectFeedLinksOptions {
  projectDomain?: string;
  sourceHandles?: ReadonlySet<string>;
  allKnownDomains?: ReadonlySet<string>;
  maxLinks?: number;
}

const MAX_CANONICAL_CANDIDATES = 40;

interface RankedCandidate {
  parts: CleanedUrlParts;
  rank: number;
  refKind: ReferralPathKind | null;
  hostKey: string;
  limitForHost: number;
}

function computeLinkRank(
  parts: CleanedUrlParts,
  projDom: string | undefined,
  allKnownDomains?: ReadonlySet<string>,
): number {
  const { href: url, reg, pathname } = parts;
  const known = Boolean(reg && allKnownDomains?.has(reg));
  let rank = 0;
  if (projDom && reg === projDom) rank += 100;
  else if (reg && !isPlatformDomain(reg) && !URL_SHORTENERS[reg]) rank += 80;
  else if (reg && isQuestDomain(reg)) rank += 50;
  else if (reg === 'x.com' || reg === 'twitter.com') rank += 25;
  else if (reg && URL_SHORTENERS[reg]) rank += 5;
  else rank += 15;

  if (known) rank += 10;
  if (url.startsWith('https://')) rank += 4;
  if (ACTIONABLE_PATH_RANK_RE.test(pathname.toLowerCase())) {
    rank += 6;
  }
  return rank;
}

function effectiveRank(c: Pick<RankedCandidate, 'rank' | 'refKind'>): number {
  return c.rank - (c.refKind ? 1 : 0);
}

function findWorstCandidate(
  deduped: Map<string, RankedCandidate>,
  hostBucketCounts: Map<string, number>,
): { key: string; entry: RankedCandidate; isOver: boolean } | null {
  let worstKey = '';
  let worstEntry: RankedCandidate | null = null;
  let worstOver = false;

  for (const [key, entry] of deduped) {
    const isOver = (hostBucketCounts.get(entry.hostKey) ?? 0) > entry.limitForHost;
    if (!worstEntry) {
      worstKey = key;
      worstEntry = entry;
      worstOver = isOver;
      continue;
    }
    if (isOver !== worstOver) {
      if (isOver) {
        worstKey = key;
        worstEntry = entry;
        worstOver = true;
      }
      continue;
    }
    const diff = effectiveRank(entry) - effectiveRank(worstEntry);
    if (diff < 0 || (diff === 0 && entry.parts.href.localeCompare(worstEntry.parts.href) > 0)) {
      worstKey = key;
      worstEntry = entry;
      worstOver = isOver;
    }
  }
  return worstEntry ? { key: worstKey, entry: worstEntry, isOver: worstOver } : null;
}

/**
 * Cleans, filters, deduplicates (including `http`/`https`, `www.`, and `/r/<code>`
 * referral twins), and orders links so user-facing link pills prioritize direct
 * project links > quest platforms > official announcements.
 */
export function selectFeedLinks(rawUrls: string[], opts: SelectFeedLinksOptions = {}): string[] {
  const maxLinks = opts.maxLinks ?? 6;
  const projDom = opts.projectDomain?.toLowerCase();
  const lowerHandles = opts.sourceHandles
    ? new Set([...opts.sourceHandles].map(h => h.toLowerCase()))
    : undefined;

  const deduped = new Map<string, RankedCandidate>();
  const hostBucketCounts = new Map<string, number>();

  for (const raw of rawUrls) {
    const parts = cleanUrlParts(raw);
    if (!parts) continue;
    if (isNoisyLinkParsed(parts.url, parts.host, parts.reg, lowerHandles)) continue;

    const hostKey = parts.reg || parts.href;
    const limitForHost = isSocialDomain(hostKey) ? 1 : 2;
    const refKind = referralPathKind(parts.pathname);
    const rank = computeLinkRank(parts, projDom, opts.allKnownDomains);
    const candidate: RankedCandidate = { parts, rank, refKind, hostKey, limitForHost };

    const prev = deduped.get(parts.key);
    if (!prev) {
      if (deduped.size >= MAX_CANONICAL_CANDIDATES) {
        const worst = findWorstCandidate(deduped, hostBucketCounts);
        if (!worst) continue;
        const incomingCountAfterEvict =
          (hostBucketCounts.get(hostKey) ?? 0) - (worst.entry.hostKey === hostKey ? 1 : 0);
        const incomingWillOver = incomingCountAfterEvict >= limitForHost;
        if (!worst.isOver && incomingWillOver) continue;
        if (worst.isOver === incomingWillOver) {
          const rankDiff = effectiveRank(candidate) - effectiveRank(worst.entry);
          if (rankDiff < 0 || (rankDiff === 0 && candidate.parts.href.localeCompare(worst.entry.parts.href) >= 0)) {
            continue;
          }
        }
        deduped.delete(worst.key);
        hostBucketCounts.set(worst.entry.hostKey, Math.max(0, (hostBucketCounts.get(worst.entry.hostKey) ?? 1) - 1));
      }
      deduped.set(parts.key, candidate);
      hostBucketCounts.set(hostKey, (hostBucketCounts.get(hostKey) ?? 0) + 1);
      continue;
    }

    const prevHttps = prev.parts.href.startsWith('https://');
    const nextHttps = parts.href.startsWith('https://');
    if (nextHttps && !prevHttps) {
      deduped.set(parts.key, candidate);
    } else if (nextHttps === prevHttps && prev.parts.href.includes('://www.') && !parts.href.includes('://www.')) {
      deduped.set(parts.key, candidate);
    }
  }

  const cleanPathsByHost = new Map<string, Set<string>>();
  for (const entry of deduped.values()) {
    if (entry.refKind === null) {
      let paths = cleanPathsByHost.get(entry.parts.host);
      if (!paths) {
        paths = new Set<string>();
        cleanPathsByHost.set(entry.parts.host, paths);
      }
      paths.add(normalizePathname(entry.parts.pathname));
    }
  }

  // Collapse path-based referral links (`/r/<code>`, `/join/<code>`, `/invite/<code>`)
  // ONLY when a retained non-referral URL provides the clean equivalent action on the same host.
  const ranked: {
    url: string;
    rank: number;
    reg: string;
    host: string;
    refKind: ReferralPathKind | null;
  }[] = [];

  for (const entry of deduped.values()) {
    const { parts, rank, refKind } = entry;
    if (refKind && cleanPathsByHost.get(parts.host)?.has(cleanEquivalentPath(refKind))) {
      continue;
    }
    ranked.push({ url: parts.href, rank, reg: parts.reg, host: parts.host, refKind });
  }

  ranked.sort((a, b) => b.rank - a.rank || a.url.localeCompare(b.url));

  // Cap per-host repetition so one domain never monopolizes all visible pills,
  // and keep at most one referral link per (host, refKind) action.
  const hostCounts = new Map<string, number>();
  const seenRefActions = new Set<string>();
  const out: string[] = [];
  for (const item of ranked) {
    const hostKey = item.reg || item.url;
    const isSocial = isSocialDomain(hostKey);
    const limitForHost = isSocial ? 1 : 2;
    const count = hostCounts.get(hostKey) ?? 0;
    if (count >= limitForHost) continue;
    if (item.refKind) {
      const refActionKey = `${item.host}:${item.refKind}`;
      if (seenRefActions.has(refActionKey)) continue;
      seenRefActions.add(refActionKey);
    }
    hostCounts.set(hostKey, count + 1);
    out.push(item.url);
    if (out.length >= maxLinks) break;
  }

  return out;
}
