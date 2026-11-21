import type { AirdropFeed, MarketSection, RiskLevel } from '../../../shared/types';
import { getRegistrableDomain, isPlatformDomain } from '../normalize/parse';

export const URL_SHORTENERS = new Set([
  'bit.ly',
  't.co',
  'tinyurl.com',
  'cutt.ly',
  'rb.gy',
  'is.gd',
  'ow.ly',
  'goo.gl',
  'shorturl.at',
]);

// Wallet-drain phrasing: require the scam-specific shape (a claim promise
// gated behind connecting a wallet, or an eligibility check that asks for
// wallet validation). Plain 'claim now' / 'seed phrase' in security warnings
// and ordinary airdrop announcements must NOT match, or legit posts get hidden.
export const DRAINER_RE =
  /claim (?:now|your)[^.!?]*\b(?:connect|wallet)\b|connect (?:your )?wallet to (?:claim|receive|check)|eligib\w+ .*(?:verify|validate) wallet|airdrop is live[^.!?]*claim/i;

export const KNOWN_QUEST_PLATFORMS: [string, string][] = [
  ['galxe.com', 'Galxe'],
  ['app.galxe.com', 'Galxe'],
  ['zealy.io', 'Zealy'],
  ['layer3.xyz', 'Layer3'],
  ['intract.io', 'Intract'],
  ['guild.xyz', 'Guild'],
  ['questn.com', 'QuestN'],
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
    for (const d of input.platformDomains) lookalikeBaseline.set(d, 'platform');
  }

  const bump = (next: RiskLevel, reason: string) => {
    reasons.add(reason);
    if (next === 'risk') level = 'risk';
    else if (next === 'warn' && level === 'ok') level = 'warn';
  };

  for (const u of input.urls) {
    try {
      const host = new URL(u).hostname.toLowerCase();
      if (isPunycodeOrMixedScript(host)) {
        bump('risk', `Punycode or mixed-script domain: ${host}`);
      }
      const reg = getRegistrableDomain(u);
      // Shorteners hide the real destination: always at least a warning.
      if (reg && URL_SHORTENERS[reg]) {
        bump('warn', `URL shortener used: ${reg}`);
      }
      if (reg && !isPlatformDomain(reg) && !URL_SHORTENERS[reg]) {
        const similar = findLookalikeDomain(reg, input.knownProjectDomains);
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

  if (input.domain && !isPlatformDomain(input.domain)) {
    if (isPunycodeOrMixedScript(input.domain)) {
      bump('risk', `Punycode or mixed-script project domain: ${input.domain}`);
    } else {
      const similar = findLookalikeDomain(input.domain, input.knownProjectDomains);
      if (similar) {
        bump('risk', `Possible lookalike domain (${input.domain} vs ${similar})`);
      } else if (!input.knownProjectDomains.has(input.domain.toLowerCase())) {
        bump('warn', `Domain not in verified registry: ${input.domain}`);
      }
    }
  }

  if (input.trustMax < 0.4 && input.sourceCount <= 1) {
    bump('warn', 'Single low-trust source');
  }

  return { level, reasons: [...reasons] };
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
        if (!dom || isPlatformDomain(dom) || URL_SHORTENERS.has(dom)) continue;
        if (!map.has(dom)) map.set(dom, { domain: dom, project: card.n, origin: 'surf' });
      }
    }
  }

  if (defiSection) {
    for (const row of defiSection.rows) {
      if (!row.href) continue;
      const dom = getRegistrableDomain(row.href);
      if (!dom || isPlatformDomain(dom) || URL_SHORTENERS.has(dom)) continue;
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
  await Promise.all(chunks);
  return entries.length;
}

export interface KnownDomainsLoaded {
  projectDomains: Map<string, string>;
  allKnownDomains: Set<string>;
  /** Platform domains (Galxe, Zealy, …) live only here: known for the feed's
   *  `known` link flag and as lookalike targets, never trusted as project
   *  identity (impersonations of these must still be flagged). */
  platformDomains: Set<string>;
}

export async function loadKnownDomains(db: D1Database): Promise<KnownDomainsLoaded> {
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
  return { projectDomains, allKnownDomains, platformDomains };
}
