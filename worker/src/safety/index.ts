import type { AirdropFeed, Card, MarketSection, RiskLevel } from '../../../shared/types';
import {
  BENIGN_DNS_IPS,
  canonicalLinkKey,
  cleanUrl,
  extractSuspiciousRawIpUrls,
  getRegistrableDomain,
  isAlwaysHttpsDomain,
  isCuratedAggregatorDomain,
  isPlatformDomain,
  isRawIpHost,
  PLATFORM_DOMAINS,
} from '../normalize/domains';
import { URL_SHORTENERS } from './shorteners';

export { URL_SHORTENERS };

// Wallet-drain phrasing: require the scam-specific shape (a claim promise
// gated behind connecting a wallet in the SAME clause, or an eligibility
// check that asks for wallet validation). The window between 'claim' and the
// wallet word is capped so 'Claim your rewards to your wallet' style ordinary
// announcements with later 'wallet' mentions don't trip it.
export const DRAINER_RE =
  /\bclaim\s+(?:[\d.,]+\s+)?(?:now|your|free|airdrop|rewards?|tokens?|sol|eth|btc|usdt|usdc|bnb|sui|ton|allocation|\$[a-z0-9]{2,10})\b[^.!?;]{0,50}\b(?:connect|verify|validate)\b[^.!?;]{0,30}\bwallet\b|\bconnect\s+(?:your\s+|an?\s+)?(?:active\s+|main\s+|primary\s+|funded\s+|eligible\s+)?(?:evm\s+|sol\s+|solana\s+|eth\s+)?wallet\b[^,.!?;]{0,30}\bto\s+(?:claim|receive|check|verify|mint|unlock)\b|\bconnect\s+(?:your\s+|an?\s+)?active(?:\s+[a-z0-9]{1,15}){0,3}\s+wallet\b|\beligib\w+\s+[^,.!?;]{0,40}(?:verify|validate)\s+wallet\b|\bairdrop\s+is\s+live\b[^.!?]{0,60}(?:connect\s+(?:your\s+)?wallet|verify\s+(?:your\s+)?wallet|claim[^.!?]{0,30}connect\s+(?:your\s+)?wallet)/i;

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

const GENERIC_SUBDOMAIN_LABELS = new Set([
  'app', 'www', 'api', 'docs', 'doc', 'blog', 'web', 'portal', 'dashboard', 'dash',
  'swap', 'bridge', 'stake', 'staking', 'claim', 'mint', 'quest', 'quests', 'drop', 'drops',
  'airdrop', 'testnet', 'mainnet', 'faucet', 'rewards', 'reward', 'points', 'trade', 'perp',
  'perps', 'dex', 'nft', 'nfts', 'dao', 'gov', 'vote', 'pool', 'pools', 'farm', 'vault',
  'vaults', 'earn', 'play', 'game', 'games', 'beta', 'alpha', 'dev', 'test', 'staging',
  'stage', 'launch', 'launchpad', 'early', 'waitlist', 'whitelist', 'checker', 'check',
  'verify', 'auth', 'login', 'pay', 'wallet', 'scan', 'explorer', 'stats', 'info', 'help',
  'support', 'status', 'news', 'media', 'mail', 'cdn', 'static', 'assets', 'img', 'images',
  'link', 'links', 'go', 'get', 'join', 'try', 'pro', 'hub', 'lab', 'labs', 'studio',
  'network', 'chain', 'core', 'base', 'open', 'live', 'node', 'nodes', 'rpc', 'ws',
  'platform', 'cloud', 'site', 'page', 'pages', 'event', 'events', 'campaign', 'campaigns',
  'social', 'token', 'tokens', 'finance', 'protocol', 'market', 'markets', 'store', 'shop',
  'home', 'index', 'account', 'accounts', 'profile', 'user', 'users', 'admin', 'data', 'graph',
]);

const SCAM_DOMAIN_WORDS = new Set([
  'claim', 'claims', 'airdrop', 'airdrops', 'drop', 'drops', 'reward', 'rewards', 'bonus',
  'free', 'mint', 'verify', 'verification', 'validate', 'connect', 'wallet', 'portal',
  'check', 'checker', 'eligibility', 'allocation', 'redeem', 'gift', 'promo', 'official',
  'secure', 'support', 'recovery', 'restore', 'sync', 'dapp', 'tge', 'whitelist', 'waitlist',
  'presale', 'refund', 'giveaway', 'distribution', 'snapshot', 'token', 'tokens', 'coin',
  'login', 'auth',
]);

