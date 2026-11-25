import type { FeedItem } from '../../shared/types';

export interface DisplayLink {
  url: string;
  label: string;
  known: boolean;
}

export interface DisplayRiskNote {
  id: string;
  text: string;
}

export interface FormattedSummary {
  lead: string;
  bullets: string[];
  text: string;
}

const RAW_IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const BENIGN_DNS_IPS = new Set(['1.1.1.1', '1.0.0.1', '8.8.8.8', '8.8.4.4', '9.9.9.9']);
const LEADING_TITLE_NOISE_RE = /^[\s*#•·\-–—:>|\u200B-\u200D\uFEFF]+/;
const TRAILING_TITLE_NOISE_RE = /[\s:|\-–—•·]+$/;
const TRAILING_ENCODED_EMOJI_RE =
  /(?:%F0%9F(?:%[0-9A-F]{2}){2}|%E2%9C%[0-9A-F]{2}|%EF%B8%8F)[^\s&#]*$/i;
const REFERRAL_CODE_PATH_RE = /^\/(?:r|ref|invite)\/([a-z0-9_-]{3,24})\/?$/i;
const JOIN_PATH_RE = /^\/join\/([a-z0-9_-]{3,24})\/?$/i;
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

function isTelegramBotHandle(handle?: string): boolean {
  return Boolean(handle && /bot$/i.test(handle));
}
const MEANINGFUL_HASH_RE = /^#[a-z0-9_-]{2,}$/i;
const CHANNEL_VARIANT_SUFFIX_RE = /_(?:chat|group|news|channel|ann|announcements|community|official)$/;

const TRACKING_PARAMS = new Set([
  'ref',
  'ref_',
  'ref_src',
  'ref_url',
  'referral',
  'referrer',
  'invite',
  'invitecode',
  'invite_code',
  'aff',
  'affiliate',
  'fbclid',
  'gclid',
  'mc_cid',
  'mc_eid',
  'boost',
]);

const X_SHARE_PARAMS = new Set(['s', 't', 'a', 'src', 'ref_src', 'ref_url']);

const SOCIAL_HOSTS = new Set([
  'x.com',
  'twitter.com',
  't.me',
  'telegram.me',
  'youtube.com',
  'youtu.be',
  'discord.gg',
  'discord.com',
  'instagram.com',
  'tiktok.com',
]);

const BIO_AGGREGATOR_HOSTS = new Set([
  'linktr.ee',
  'linktree.com',
  'beacons.ai',
  'bio.link',
]);

const GENERIC_LEAF_SEGMENTS = new Set(['overview', 'index', 'index.html', 'home']);

const UNVERIFIED_DOMAIN_RE = /^Domain not in verified registry:\s*(\S+)$/i;
const PLAIN_HTTP_RE = /^Insecure transport \(plain http\):\s*(\S+)$/i;

const TURKISH_CHAR_RE = /[\u011e\u011f\u015e\u015f\u0130\u0131]/;
const TURKISH_APOSTROPHE_RE =
  /\b[A-Z0-9]{2,}'(?:ye|ya|te|ta|de|da|nin|n\u0131n|nun|n\u00fcn|in|\u0131n|un|\u00fcn|den|dan|ten|tan)\b/i;
const TURKISH_WORD_RE =
  /\b(?:bir kaynak|a\u00e7\u0131klad\u0131|s\u00f6yledi|bildirdi|belirtti|duyurdu|hakk\u0131nda|g\u00f6re|yapt\u0131\u011f\u0131|olarak|i\u00e7in|olmad\u0131\u011f\u0131n\u0131|oldu\u011funu|kald\u0131\u011f\u0131n\u0131|de\u011fil|veya)\b/i;

const DANGLING_LABEL_RE =
  /\s*(?:(?:[\u{1F4D6}\u{1F4CC}\u{1F517}\u{27A1}\u{FE0F}\u{1F449}\u{2192}]+\s*)?(?:source|sorce|link|register|apply\s+here|apply\s+now|check\s+here|go\s+to|join\s+waitlist|winnerlist|lfg)\s*:|[\u{1F4D6}\u{1F4CC}\u{1F517}\u{27A1}\u{1F449}\u{2192}]\u{FE0F}?\s*(?:source|sorce|link|register|check\s+here|apply\s+now)?|[\u{27A1}\u{1F449}\u{2192}]\u{FE0F}?)\s*$/iu;

const DANGLING_CONNECTOR_RE =
  /\s+(?:and|or|the|a|an|of|to|in|for|with|on|at|by|from|as|is|are|was|were|be|that|this|but)$/i;

const MAX_LINK_LABEL_LEN = 34;
const MAX_DISPLAY_BULLETS = 4;

interface LinkCandidate {
  url: URL;
  href: string;
  bareHost: string;
  known: boolean;
  isSocial: boolean;
  isBioAggregator: boolean;
  referralKind: ReferralPathKind | null;
  tier: number;
  order: number;
}

function bareHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, '');
}

