import type { TaskType } from '../../../shared/types';
import { HAN_RE } from './i18n';
import { URL_SHORTENERS } from '../safety/shorteners';

export const PLATFORM_DOMAINS = new Set<string>([
  't.me',
  'x.com',
  'twitter.com',
  'youtube.com',
  'youtu.be',
  'medium.com',
  'discord.gg',
  'discord.com',
  'linktr.ee',
  'galxe.com',
  'zealy.io',
  'layer3.xyz',
  'app.galxe.com',
  'docs.google.com',
  'google.com',
  'forms.gle',
  'github.com',
  'notion.site',
  'mirror.xyz',
  'substack.com',
  'intract.io',
  'questn.com',
  'guild.xyz',
]);

// ponytail: curated slice of the Public Suffix List — just the common
// multipart suffixes feed URLs actually use. Ceiling: a full vendored PSL
// (publicsuffix.org list, refreshed at build time); upgrade when an exotic
// ccTLD merges unrelated projects. Unknown suffixes fall back to
// last-two-labels.
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

const CHAIN_PATTERNS: [string, RegExp][] = [
  ['Ethereum', /\b(?:ethereum|eth mainnet|erc-?20)\b/i],
  // base/scroll/blast/abstract/movement/arb are English words: bare matches
  // false-tagged 'scroll down to claim', 'knowledge base'. They need a chain
  // qualifier (X chain / on X / $X); unambiguous names stay bare.
  ['Base', /\bbase\s+(?:chain|mainnet|testnet|network|ecosystem)|\bon base\b|\$base\b/i],
  ['Arbitrum', /\barbitrum\b|\barb\s+(?:chain|mainnet|network|ecosystem)|\bon arb\b|\$arb\b/i],
  ['Optimism', /\boptimism\b|\bop mainnet\b/i],
  ['Solana', /\bsolana\b|\bspl\b/i],
  ['BNB', /\bbnb\s*(?:chain|smart chain)?\b|\bbsc\b/i],
  ['Sui', /\bsui\b/i],
  ['Aptos', /\baptos\b/i],
  ['Monad', /\bmonad\b/i],
  ['Berachain', /\bberachain\b|\bbera\b/i],
  ['HyperEVM', /\bhyperevm\b|\bhyperliquid\b/i],
  ['Starknet', /\bstarknet\b/i],
  ['zkSync', /\bzksync\b/i],
  ['Linea', /\blinea\b/i],
  ['Scroll', /\bscroll\s+(?:chain|mainnet|testnet|network|ecosystem)|\bon scroll\b|\$scroll\b/i],
  ['Polygon', /\bpolygon\b|\bmatic\b/i],
  // The coin/network phrases need case-insensitivity ('Toncoin', 'Telegram
  // Open Network'); the bare ticker stays uppercase-only so 'a ton of
  // rewards' never tags TON. The first row carries /i for phrases; extract
  // dedupes chain names, so the second row never doubles the entry.
  ['TON', /\btoncoin\b|\bton ?(?:blockchain|network)\b|\btelegram open network\b/i],
  ['TON', /\bTON\b/],
  ['Sei', /\bsei\b(?:\s+(?:network|chain))?/i],
  ['Injective', /\binjective\b/i],
  ['Celestia', /\bcelestia\b|\btia\b/i],
  ['Avalanche', /\bavalanche\b|\bavax\b/i],
  ['Mantle', /\bmantle\b/i],
  ['Blast', /\bblast\s+(?:chain|mainnet|testnet|network|ecosystem)|\bon blast\b|\$blast\b/i],
  ['Abstract', /\babstract\s+(?:chain|mainnet|testnet|network|ecosystem)|\bon abstract\b/i],
  ['Sonic', /\bsonic\b/i],
  ['MegaETH', /\bmegaeth\b/i],
  ['Initia', /\binitia\b/i],
  ['Movement', /\bmovement\s+(?:chain|mainnet|testnet|network|ecosystem)|\bon movement\b|\$move\b/i],
];

