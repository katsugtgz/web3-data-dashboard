import type { AirdropFeed, MarketSection, RiskLevel } from '../../../shared/types';
import {
  BENIGN_DNS_IPS,
  canonicalLinkKey,
  cleanUrl,
  extractSuspiciousRawIpUrls,
  getRegistrableDomain,
  isAlwaysHttpsDomain,
  isPlatformDomain,
  isRawIpHost,
} from '../normalize/domains';
import { URL_SHORTENERS } from './shorteners';

export { URL_SHORTENERS };

// Wallet-drain phrasing: require the scam-specific shape (a claim promise
// gated behind connecting a wallet in the SAME clause, or an eligibility
// check that asks for wallet validation). The window between 'claim' and the
// wallet word is capped so 'Claim your rewards to your wallet' style ordinary
// announcements with later 'wallet' mentions don't trip it.
export const DRAINER_RE =
  /claim (?:now|your)[^,.!?;]{0,40}\b(?:connect|connect your|verify)\b[^,.!?;]{0,30}\bwallet\b|connect (?:your )?wallet to (?:claim|receive|check)|eligib\w+ [^,.!?;]{0,40}(?:verify|validate) wallet|airdrop is live[^.!?]{0,60}(?:connect (?:your )?wallet|verify (?:your )?wallet|claim[^.!?]{0,30}connect (?:your )?wallet)/i;

// Crypto doubling / advance-fee scam phrasing ("send 100 USDT to receive 1000 back",
// "double your ETH", "deposit ... 2x back", "guaranteed 2x return / 200% ROI").
export const DOUBLING_SCAM_RE =
  /\bsend\s+[\d,.]+\s*(?:k|m)?\s*\$?[a-z]{2,10}\b[^.!?]{0,60}\b(?:to\s+)?(?:receive|get)\s+[\d,.]+\s*(?:k|m)?(?:\s*\$?[a-z]{2,10})?\s*(?:back|in\s+return|instantly|immediately)\b|\bdouble\s+your\s+(?:crypto|btc|bitcoin|eth|ethereum|sol|solana|usdt|usdc|bnb|ton|tokens?|coins?|deposit|balance|funds|money|holdings)\b|\bguaranteed\s+(?:\d+(?:\.\d+)?x\s+(?:return|profit|roi|on\s+(?:your\s+)?(?:deposit|investment|crypto|btc|eth|sol|usdt|usdc|bnb|ton|funds|money))|\d{2,4}%\s*(?:return|profit|roi|daily))\b|\b(?:send|deposit|invest|transfer)\b[^.!?]{0,60}\b\d+(?:\.\d+)?x\s+(?:return|profit|back|guaranteed)\b|\b\d+(?:\.\d+)?x\s+(?:return|profit|back)\s+(?:on\s+(?:your\s+)?(?:deposit|investment|funds|money|crypto|btc|eth|sol|usdt|usdc|bnb|ton)|in\s+(?:crypto|btc|eth|sol|usdt|usdc|bnb|ton|cash|usd))\b|\b\d+(?:\.\d+)?x\s+(?:return|profit)\s+guaranteed\b/i;

export const KNOWN_QUEST_PLATFORMS: [string, string][] = [
  ['galxe.com', 'Galxe'],
  ['app.galxe.com', 'Galxe'],
  ['zealy.io', 'Zealy'],
  ['layer3.xyz', 'Layer3'],
  ['intract.io', 'Intract'],
  ['guild.xyz', 'Guild'],
  ['questn.com', 'QuestN'],
  ['taskon.xyz', 'TaskOn'],
  ['soquest.xyz', 'SoQuest'],
  ['alphabot.app', 'Alphabot'],
  ['premint.xyz', 'Premint'],
  ['tokenops.xyz', 'TokenOps'],
  ['github.com', 'GitHub'],
];

const NON_ASCII_RE = /[^\u0000-\u007f]/;

/** Bounded Levenshtein distance with early exit when distance > maxDist. */
export function levenshtein(a: string, b: string, maxDist = 2): number {
  if (a === b) return 0;
  const al = a.length;
  const bl = b.length;
  if (Math.abs(al - bl) > maxDist) return maxDist + 1;

  let prev = Array.from({ length: bl + 1 }, (_, j) => j);
  for (let i = 1; i <= al; i++) {
    const curr = [i];
    let minInRow = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= bl; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      const val = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      curr[j] = val;
      if (val < minInRow) minInRow = val;
    }
    if (minInRow > maxDist) return maxDist + 1;
    prev = curr;
  }
  return prev[bl];
}