function isRawIpHost(host: string): boolean {
  return RAW_IPV4_RE.test(host) || host.startsWith('[');
}

function hostMatchesDomain(host: string, domain: string): boolean {
  const normDomain = bareHostname(domain);
  return host === normDomain || host.endsWith(`.${normDomain}`);
}

export function dedupeFeedSources(sources: FeedItem['sources']): FeedItem['sources'] {
  const seen = new Set<string>();
  const out: FeedItem['sources'] = [];
  for (const src of sources) {
    const url = src.postUrl.trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url === src.postUrl ? src : { ...src, postUrl: url });
  }
  return out;
}

export function formatProjectTitle(project: string): string {
  const cleaned = project
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(LEADING_TITLE_NOISE_RE, '')
    .replace(TRAILING_TITLE_NOISE_RE, '')
    .trim();
  return cleaned || 'Web3 Project';
}

function sanitizeFeedUrl(raw: string): { url: URL; hadBoostParam: boolean } | null {
  const decoded = raw.trim().replace(/&amp;/gi, '&');
  if (!decoded || /\s/.test(decoded)) return null;
  if (decoded.includes('\u2026') || /%e2%80%a6/i.test(decoded)) return null;

  const strippedEmoji = decoded.replace(TRAILING_ENCODED_EMOJI_RE, '');
  let parsed: URL;
  try {
    parsed = new URL(strippedEmoji);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (parsed.username || parsed.password) return null;

  const host = bareHostname(parsed.hostname);
  if (!host.includes('.') || isRawIpHost(host)) return null;

  const hadBoostParam = parsed.searchParams.has('boost');
  const isXHost = host === 'x.com' || host === 'twitter.com';
  for (const key of [...parsed.searchParams.keys()]) {
    const lk = key.toLowerCase();
    if (lk.startsWith('utm_') || TRACKING_PARAMS.has(lk) || (isXHost && X_SHARE_PARAMS.has(lk))) {
      parsed.searchParams.delete(key);
    }
  }

  if (parsed.hash === '#' || /^#update$/i.test(parsed.hash)) {
    parsed.hash = '';
  }

  return { url: parsed, hadBoostParam };
}

function buildSourceMatchers(sources: FeedItem['sources']): { handles: Set<string>; stems: Set<string> } {
  const handles = new Set<string>();
  const stems = new Set<string>();
  for (const src of sources) {
    const handle = src.handle.trim().toLowerCase();
    if (!handle) continue;
    handles.add(handle);
    if (handle.includes('_')) {
      const stem = handle.split('_')[0];
      if (stem.length >= 4) stems.add(stem);
    }
  }
  return { handles, stems };
}

function isDroppedNoiseUrl(
  url: URL,
  hadBoostParam: boolean,
  sourceMatchers: { handles: Set<string>; stems: Set<string> },
): boolean {
  const host = bareHostname(url.hostname);
  const segs = url.pathname.split('/').filter(Boolean);

  if (host === 't.me' || host === 'telegram.me') {
    if (segs.length === 0 || hadBoostParam) return true;
    const handle = segs[0].toLowerCase();
    if (handle === 'c' || handle === 'joinchat' || handle.startsWith('+')) return true;
    if (sourceMatchers.handles.has(handle)) return true;
    if (CHANNEL_VARIANT_SUFFIX_RE.test(handle)) {
      const stem = handle.split('_')[0];
      if (sourceMatchers.stems.has(stem)) return true;
    }
    return false;
  }

  if (host === 'x.com' || host === 'twitter.com') {
    const first = segs[0]?.toLowerCase() ?? '';
    return !first || first === 'search' || first === 'hashtag' || first === 'explore' || first === 'home';
  }

  if (BIO_AGGREGATOR_HOSTS.has(host)) {
    if (segs.length === 0) return true;
    return sourceMatchers.handles.has(segs[0].toLowerCase());
  }

  return false;
}

function canonicalLinkKey(url: URL, bareHost: string): string {
  const segs = url.pathname.split('/').filter(Boolean);

  if (bareHost === 't.me' || bareHost === 'telegram.me') {
    const handle = (segs[0] ?? '').toLowerCase();
    if (!isTelegramBotHandle(handle)) {
      return `tg:${handle}`;
    }
    const subpath = segs.slice(1).join('/').toLowerCase();
    const sortedParams = [...url.searchParams.entries()]
      .sort(([aKey, aVal], [bKey, bVal]) => aKey.localeCompare(bKey) || aVal.localeCompare(bVal))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    return `tg:${handle}${subpath ? `/${subpath}` : ''}${sortedParams ? `?${sortedParams}` : ''}`;
  }

  if (bareHost === 'x.com' || bareHost === 'twitter.com') {
    const first = (segs[0] ?? '').toLowerCase();
    return first === 'i' ? 'x:i' : `x:${first}`;
  }

  const normPath = url.pathname.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
  const sortedParams = [...url.searchParams.entries()]
    .sort(([aKey, aVal], [bKey, bVal]) => aKey.localeCompare(bKey) || aVal.localeCompare(bVal))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const hashKey = normPath === '/' && MEANINGFUL_HASH_RE.test(url.hash) ? url.hash.toLowerCase() : '';
  return `${bareHost}${normPath}${sortedParams ? `?${sortedParams}` : ''}${hashKey}`;
}

function shouldReplaceCandidate(existing: LinkCandidate, incoming: LinkCandidate): boolean {
  const existingHttps = existing.url.protocol === 'https:';
  const incomingHttps = incoming.url.protocol === 'https:';
  if (incomingHttps !== existingHttps) return incomingHttps;
  if (incoming.known !== existing.known) return incoming.known;
  return false;
}

function meaningfulPathSegments(url: URL): string[] {
  const raw = url.pathname.split('/').filter(Boolean);
  const filtered: string[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const seg = raw[i];
    // Strip YYYY/MM/DD date segments inside article URLs.
    if (/^(?:19|20)\d{2}$/.test(seg) && i < raw.length - 1) {
      while (i + 1 < raw.length - 1 && /^\d{1,2}$/.test(raw[i + 1])) {
        i += 1;
      }
      continue;
    }
    filtered.push(seg);
  }
  while (filtered.length > 1 && GENERIC_LEAF_SEGMENTS.has(filtered[filtered.length - 1].toLowerCase())) {
    filtered.pop();
  }
  return filtered;
}

function truncateLabel(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 1).replace(/[-/_]+$/, '')}\u2026`;
}

function formatBotLabelWithSuffix(handle: string, suffix: string, maxLen: number): string {
  const full = `t.me/${handle}${suffix}`;
  if (full.length <= maxLen) return full;
  const minPrefixLen = 't.me/'.length + Math.min(handle.length, 4) + 1;
  const safeSuffix = suffix.length <= maxLen - minPrefixLen ? suffix : truncateLabel(suffix, maxLen - minPrefixLen);
  const handleChars = Math.max(0, maxLen - 't.me/'.length - 1 - safeSuffix.length);
  if (handleChars === 0) return truncateLabel(full, maxLen);
  return `t.me/${handle.slice(0, handleChars)}\u2026${safeSuffix}`;
}

function formatLinkLabel(url: URL, sameHostUrls: URL[]): string {
  const host = bareHostname(url.hostname);
  const segs = url.pathname.split('/').filter(Boolean);

  if (host === 't.me' || host === 'telegram.me') {
    const handle = segs[0];
    if (!handle) return 't.me';
    if (isTelegramBotHandle(handle)) {
      const handleLower = handle.toLowerCase();
      const sameBotPeers = sameHostUrls.filter(
        peer => (peer.pathname.split('/').filter(Boolean)[0] ?? '').toLowerCase() === handleLower,
      );
      if (sameBotPeers.length > 1) {
        const subpath = segs.slice(1).join('/');
        const launchKey = ['start', 'startapp', 'startgroup', 'startchannel'].find(k => url.searchParams.has(k));
        const paramPair = launchKey
          ? ([launchKey, url.searchParams.get(launchKey) ?? ''] as const)
          : [...url.searchParams.entries()][0];
        const querySuffix = paramPair ? `?${paramPair[0]}=${paramPair[1]}` : '';
        const suffix = `${subpath ? `/${subpath}` : ''}${querySuffix}`;
        if (suffix) {
          return formatBotLabelWithSuffix(handle, suffix, MAX_LINK_LABEL_LEN);
        }
      }
    }
    return truncateLabel(`t.me/${handle}`, MAX_LINK_LABEL_LEN);
  }
  if (host === 'x.com' || host === 'twitter.com') {
    if (segs[0] && segs[0].toLowerCase() !== 'i') {
      return truncateLabel(`${host}/@${segs[0]}`, MAX_LINK_LABEL_LEN);
    }
    return `${host}/post`;
  }
  if (host === 'youtube.com') {
    return segs[0]?.startsWith('@') ? truncateLabel(`youtube.com/${segs[0]}`, MAX_LINK_LABEL_LEN) : 'youtube.com';
  }
  if (host === 'discord.gg') {
    return segs[0] ? truncateLabel(`discord.gg/${segs[0]}`, MAX_LINK_LABEL_LEN) : 'discord.gg';
  }
  if (BIO_AGGREGATOR_HOSTS.has(host)) {
    return segs[0] ? truncateLabel(`${host}/${segs[0]}`, MAX_LINK_LABEL_LEN) : host;
  }

  if (sameHostUrls.length <= 1) return host;

  const cleanSegs = meaningfulPathSegments(url);
  if (cleanSegs.length === 0) {
    if (MEANINGFUL_HASH_RE.test(url.hash)) {
      return truncateLabel(`${host}/${url.hash}`, MAX_LINK_LABEL_LEN);
    }
    return host;
  }

  // If peer URLs on this host share the exact first two segments, show the trailing pair so labels diverge.
  const firstTwo = cleanSegs.slice(0, 2).join('/');
  const collidesOnFirstTwo =
    cleanSegs.length >= 3 &&
    sameHostUrls.some(peer => peer !== url && meaningfulPathSegments(peer).slice(0, 2).join('/') === firstTwo);

  const subPath = collidesOnFirstTwo ? cleanSegs.slice(-2).join('/') : cleanSegs.slice(0, 2).join('/');
  const pathCollidesWithPeer = sameHostUrls.some(
    peer => peer !== url && meaningfulPathSegments(peer).join('/') === cleanSegs.join('/'),
  );
  if (pathCollidesWithPeer) {
    const firstParam = [...url.searchParams.entries()][0];
    if (firstParam) {
      return truncateLabel(`${host}/${subPath}?${firstParam[0]}=${firstParam[1]}`, MAX_LINK_LABEL_LEN);
    }
  }
  return truncateLabel(`${host}/${subPath}`, MAX_LINK_LABEL_LEN);
}

function selectBalancedCandidates(candidates: LinkCandidate[], max: number): LinkCandidate[] {
  const nonSocial = candidates.filter(c => !c.isSocial);
  const social = candidates.filter(c => c.isSocial);
  const picked: LinkCandidate[] = [];
  const used = new Set<LinkCandidate>();

  // Pass 1: one top link per distinct non-social host for host diversity.
  const seenNonSocialHosts = new Set<string>();
  for (const c of nonSocial) {
    if (picked.length >= max) break;
    if (seenNonSocialHosts.has(c.bareHost)) continue;
    seenNonSocialHosts.add(c.bareHost);
    picked.push(c);
    used.add(c);
  }

  // Pass 2: fill remaining slots with additional actionable paths on non-social hosts.
  for (const c of nonSocial) {
    if (picked.length >= max) break;
    if (used.has(c)) continue;
    picked.push(c);
    used.add(c);
  }

  // Pass 3: fill any remaining slots with social links.
  for (const c of social) {
    if (picked.length >= max) break;
    if (used.has(c)) continue;
    picked.push(c);
    used.add(c);
  }

  return picked;
}

export function prepareFeedLinks(
  item: Pick<FeedItem, 'links' | 'domain' | 'sources'>,
  options?: { max?: number },
): DisplayLink[] {
  const max = options?.max ?? 3;
  if (item.links.length === 0 || max <= 0) return [];

  const sourceMatchers = buildSourceMatchers(item.sources);
  const deduped = new Map<string, LinkCandidate>();

  item.links.forEach((rawLink, order) => {
    const parsed = sanitizeFeedUrl(rawLink.url);
    if (!parsed) return;
    if (isDroppedNoiseUrl(parsed.url, parsed.hadBoostParam, sourceMatchers)) return;

    const host = bareHostname(parsed.url.hostname);
    const segs = parsed.url.pathname.split('/').filter(Boolean);
    const isTgBot = (host === 't.me' || host === 'telegram.me') && isTelegramBotHandle(segs[0]);
    const isBioAggregator = BIO_AGGREGATOR_HOSTS.has(host);
    const isSocial = (SOCIAL_HOSTS.has(host) && !isTgBot) || isBioAggregator;
    const referralKind = isSocial ? null : referralPathKind(parsed.url.pathname);
    const matchesDomain = Boolean(item.domain && hostMatchesDomain(host, item.domain));

    const known = rawLink.known === true && parsed.url.protocol === 'https:';
    const tier = !isSocial ? (known ? 0 : matchesDomain ? 1 : 2) : 3;
    const candidate: LinkCandidate = {
      url: parsed.url,
      href: parsed.url.href,
      bareHost: host,
      known,
      isSocial,
      isBioAggregator,
      referralKind,
      tier,
      order,
    };

    const key = canonicalLinkKey(parsed.url, host);
    const prev = deduped.get(key);
    if (!prev) {
      deduped.set(key, candidate);
    } else if (shouldReplaceCandidate(prev, candidate)) {
      deduped.set(key, { ...candidate, order: Math.min(prev.order, candidate.order) });
    }
  });

  let candidates = [...deduped.values()];

  const hasNonSocial = candidates.some(c => !c.isSocial);
  if (hasNonSocial) {
    candidates = candidates.filter(c => !c.isBioAggregator);
  }

  const cleanPathsByHost = new Map<string, Set<string>>();
  for (const c of candidates) {
    if (c.isSocial || c.referralKind !== null) continue;
    let paths = cleanPathsByHost.get(c.bareHost);
    if (!paths) {
      paths = new Set<string>();
      cleanPathsByHost.set(c.bareHost, paths);
    }
    paths.add(normalizePathname(c.url.pathname));
  }
  candidates = candidates.filter(c => {
    if (!c.referralKind) return true;
    return !cleanPathsByHost.get(c.bareHost)?.has(cleanEquivalentPath(c.referralKind));
  });

  candidates.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    const aHttps = a.url.protocol === 'https:' ? 0 : 1;
    const bHttps = b.url.protocol === 'https:' ? 0 : 1;
    if (aHttps !== bHttps) return aHttps - bHttps;
    return a.order - b.order;
  });

  const selected = selectBalancedCandidates(candidates, max);

  const byHost = new Map<string, URL[]>();
  for (const c of selected) {
    const list = byHost.get(c.bareHost) ?? [];
    list.push(c.url);
    byHost.set(c.bareHost, list);
  }

  const seenLabels = new Set<string>();
  const out: DisplayLink[] = [];
  for (const c of selected) {
    const label = formatLinkLabel(c.url, byHost.get(c.bareHost) ?? [c.url]);
    const labelKey = label.toLowerCase();
    if (seenLabels.has(labelKey)) continue;
    seenLabels.add(labelKey);
    out.push({ url: c.href, label, known: c.known });
  }

  return out;
}

export function formatRiskReasons(item: Pick<FeedItem, 'risk' | 'links' | 'domain'>): DisplayRiskNote[] {
  if (item.risk.reasons.length === 0) return [];

  if (item.risk.level === 'risk') {
    const unique = new Set<string>();
    const out: DisplayRiskNote[] = [];
    for (const raw of item.risk.reasons) {
      const cleaned = raw.replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
      if (!cleaned || unique.has(cleaned)) continue;
      unique.add(cleaned);
      out.push({ id: cleaned, text: cleaned });
    }
    return out;
  }

  const verifiedHttpsHosts = new Set<string>();
  for (const link of item.links) {
    if (link.known !== true) continue;
    try {
      const u = new URL(link.url.trim());
      if (u.protocol === 'https:' && !u.username && !u.password) {
        verifiedHttpsHosts.add(bareHostname(u.hostname));
      }
    } catch {
      // Ignore unparseable links.
    }
  }

  const plainHttpCounts = new Map<string, number>();
  const otherNotes = new Set<string>();

  for (const raw of item.risk.reasons) {
    const cleaned = raw.replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
    if (!cleaned) continue;

    const unverifiedMatch = cleaned.match(UNVERIFIED_DOMAIN_RE);
    if (unverifiedMatch) {
      const host = bareHostname(unverifiedMatch[1]);
      const contradicted = [...verifiedHttpsHosts].some(vh => hostMatchesDomain(vh, host));
      if (!contradicted) {
        otherNotes.add(`Domain not in verified registry: ${host}`);
      }
      continue;
    }

    const httpMatch = cleaned.match(PLAIN_HTTP_RE);
    if (httpMatch) {
      try {
        const u = new URL(httpMatch[1]);
        const host = bareHostname(u.hostname);
        if (BENIGN_DNS_IPS.has(host)) continue;
        if (isRawIpHost(host)) {
          otherNotes.add(cleaned);
          continue;
        }
        plainHttpCounts.set(host, (plainHttpCounts.get(host) ?? 0) + 1);
      } catch {
        otherNotes.add(cleaned);
      }
      continue;
    }

    otherNotes.add(cleaned);
  }

  if (plainHttpCounts.size === 1) {
    const [[host, count]] = [...plainHttpCounts.entries()];
    otherNotes.add(
      count === 1
        ? `Plain HTTP link detected: ${host}`
        : `Plain HTTP links detected: ${host} (${count} links)`,
    );
  } else if (plainHttpCounts.size === 2) {
    const hosts = [...plainHttpCounts.keys()];
    otherNotes.add(`Plain HTTP links detected: ${hosts[0]}, ${hosts[1]}`);
  } else if (plainHttpCounts.size >= 3) {
    const hosts = [...plainHttpCounts.keys()];
    otherNotes.add(`Plain HTTP links detected: ${hosts[0]}, ${hosts[1]} (+${hosts.length - 2} more domains)`);
  }

  return [...otherNotes].map(text => ({ id: text, text }));
}

function hasTurkishSignal(segment: string): boolean {
  return TURKISH_CHAR_RE.test(segment) || TURKISH_APOSTROPHE_RE.test(segment) || TURKISH_WORD_RE.test(segment);
}

function hasSubstantialAscii(segment: string): boolean {
  const letters = segment.match(/[A-Za-z]/g);
  return (letters?.length ?? 0) >= 12;
}

const EXPLICIT_TR_MARKER_RE = /^(?:\[?\s*(?:TR|T\u00fcrk\u00e7e|Turkish)\s*\]?\s*[:\-\u2013\u2014])/i;

function normalizeAsciiFold(input: string): string {
  return input
    .replace(/\u011e/g, 'G')
    .replace(/\u011f/g, 'g')
    .replace(/\u015e/g, 'S')
    .replace(/\u015f/g, 's')
    .replace(/\u0130/g, 'I')
    .replace(/\u0131/g, 'i')
    .replace(/[\u00d6\u00f6]/g, m => (m === '\u00d6' ? 'O' : 'o'))
    .replace(/[\u00dc\u00fc]/g, m => (m === '\u00dc' ? 'U' : 'u'))
    .replace(/[\u00c7\u00e7]/g, m => (m === '\u00c7' ? 'C' : 'c'));
}

function normalizeDuplicateKey(text: string): string {
  return normalizeAsciiFold(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function filterTurkishSegments(parts: string[]): string[] | null {
  const nonTurkish = parts.filter(p => !hasTurkishSignal(p));
  if (nonTurkish.length === 0 || nonTurkish.length >= parts.length || !nonTurkish.some(hasSubstantialAscii)) {
    return null;
  }
  const nonTurkishKeys = new Set(nonTurkish.map(normalizeDuplicateKey).filter(Boolean));
  let droppedAny = false;
  const kept = parts.filter(part => {
    if (!hasTurkishSignal(part)) return true;
    const isTranslation =
      EXPLICIT_TR_MARKER_RE.test(part) || nonTurkishKeys.has(normalizeDuplicateKey(part));
    if (isTranslation) {
      droppedAny = true;
      return false;
    }
    return true;
  });
  return droppedAny && kept.length > 0 ? kept : null;
}

function stripBilingualTurkishDuplicate(input: string): string {
  const lineParts = input
    .split(/\n+/)
    .map(p => p.trim())
    .filter(Boolean);
  if (lineParts.length >= 2) {
    const kept = filterTurkishSegments(lineParts);
    if (kept) return kept.join(' ');
  }

  const wireParts = input
    .split(/\s+\*(?=\S)/)
    .map(p => p.trim())
    .filter(Boolean);
  if (wireParts.length >= 2) {
    const kept = filterTurkishSegments(wireParts);
    if (kept) return kept.join(' ');
  }

  const sentences = input
    .split(/(?<=[.!?])\s+/)
    .map(p => p.trim())
    .filter(Boolean);
  if (sentences.length >= 2) {
    const kept = filterTurkishSegments(sentences);
    if (kept) return kept.join(' ');
  }

  return input;
}

function dedupeDoubledText(input: string): string {
  if (input.length >= 16 && input.length % 2 === 0) {
    const half = input.length / 2;
    if (input.slice(0, half).toLowerCase() === input.slice(half).toLowerCase()) {
      return input.slice(0, half).trim();
    }
  }
  if (input.length >= 17 && input.length % 2 === 1) {
    const mid = Math.floor(input.length / 2);
    if (input[mid] === ' ' && input.slice(0, mid).toLowerCase() === input.slice(mid + 1).toLowerCase()) {
      return input.slice(0, mid).trim();
    }
  }
  return input;
}

function stripDanglingLabels(input: string): string {
  let current = input.trim();
  for (let i = 0; i < 4; i += 1) {
    const next = current.replace(DANGLING_LABEL_RE, '').trim();
    if (next === current) break;
    current = next;
  }
  return current;
}

function cleanTruncatedTail(input: string): string {
  let text = input.trim();
  const hadDoubleEllipsis = /(?:\u2026|\.{3})\s*\S{1,4}(?:\u2026|\.{3})\s*$/.test(text);
  if (hadDoubleEllipsis) {
    text = text.replace(/(?:\u2026|\.{3})\s*\S{1,4}(?:\u2026|\.{3})\s*$/, '\u2026');
  }

  const match = text.match(/^(.*\s)(\S+)(\u2026|\.{3})$/);
  if (!match) return text;

  const [, prefix, lastToken, ellipsis] = match;
  const looksCut =
    hadDoubleEllipsis ||
    text.length >= 140 ||
    lastToken.length <= 3 ||
    (ellipsis === '...' && /^[A-Z][a-z]{1,4}$/.test(lastToken)) ||
    /-[a-z]{1,3}$/i.test(lastToken);

  if (!looksCut || !prefix.trim()) return text;

  let trimmed = prefix.trimEnd();
  trimmed = trimmed.replace(DANGLING_CONNECTOR_RE, '').trimEnd();
  trimmed = trimmed.replace(/[,:;\-–—(\u00b7]+$/, '').trimEnd();
  return trimmed ? `${trimmed}\u2026` : text;
}

function cleanBaseSummaryText(raw: string): string {
  let text = raw
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\r\n/g, '\n');

  text = stripBilingualTurkishDuplicate(text);
  text = text.replace(/\s+/g, ' ').trim();
  text = dedupeDoubledText(text);
  text = text.replace(/^\*+\s*/, '');
  text = text.replace(/(\u{1F6A8}|\u{1F525}|\u{26A1}|\u{1FA82}|\u{1F4E2})(?:\s*\1)+/gu, '$1');
  text = text.replace(/([A-Za-z0-9])#([A-Za-z])/g, '$1 #$2');
  text = text.replace(/\s+[\u2013\u2014-]\s*Link(?=\s+[A-Z0-9])/g, '.');
  text = text.replace(/\s+[\u2013\u2014-]\s*Link\s*$/i, '');
  text = text.replace(/\s+News\s*\|\s*Markets(?:\s*\|\s*YouTube)?\s*$/i, '');
  text = text.replace(/\s*(?:\u{1F4F0}\s*)?@[A-Za-z0-9_]{3,}\s*$/u, '');
  text = text.replace(
    /\b((?:https?:\/\/)?[a-z0-9-]+(?:\.[a-z0-9-]+)+)\/\?(?:ref|ref_|invite|inviteCode|referral)=[^\s]+/gi,
    '$1',
  );
  text = text.replace(/\s+:/g, ':');
  text = stripDanglingLabels(text);
  text = cleanTruncatedTail(text);
  return text;
}

const INLINE_BULLET_PATTERNS = [
  /\s*\u2796\s*/,
  /\s*\u2022\s*/,
  /\s*\u{1F7E2}\s*/u,
  /\s*\u2615\uFE0F?\s*/,
  /\s+\u00b7\s+/,
];

function splitInlineBullets(text: string): { lead: string; bullets: string[] } | null {
  for (const pattern of INLINE_BULLET_PATTERNS) {
    const globalRe = new RegExp(pattern.source, `${pattern.flags.includes('u') ? 'u' : ''}g`);
    const matches = text.match(globalRe);
    if (!matches || matches.length < 2) continue;

    const parts = text.split(pattern);
    const lead = stripDanglingLabels(parts[0] ?? '');
    const seen = new Set<string>();
    const bullets: string[] = [];

    for (const rawPart of parts.slice(1)) {
      let item = stripDanglingLabels(rawPart.replace(/^\u2705\s*/, '').trim());
      item = cleanTruncatedTail(item);
      if (!item || /^done[.!]?$/i.test(item)) continue;
      const donePrefix = item.match(/^done\b[\s:.-]+(.+)$/i);
      if (donePrefix) {
        item = donePrefix[1].trim();
      }
      if (!item) continue;
      const key = item.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      bullets.push(item);
      if (bullets.length >= MAX_DISPLAY_BULLETS) break;
    }

    if (bullets.length >= 2) {
      return { lead, bullets };
    }
  }
  return null;
}

function stripRedundantProjectPrefix(lead: string, project?: string): string {
  if (!project) return lead;
  const cleanTitle = formatProjectTitle(project);
  const prefix = `${cleanTitle}: `;
  if (lead.toLowerCase().startsWith(prefix.toLowerCase()) && lead.length - prefix.length >= 8) {
    const rest = lead.slice(prefix.length).trim();
    return rest ? `${rest[0].toUpperCase()}${rest.slice(1)}` : lead;
  }
  return lead;
}

export function formatFeedSummary(summary: string, project?: string): FormattedSummary {
  const cleaned = cleanBaseSummaryText(summary);
  if (!cleaned) return { lead: '', bullets: [], text: '' };

  const structured = splitInlineBullets(cleaned);
  if (structured) {
    const lead = stripRedundantProjectPrefix(structured.lead, project);
    const text = [lead, ...structured.bullets].filter(Boolean).join(' · ');
    return { lead, bullets: structured.bullets, text };
  }

  const lead = stripRedundantProjectPrefix(cleaned, project);
  return { lead, bullets: [], text: lead };
}