const TASK_PATTERNS: [TaskType, RegExp][] = [
  ['faucet', /\bfaucet\b|\btest\s*tokens?\b|\bclaim test\b/i],
  ['testnet', /\btestnet\b|\bdevnet\b|sepolia|holesky/i],
  ['quest', /\b(?:galxe|zealy|layer3|intract|questn|guild|quest|campaign|bounty)\b/i],
  ['waitlist', /\b(?:waitlist|whitelist|early access|invite code|beta access|form)\b/i],
  ['bridge', /\bbridge\b|cross-?chain/i],
  ['stake', /\b(?:stak(?:e|ing)|restak(?:e|ing)|deposit|delegate|lp|liquidity)\b/i],
  ['mint', /\b(?:mint|nft|sbt|badge|pass)\b/i],
  ['points', /\b(?:points?|xp|season\s*\d+|epoch|leaderboard)\b/i],
  ['trade', /\b(?:trade|trading|swap|perp|perps|volume|dex)\b/i],
  ['node', /\b(?:node|validator|depin|cli|docker|run a node)\b/i],
  ['social', /\b(?:follow|retweet|repost|discord|telegram|social|check-?in|daily)\b/i],
];

const STOP_NAMES = new Set([
  'THE', 'THIS', 'THAT', 'NEW', 'FREE', 'AIRDROP', 'TESTNET', 'MAINNET', 'CLAIM', 'HOW', 'HERE', 'JOIN',
  'UPDATE', 'ALERT', 'LIVE', 'NOW', 'CHECK', 'GUIDE', 'TASK', 'TASKS', 'REWARD', 'REWARDS', 'TOKEN',
  'TOKENS', 'POINTS', 'SEASON', 'OFFICIAL', 'LINK', 'LINKS', 'CRYPTO', 'WEB3', 'HTTP', 'HTTPS',
]);

const NON_LATIN_SCRIPT_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Thai}]/u;

export interface ParsedDrop {
  urls: string[];
  projectDomain?: string;
  ticker?: string;
  chains: string[];
  taskTypes: TaskType[];
  project: string;
  summary: string;
  isNonLatinSource: boolean;
}

export interface SurfMatch {
  name: string;
  tier?: 'S' | 'A' | 'B' | 'C';
  cardRank?: number;
}

export function cleanUrl(raw: string): string | null {
  try {
    // Trailing text glued to the last path segment (CJK-adjacent posts emit
    // `.../status/<id>Update` — the bare-URL regex cannot know where the link
    // ends) and percent-encoded non-ASCII decoration (`.../103153%F0%9F%8F%82`
    // → dead pages) both survive into the feed without this trim.
    // ponytail: targets the observed shapes (pure-digit final segment with
    // alphanumeric glue, ≥8 digits to skip `/page-2`-style slugs and version
    // paths like /v2/12345abc; trailing %XX runs — percent-encoded non-ASCII
    // never appears in a real link the bare-URL regex can capture). A real
    // URL-token extractor over the post text is the full fix if a third
    // shape appears.
    let cleaned = raw.trim().replace(/[),.;!?]+$/, '');
    const path = cleaned.split(/[?#]/)[0];
    const lastSeg = path.slice(path.lastIndexOf('/') + 1);
    const m = lastSeg.match(/^(\d{8,})([A-Za-z][A-Za-z0-9]*)$/);
    if (m) {
      cleaned = cleaned.slice(0, cleaned.lastIndexOf(lastSeg)) + m[1] + cleaned.slice(cleaned.lastIndexOf(lastSeg) + lastSeg.length);
    }
    cleaned = cleaned.replace(/(?:%[0-9A-Fa-f]{2})+$/, '');
    const u = new URL(cleaned);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    for (const key of [...u.searchParams.keys()]) {
      if (/^(?:utm_|fbclid|gclid|igshid|si$|ref_)/i.test(key)) {
        u.searchParams.delete(key);
      }
    }
    return u.toString();
  } catch {
    return null;
  }
}

export function extractUrls(text: string, htmlUrls: string[] = []): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const bareMatches = text.match(/https?:\/\/[^\s<>"'`]+/gi) ?? [];

  for (const raw of [...htmlUrls, ...bareMatches]) {
    const normalized = cleanUrl(raw);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  }
  return out;
}

export function getRegistrableDomain(rawUrl: string): string | undefined {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, '');
    if (!host || !host.includes('.')) return undefined;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return host;
    const parts = host.split('.');
    if (parts.length <= 2) return host;
    const lastTwo = parts.slice(-2).join('.');
    if (MULTI_PART_TLDS.has(lastTwo) && parts.length >= 3) {
      return parts.slice(-3).join('.');
    }
    return lastTwo;
  } catch {
    return undefined;
  }
}

export function isPlatformDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  if (PLATFORM_DOMAINS.has(d)) return true;
  for (const plat of PLATFORM_DOMAINS) {
    if (d.endsWith(`.${plat}`)) return true;
  }
  return false;
}