export function isPunycodeOrMixedScript(hostOrDomain: string): boolean {
  const lower = hostOrDomain.toLowerCase();
  if (lower.includes('xn--')) return true;
  return NON_ASCII_RE.test(lower);
}

export function findLookalikeDomain(domain: string, knownDomains: Map<string, string>): string | null {
  const lower = domain.toLowerCase();
  if (knownDomains.has(lower)) return null;
  const labelLen = (lower.split('.')[0] ?? lower).length;
  if (labelLen < 5) return null;

  for (const known of knownDomains.keys()) {
    if (known === lower) return null;
    if (Math.abs(known.length - lower.length) > 2) continue;
    const knownLabelLen = (known.split('.')[0] ?? known).length;
    if (knownLabelLen < 5) continue;
    const d = levenshtein(lower, known, 2);
    if (d >= 1 && d <= 2) return known;
  }
  return null;
}

export interface SafetyInput {
  domain?: string;
  urls: string[];
  rawIpUrls?: string[];
  text: string;
  knownProjectDomains: Map<string, string>;
  /** Quest-platform domains, used as lookalike targets only (never trusted). */
  platformDomains?: Set<string>;
  trustMax: number;
  sourceCount: number;
}

export interface SafetyResult {
  level: RiskLevel;
  reasons: string[];
}