export function findLookalikeDomain(hostOrDomain: string, knownDomains: Map<string, string>): string | null {
  const lower = hostOrDomain.trim().toLowerCase().replace(/^www\./, '').replace(/\.+$/, '');
  if (!lower || !lower.includes('.')) return null;

  const reg = getRegistrableDomain(`https://${lower}`) ?? lower;
  if (knownDomains.has(lower) || knownDomains.has(reg)) return null;

  const regLabel = reg.split('.')[0] ?? reg;
  const subPart =
    lower.length > reg.length && lower.endsWith(`.${reg}`)
      ? lower.slice(0, lower.length - reg.length - 1)
      : '';
  const subLabels = subPart ? subPart.split('.') : [];
  const subLabelSet = subPart ? new Set(subLabels) : null;
  const hyphenTokens = regLabel.includes('-') ? regLabel.split('-').filter(Boolean) : [];
  const hyphenTokenSet = hyphenTokens.length >= 2 ? new Set(hyphenTokens) : null;

  for (const known of knownDomains.keys()) {
    const knownLower = known.toLowerCase();
    if (knownLower === lower || knownLower === reg) return null;
    const knownReg = getRegistrableDomain(`https://${knownLower}`) ?? knownLower;
    if (knownReg === reg) return null;
    const knownLabel = knownReg.split('.')[0] ?? knownReg;

    // 1. Subdomain impersonation: full known domain (`arbitrum.io.evil.xyz`) or
    //    non-generic known brand label (`galxe.claim-drop.xyz`) in subdomain prefix.
    if (subPart) {
      if (
        subPart === knownReg ||
        subPart.startsWith(`${knownReg}.`) ||
        subPart.endsWith(`.${knownReg}`) ||
        subPart.includes(`.${knownReg}.`)
      ) {
        return known;
      }
      if (
        knownLabel.length >= 4 &&
        !GENERIC_SUBDOMAIN_LABELS.has(knownLabel) &&
        subLabelSet?.has(knownLabel)
      ) {
        return known;
      }
    }

    // 2. Exact SLD cross-TLD mismatch (`uniswap.com` vs `uniswap.org`) for label len >= 4.
    if (regLabel.length >= 4 && regLabel === knownLabel && reg !== knownReg) {
      return known;
    }

    // 3. Hyphenated brand+scam-word patterns (`arbitrum-claim`, `claim-arbitrum`, `uniswap-airdrop`).
    if (
      hyphenTokenSet !== null &&
      knownLabel.length >= 4 &&
      !GENERIC_SUBDOMAIN_LABELS.has(knownLabel) &&
      hyphenTokenSet.has(knownLabel) &&
      hyphenTokens.some(tok => tok !== knownLabel && SCAM_DOMAIN_WORDS.has(tok))
    ) {
      return known;
    }

    // 4. Typo distance: maxDist=1 for 4-char labels (`aav3.com`, `1ido.fi`), maxDist=2 for >=5-char labels.
    const maxDist =
      regLabel.length === 4 && knownLabel.length === 4
        ? 1
        : regLabel.length >= 5 && knownLabel.length >= 5
          ? 2
          : 0;
    if (maxDist === 0) continue;
    if (Math.abs(knownReg.length - reg.length) > maxDist) continue;
    const d = levenshtein(reg, knownReg, maxDist);
    if (d >= 1 && d <= maxDist) return known;
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
        const cleanHost = host.replace(/^www\./, '');
        const similar = findLookalikeDomain(cleanHost, lookalikeBaseline);
        if (similar) {
          bump('risk', `Possible lookalike domain (${cleanHost} vs ${similar})`);
        }
        if (!input.knownProjectDomains.has(reg.toLowerCase())) {
          bump('warn', `Domain not in verified registry: ${reg}`);
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
  const shownHttpKeys = new Set<string>();
  for (const u of input.cleanedLinks) {
    try {
      const parsed = new URL(u);
      const key = canonicalLinkKey(cleanUrl(u) ?? u);
      if (parsed.protocol === 'https:') {
        httpsKeys.add(key);
      } else if (parsed.protocol === 'http:') {
        shownHttpKeys.add(key);
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
        if (
          BENIGN_DNS_IPS.has(host) ||
          isAlwaysHttpsDomain(reg) ||
          httpsKeys.has(key) ||
          !shownHttpKeys.has(key)
        ) {
          continue;
        }
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
  origin: 'surf' | 'curated' | 'defi' | 'platform';
}

const UNTRUSTED_SHEET_SOURCES = new Set<string>(['asso7878', 'arndxt']);

function hasPunycodeOrMixedHost(rawUrl: string, regDomain: string): boolean {
  if (isPunycodeOrMixedScript(regDomain)) return true;
  try {
    return isPunycodeOrMixedScript(new URL(rawUrl).hostname);
  } catch {
    return false;
  }
}

/**
 * Extracts the trusted registrable project domain for a non-risk curated/Surf card.
 * Only `card.url` may represent the card; third-party task links, platform hosts,
 * curated aggregators (for non-self cards), punycode/IDN, and shorteners are never trusted.
 */
export function getTrustedSurfCardDomain(
  card: Pick<Card, 'b' | 'url' | 'tasks'> & { n?: string; source?: string },
): string | undefined {
  if (card.b?.includes('risk')) return undefined;
  if (!card.url) return undefined;
  const cardDom = getRegistrableDomain(card.url);
  if (!cardDom || isPlatformDomain(cardDom) || URL_SHORTENERS[cardDom]) return undefined;
  if (isCuratedAggregatorDomain(cardDom, { n: card.n ?? '', source: card.source })) return undefined;
  if (hasPunycodeOrMixedHost(card.url, cardDom)) return undefined;
  return cardDom;
}

export function collectKnownDomainEntries(
  surfFeed?: AirdropFeed | null,
  defiSection?: MarketSection | null,
): KnownDomainEntry[] {
  const map = new Map<string, KnownDomainEntry>();

  for (const [domain, project] of KNOWN_QUEST_PLATFORMS) {
    map.set(domain, { domain, project, origin: 'platform' });
  }

  // Pass 1: Verified registries (platform, Surf non-risk cards, DefiLlama DeFi).
  if (surfFeed) {
    for (const card of surfFeed.cards) {
      if (card.source && card.source !== 'Surf') continue;
      const dom = getTrustedSurfCardDomain(card);
      if (!dom) continue;
      if (!map.has(dom)) map.set(dom, { domain: dom, project: card.n, origin: 'surf' });
    }
  }

  if (defiSection) {
    for (const row of defiSection.rows) {
      if (!row.href) continue;
      const dom = getRegistrableDomain(row.href);
      if (!dom || isPlatformDomain(dom) || URL_SHORTENERS[dom]) continue;
      if (hasPunycodeOrMixedHost(row.href, dom)) continue;
      if (!map.has(dom)) map.set(dom, { domain: dom, project: row.cells[0] ?? dom, origin: 'defi' });
    }
  }

  const verifiedBaseline = new Map<string, string>();
  for (const [dom, entry] of map) {
    verifiedBaseline.set(dom, entry.project);
  }

  // Pass 2: Curated non-sheet sources (e.g. DefiLlama tokenless, Pendle/Merkl own protocol).
  // Editable third-party sheets (ASSO7878, arndxt), risk-badged cards, aggregator wrappers,
  // third-party task links, punycode/IDN domains, and lookalikes of verified domains are strictly excluded.
  if (surfFeed) {
    for (const card of surfFeed.cards) {
      if (card.b.includes('risk')) continue;
      if (!card.source || card.source === 'Surf') continue;
      if (UNTRUSTED_SHEET_SOURCES.has(card.source.trim().toLowerCase())) continue;
      const dom = getTrustedSurfCardDomain(card);
      if (!dom || map.has(dom)) continue;
      if (findLookalikeDomain(dom, verifiedBaseline)) continue;
      map.set(dom, { domain: dom, project: card.n, origin: 'curated' });
    }
  }

  return [...map.values()];
}

const knownDomainSeedQueues = new WeakMap<D1Database, Promise<void>>();

async function withKnownDomainSeedLock<T>(db: D1Database, fn: () => Promise<T>): Promise<T> {
  const prev = knownDomainSeedQueues.get(db) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const chained = prev.then(() => gate, () => gate);
  knownDomainSeedQueues.set(db, chained);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (knownDomainSeedQueues.get(db) === chained) {
      knownDomainSeedQueues.delete(db);
    }
  }
}

export async function seedKnownDomains(
  db: D1Database,
  surfFeed?: AirdropFeed | null,
  defiSection?: MarketSection | null,
): Promise<number> {
  const entries = collectKnownDomainEntries(surfFeed, defiSection);
  if (entries.length === 0) return 0;

  // Serialize per-DB seed calls and execute prunes + multi-row upserts in one
  // atomic D1 batch transaction so no concurrent seed can interleave a prune
  // over fresh rows. Multi-row upserts (30 rows * 3 params = 90) stay under
  // D1's 100-param statement cap.
  const UPSERT_ROWS_PER_STMT = 30;
  return withKnownDomainSeedLock(db, async () => {
    const blockedHostsJson = JSON.stringify([...PLATFORM_DOMAINS, ...Object.keys(URL_SHORTENERS)]);
    const platformDomainsJson = JSON.stringify(KNOWN_QUEST_PLATFORMS.map(([domain]) => domain));

    const pruneStmts: D1PreparedStatement[] = [
      db
        .prepare(
          `DELETE FROM known_domains
           WHERE origin != 'platform'
             AND (
               lower(domain) IN (SELECT value FROM json_each(?1))
               OR EXISTS (
                 SELECT 1 FROM json_each(?1) AS b
                 WHERE substr(lower(known_domains.domain), -length(b.value) - 1) = '.' || b.value
               )
             )`,
        )
        .bind(blockedHostsJson),
      db
        .prepare(
          `DELETE FROM known_domains
           WHERE origin = 'platform'
             AND domain NOT IN (SELECT value FROM json_each(?1))`,
        )
        .bind(platformDomainsJson),
    ];

    if (surfFeed?.cards.some(c => !c.source || c.source === 'Surf')) {
      const surfDomainsJson = JSON.stringify(entries.filter(e => e.origin === 'surf').map(e => e.domain.toLowerCase()));
      pruneStmts.push(
        db
          .prepare(
            `DELETE FROM known_domains
             WHERE origin = 'surf'
               AND lower(domain) NOT IN (SELECT value FROM json_each(?1))`,
          )
          .bind(surfDomainsJson),
      );
    }

    if (defiSection?.rows.length) {
      const defiDomainsJson = JSON.stringify(entries.filter(e => e.origin === 'defi').map(e => e.domain.toLowerCase()));
      pruneStmts.push(
        db
          .prepare(
            `DELETE FROM known_domains
             WHERE origin = 'defi'
               AND lower(domain) NOT IN (SELECT value FROM json_each(?1))`,
          )
          .bind(defiDomainsJson),
      );
    }

    if (surfFeed != null) {
      const curatedDomainsJson = JSON.stringify(
        entries.filter(e => e.origin === 'curated').map(e => e.domain.toLowerCase()),
      );
      pruneStmts.push(
        db
          .prepare(
            `DELETE FROM known_domains
             WHERE origin = 'curated'
               AND lower(domain) NOT IN (SELECT value FROM json_each(?1))`,
          )
          .bind(curatedDomainsJson),
      );
    }

    const upsertStmts: D1PreparedStatement[] = [];
    for (let i = 0; i < entries.length; i += UPSERT_ROWS_PER_STMT) {
      const slice = entries.slice(i, i + UPSERT_ROWS_PER_STMT);
      const placeholders = slice
        .map((_, idx) => `(?${idx * 3 + 1}, ?${idx * 3 + 2}, ?${idx * 3 + 3})`)
        .join(', ');
      const binds: string[] = [];
      for (const e of slice) {
        binds.push(e.domain, e.project, e.origin);
      }
      upsertStmts.push(
        db
          .prepare(
            `INSERT INTO known_domains (domain, project, origin) VALUES ${placeholders}
             ON CONFLICT(domain) DO UPDATE SET project = excluded.project, origin = excluded.origin
             WHERE (known_domains.project IS NOT excluded.project
                    OR known_domains.origin IS NOT excluded.origin)
               AND NOT (excluded.origin = 'curated' AND known_domains.origin IN ('defi', 'surf', 'platform'))`,
          )
          .bind(...binds),
      );
    }

    try {
      await db.batch([...pruneStmts, ...upsertStmts]);
    } finally {
      knownDomainsGen.set(db, (knownDomainsGen.get(db) ?? 0) + 1);
      knownDomainsCache.delete(db);
    }
    return entries.length;
  });
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