export function extractTicker(text: string): string | undefined {
  const m = text.match(/\$([A-Z][A-Z0-9]{1,9})\b/);
  if (!m) return undefined;
  const sym = m[1];
  if (sym === 'USD' || sym === 'USDT' || sym === 'USDC') return undefined;
  return sym;
}

export function extractChainsFromText(text: string): string[] {
  // A chain can be matched by several rows (TON phrases + bare ticker); keep
  // one entry per chain name, in CHAIN_PATTERNS order.
  const chains = new Set<string>();
  for (const [name, re] of CHAIN_PATTERNS) {
    if (re.test(text)) chains.add(name);
  }
  return [...chains];
}

export function extractTaskTypes(text: string, urls: string[]): TaskType[] {
  const combined = `${text}\n${urls.join(' ')}`;
  const types: TaskType[] = [];
  for (const [type, re] of TASK_PATTERNS) {
    if (re.test(combined)) types.push(type);
  }
  if (types.length === 0) types.push('other');
  return types;
}

function titleFromDomain(domain: string): string {
  const label = domain.split('.')[0] ?? domain;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function guessCapitalizedToken(text: string): string | undefined {
  const stripped = text.replace(/https?:\/\/\S+/g, ' ');
  const matches = stripped.match(/\b[A-Z][A-Za-z0-9]{2,20}\b/g) ?? [];
  for (const tok of matches) {
    if (STOP_NAMES.has(tok.toUpperCase())) continue;
    if (CHAIN_PATTERNS.some(([name]) => name.toUpperCase() === tok.toUpperCase())) continue;
    return tok;
  }
  return undefined;
}

export function buildRuleSummary(
  text: string,
  project: string,
  taskTypes: TaskType[],
  chains: string[],
): { summary: string; isNonLatin: boolean } {
  const cleaned = text
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const hasNonLatin = HAN_RE.test(cleaned) || NON_LATIN_SCRIPT_RE.test(cleaned);
  if (!cleaned || hasNonLatin) {
    const tasksText = taskTypes.join(', ');
    const chainsText = chains.length > 0 ? ` on ${chains.join(', ')}` : '';
    return {
      summary: `${project}: ${tasksText}${chainsText}`.slice(0, 200),
      isNonLatin: hasNonLatin,
    };
  }

  // Code-point truncation: UTF-16 slice could split an emoji surrogate pair
  // and leave a lone surrogate at the end of the summary.
  return {
    summary: cleaned.length > 200 ? `${[...cleaned].slice(0, 197).join('')}…` : cleaned,
    isNonLatin: false,
  };
}

export interface ParseContext {
  knownDomains?: Map<string, string>;
  surfByDomain?: Map<string, SurfMatch>;
  surfByTicker?: Map<string, SurfMatch>;
}

export function parseDropPost(text: string, htmlUrls: string[] = [], ctx: ParseContext = {}): ParsedDrop {
  const urls = extractUrls(text, htmlUrls);
  let projectDomain: string | undefined;
  for (const u of urls) {
    const dom = getRegistrableDomain(u);
    // Shorteners point anywhere: they must never become the cluster identity,
    // or every post sharing one shortener collapses into a single cluster.
    if (!dom || isPlatformDomain(dom) || URL_SHORTENERS[dom]) continue;
    projectDomain = dom;
    break;
  }

  const ticker = extractTicker(text);
  const chains = extractChainsFromText(text);
  const taskTypes = extractTaskTypes(text, urls);

  // A domain-identified post keeps its identity: a $TICKER pointing at a
  // different surf card must not rename it. Ticker fallback only applies
  // when no project domain was identified.
  const surfMatch =
    (projectDomain && ctx.surfByDomain?.get(projectDomain)) ||
    (!projectDomain && ticker && ctx.surfByTicker?.get(ticker)) ||
    undefined;

  // Domain-derived name outranks a capitalized filler word from the text:
  // 'Hey degens ... https://foo.xyz' must become "Foo", not "Hey". The surf
  // match and the registry still take precedence (they are verified names).
  const project =
    surfMatch?.name ||
    (projectDomain && ctx.knownDomains?.get(projectDomain)) ||
    (projectDomain && titleFromDomain(projectDomain)) ||
    guessCapitalizedToken(text) ||
    (ticker ? `$${ticker}` : 'Web3 Project');

  const { summary, isNonLatin } = buildRuleSummary(text, project, taskTypes, chains);

  return {
    urls,
    projectDomain,
    ticker,
    chains,
    taskTypes,
    project,
    summary,
    isNonLatinSource: isNonLatin,
  };
}