export function evaluateSafety(input: SafetyInput): SafetyResult {
  let level: RiskLevel = 'ok';
  const reasons = new Set<string>();

  // Lookalike targets = verified project domains PLUS quest platforms:
  // zea1y.io must be flagged against zealy.io, so the platform set is merged
  // into the comparison baseline (but not into the trusted project set).
  let lookalikeBaseline = input.knownProjectDomains;
  if (input.platformDomains instanceof Set) {
    lookalikeBaseline = new Map<string, string>(input.knownProjectDomains);
    for (const d of input.platformDomains) {
      if (/^(github\.com|github\.io|gitlab\.com)$/.test(d)) continue;
      lookalikeBaseline.set(d, 'platform');
    }
  }

  const bump = (next: RiskLevel, reason: string) => {
    reasons.add(reason);
    if (next === 'risk') level = 'risk';
    else if (next === 'warn' && level === 'ok') level = 'warn';
  };

  // Flag any non-DNS raw-IP URL across explicit rawIpUrls, input.urls, and raw post text.
  const rawIpCandidates = [
    ...(input.rawIpUrls ?? []),
    ...input.urls,
    ...extractSuspiciousRawIpUrls(input.text),
  ];
  for (const raw of rawIpCandidates) {
    try {
      const host = new URL(raw).hostname.toLowerCase();
      if (isRawIpHost(host) && !BENIGN_DNS_IPS.has(host)) {
        bump('risk', `Raw IP link: ${host}`);
      }
    } catch {
      // Ignore malformed URL
    }
  }

  // Collect exact canonical keys of https:// URLs so only an exact canonical
  // twin suppresses "Insecure transport" (NOT host-wide across different paths).
  const httpsKeys = new Set<string>();
  for (const u of input.urls) {
    if (!/^https:\/\//i.test(u)) continue;
    httpsKeys.add(canonicalLinkKey(cleanUrl(u) ?? u));
  }

  const warnedHttpKeys = new Set<string>();
  for (const u of input.urls) {
    try {
      const parsedUrl = new URL(u);
      const host = parsedUrl.hostname.toLowerCase();
      if (isRawIpHost(host)) continue;

      const reg = getRegistrableDomain(u);
      const canonKey = canonicalLinkKey(cleanUrl(u) ?? u);

      // Flag genuine plain http:// only: skip always-HTTPS platforms (t.me, x.com)
      // and links that have an exact canonical https:// twin in the same post/cluster.
      if (
        /^http:\/\//i.test(u) &&
        !isAlwaysHttpsDomain(reg) &&
        !httpsKeys.has(canonKey) &&
        !warnedHttpKeys.has(canonKey)
      ) {
        warnedHttpKeys.add(canonKey);
        bump('warn', `Insecure transport (plain http): ${u}`);
      }

      if (isPunycodeOrMixedScript(host)) {
        bump('risk', `Punycode or mixed-script domain: ${host}`);
      }
      if (reg && URL_SHORTENERS[reg]) {
        bump('warn', `URL shortener used: ${reg}`);
      }
      if (reg && !isPlatformDomain(reg) && !URL_SHORTENERS[reg]) {
        const similar = findLookalikeDomain(reg, lookalikeBaseline);
        if (similar) {
          bump('risk', `Possible lookalike domain (${reg} vs ${similar})`);
        }
      }
    } catch {
      // Ignore malformed URL
    }
  }

  if (DRAINER_RE.test(input.text)) {
    bump('risk', 'Suspicious wallet-connect or claim phrasing');
  }

  if (DOUBLING_SCAM_RE.test(input.text)) {
    bump('risk', 'Crypto doubling / advance-fee scam phrasing');
  }

  if (input.domain && !isPlatformDomain(input.domain)) {
    if (isPunycodeOrMixedScript(input.domain)) {
      bump('risk', `Punycode or mixed-script project domain: ${input.domain}`);
    } else {
      const similar = findLookalikeDomain(input.domain, lookalikeBaseline);
      if (similar) {
        bump('risk', `Possible lookalike domain (${input.domain} vs ${similar})`);
      }
      if (!input.knownProjectDomains.has(input.domain.toLowerCase())) {
        bump('warn', `Domain not in verified registry: ${input.domain}`);
      }
    }
  }

  if (input.trustMax < 0.4 && input.sourceCount <= 1) {
    bump('warn', 'Single low-trust source');
  }

  return { level, reasons: [...reasons] };
}

export interface ReconcileSafetyInput {
  level: RiskLevel;
  reasons: string[];
  domain?: string;
  cleanedLinks: string[];
  knownDomains: ReadonlySet<string>;
}

/**
 * Reconciles stored cluster safety reasons against the live `known_domains`
 * registry and cleaned links (handles legacy D1 rows where a domain was seeded
 * after initial ingest or bare-domain `http://` twins were stored previously).
 * Never downgrades `'risk'` to `'warn'` or `'ok'`, and preserves URL shortener
 * warnings even when shorteners are not shown in `cleanedLinks`.
 */
export function reconcileSafetyReasons(input: ReconcileSafetyInput): SafetyResult {
  const httpsKeys = new Set<string>();
  for (const u of input.cleanedLinks) {
    try {
      const parsed = new URL(u);
      if (parsed.protocol === 'https:') {
        httpsKeys.add(canonicalLinkKey(cleanUrl(u) ?? u));
      }
    } catch {
      // Ignore
    }
  }

  const seenHttpKeys = new Set<string>();
  const kept: string[] = [];

  for (const reason of input.reasons) {
    const unverifiedMatch = reason.match(/^Domain not in verified registry:\s*(.+)$/i);
    if (unverifiedMatch) {
      const dom = unverifiedMatch[1].trim().toLowerCase();
      if (input.knownDomains.has(dom) || isPlatformDomain(dom)) continue;
    }

    const httpMatch = reason.match(/^Insecure transport \(plain http\):\s*(.+)$/i);
    if (httpMatch) {
      const rawUrl = httpMatch[1].trim();
      try {
        const parsed = new URL(rawUrl);
        const host = parsed.hostname.toLowerCase();
        const reg = getRegistrableDomain(rawUrl);
        const key = canonicalLinkKey(cleanUrl(rawUrl) ?? rawUrl);
        if (BENIGN_DNS_IPS.has(host) || isAlwaysHttpsDomain(reg) || httpsKeys.has(key)) continue;
        if (seenHttpKeys.has(key)) continue;
        seenHttpKeys.add(key);
      } catch {
        continue;
      }
    }

    kept.push(reason);
  }

  const uniqueReasons = [...new Set(kept)];
  const level: RiskLevel =
    input.level === 'risk'
      ? 'risk'
      : input.level === 'warn'
        ? uniqueReasons.length > 0
          ? 'warn'
          : 'ok'
        : 'ok';

  return { level, reasons: uniqueReasons };
}

export interface KnownDomainEntry {
  domain: string;
  project: string;
  origin: 'surf' | 'defi' | 'platform';
}

export function collectKnownDomainEntries(
  surfFeed?: AirdropFeed | null,
  defiSection?: MarketSection | null,
): KnownDomainEntry[] {
  const map = new Map<string, KnownDomainEntry>();

  for (const [domain, project] of KNOWN_QUEST_PLATFORMS) {
    map.set(domain, { domain, project, origin: 'platform' });
  }

  if (surfFeed) {
    for (const card of surfFeed.cards) {
      const candidates = [card.url, ...(card.tasks?.map(t => t.url) ?? [])];
      for (const raw of candidates) {
        if (!raw) continue;
        const dom = getRegistrableDomain(raw);
        if (!dom || isPlatformDomain(dom) || URL_SHORTENERS[dom]) continue;
        if (!map.has(dom)) map.set(dom, { domain: dom, project: card.n, origin: 'surf' });
      }
    }
  }

  if (defiSection) {
    for (const row of defiSection.rows) {
      if (!row.href) continue;
      const dom = getRegistrableDomain(row.href);
      if (!dom || isPlatformDomain(dom) || URL_SHORTENERS[dom]) continue;
      if (!map.has(dom)) map.set(dom, { domain: dom, project: row.cells[0] ?? dom, origin: 'defi' });
    }
  }

  return [...map.values()];
}

export async function seedKnownDomains(
  db: D1Database,
  surfFeed?: AirdropFeed | null,
  defiSection?: MarketSection | null,
): Promise<number> {
  const entries = collectKnownDomainEntries(surfFeed, defiSection);
  if (entries.length === 0) return 0;

  const stmts = entries.map(e =>
    db
      .prepare(
        `INSERT INTO known_domains (domain, project, origin) VALUES (?1, ?2, ?3)
         ON CONFLICT(domain) DO UPDATE SET project = excluded.project, origin = excluded.origin
         WHERE known_domains.project IS NOT excluded.project
            OR known_domains.origin IS NOT excluded.origin`,
      )
      .bind(e.domain, e.project, e.origin),
  );

  const chunks = [];
  for (let i = 0; i < stmts.length; i += 40) {
    chunks.push(db.batch(stmts.slice(i, i + 40)));
  }
  try {
    await Promise.all(chunks);
  } finally {
    knownDomainsGen.set(db, (knownDomainsGen.get(db) ?? 0) + 1);
    knownDomainsCache.delete(db);
  }
  return entries.length;
}

export interface KnownDomainsLoaded {
  projectDomains: Map<string, string>;
  allKnownDomains: Set<string>;
  /** Platform domains (Galxe, Zealy, ...) live only here: known for the feed's
   *  `known` link flag and as lookalike targets, never trusted as project
   *  identity (impersonations of these must still be flagged). */
  platformDomains: Set<string>;
}

export const KNOWN_DOMAINS_TTL_MS = 5 * 60_000;

const knownDomainsCache = new WeakMap<D1Database, { value: KnownDomainsLoaded; expiresAt: number }>();
const knownDomainsGen = new WeakMap<D1Database, number>();

export async function loadKnownDomains(db: D1Database, nowMs = Date.now()): Promise<KnownDomainsLoaded> {
  const cached = knownDomainsCache.get(db);
  if (cached && nowMs < cached.expiresAt) {
    return cached.value;
  }

  const gen = knownDomainsGen.get(db) ?? 0;
  const res = await db.prepare('SELECT domain, project, origin FROM known_domains').all<{
    domain: string;
    project: string;
    origin: string;
  }>();
  const projectDomains = new Map<string, string>();
  const allKnownDomains = new Set<string>();
  const platformDomains = new Set<string>();
  for (const row of res.results ?? []) {
    const dom = row.domain.toLowerCase();
    allKnownDomains.add(dom);
    if (row.origin === 'platform') {
      platformDomains.add(dom);
    } else {
      projectDomains.set(dom, row.project);
    }
  }
  const value: KnownDomainsLoaded = { projectDomains, allKnownDomains, platformDomains };
  if ((knownDomainsGen.get(db) ?? 0) === gen) {
    knownDomainsCache.set(db, { value, expiresAt: nowMs + KNOWN_DOMAINS_TTL_MS });
  }
  return value;
}
