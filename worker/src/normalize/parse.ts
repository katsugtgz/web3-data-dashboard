import type { TaskType } from '../../../shared/types';
import { URL_SHORTENERS } from '../safety/shorteners';
import {
  cleanUrl,
  extractSuspiciousRawIpUrls,
  extractUrls,
  extractWrapperSubdomainHint,
  getRegistrableDomain,
  isPlatformDomain,
  PLATFORM_DOMAINS,
} from './domains';
import { FORBIDDEN_CJK_RE, HAN_RE, stripOrTranslateCjk } from './i18n';
import {
  classifyDropRelevance,
  cleanSummaryText,
  detectNonEnglishLatin,
  isStopName,
  MAJOR_TICKERS,
  truncateAtWordBoundary,
} from './text';

export { PLATFORM_DOMAINS, cleanUrl, extractUrls, getRegistrableDomain, isPlatformDomain };

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
  // rewards' never tags TON.
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

// Tightened task patterns: avoid false positives from news articles ("political
// campaign", "ad campaign", "tokenized deposits", "in the form of", "Senate
// passes bill", "daily outflows", "10% hack bounty", "Season 2 of my podcast",
// "Bitcoin validator count").
const TASK_PATTERNS: [TaskType, RegExp][] = [
  ['faucet', /\bfaucet\b|\btest\s*tokens?\b|\bclaim test\b/i],
  ['testnet', /\btestnet\b|\btesnet\b|\bdevnet\b|\bsepolia\b|\bholesky\b/i],
  [
    'quest',
    /\b(?:galxe|zealy|layer3|intract|questn|taskon|soquest|guild\.xyz|quests?)\b|\b(?:airdrop|points?|rewards?|creator|social|incentivized|new)\s+campaign\b|\bjoin\s+(?:the\s+)?[a-z0-9\s]{0,20}campaign\b|\/campaigns?\//i,
  ],
  [
    'waitlist',
    /\b(?:waitlist|whitelist|allowlist|early\s*access|invite\s*code|beta\s*access|wl\b|fill\s+(?:out\s+)?(?:the\s+)?form|google\s+form|waitlist\s+form|application\s+form|submit\s+(?:the\s+)?form)\b|forms\.gle|typeform\.com|tally\.so/i,
  ],
  ['bridge', /\bbridge\b|\bcross-?chain\b/i],
  [
    'stake',
    /\b(?:stak(?:e|ing)|restak(?:e|ing)|delegate|liquidity|lp\s+(?:pool|farm|reward)|deposit\s+(?:eth|sol|usdc|usdt|weth|tokens?|into\s+vault|to\s+earn))\b/i,
  ],
  ['mint', /\b(?:mint|free\s*mint|nft|sbt|soulbound|badge|mint\s+pass|access\s+pass(?:es)?|genesis\s+pass)\b/i],
  [
    'points',
    /(?<!basis\s)(?<!percentage\s)\b(?:points?|xp|epoch\s*\d+|leaderboard|season\s*\d+(?:\s+\S+){0,3}\s+(?:drop|drops|points?|rewards?|airdrop|airdrops|farm(?:ing)?|claim|campaign|quests?|xp|badges?)|(?:drop|drops|points?|rewards?|airdrop|airdrops|farm(?:ing)?|claim|campaign|quests?|xp|badges?)\s+season\s*\d+)\b/i,
  ],
  ['trade', /\b(?:trading\s+competition|perp\s*dex|perps?\s+trading|trade\s+to\s+earn|swap|dex)\b/i],
  [
    'node',
    /\b(?:run\s+a\s+node|run\s+(?:a\s+)?validator|validator\s+(?:testnet|node|rewards?|incentiv\w*)|depin\s+(?:airdrop|testnet|nodes?|farm(?:ing)?|points?|rewards?|earn|mining|campaign)|cli\s+node|docker\s+node|node\s+(?:setup|guide|runner))\b/i,
  ],
  [
    'social',
    /\b(?:follow\s+@|follow\s+[a-z0-9_]+\s+on\s+x|retweet|repost|join\s+(?:our\s+)?(?:discord|telegram)|connect\s+(?:your\s+)?(?:x|twitter|discord)|social\s*(?:task|quest|camp)|daily\s*(?:check-?in|spin|quest|task|crate)|check-?in)\b|discord\.gg/i,
  ],
];

const NON_LATIN_SCRIPT_RE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Thai}]/u;

// Payout/reward currency context preceding a $TICKER (`paid out 100 $HYPE`, `win 50 $SOL`).
const PAYOUT_CURRENCY_PREFIX_RE =
  /\b(?:reward(?:s|\s*pool)?|prize(?:\s*pool)?|paid\s+out|worth|win|bonus|pool|total\s+rewards|with\s+[\d,.]+)\s*[:~]?\s*(?:[\d,.]+[kmb]?\s*)?$/i;

const DOMAIN_VERB_PREFIX_RE = /^(?:get|use|try|join|play|app|go|my|the)(?=[a-z]{4,})/;

export interface ParsedDrop {
  urls: string[];
  rawIpUrls?: string[];
  projectDomain?: string;
  ticker?: string;
  chains: string[];
  taskTypes: TaskType[];
  project: string;
  summary: string;
  isNonLatinSource: boolean;
  isRelevantDrop: boolean;
}

export interface SurfMatch {
  name: string;
  tier?: 'S' | 'A' | 'B' | 'C';
  cardRank?: number;
}

export interface ParseContext {
  knownDomains?: Map<string, string>;
  surfByDomain?: Map<string, SurfMatch>;
  surfByTicker?: Map<string, SurfMatch>;
  sourceLang?: string;
}

export function extractTicker(text: string): string | undefined {
  const re = /\$([A-Z][A-Z0-9]{1,8})\b/g;
  for (const m of text.matchAll(re)) {
    const sym = m[1];
    if (!sym || MAJOR_TICKERS.has(sym)) continue;
    // Skip tickers mentioned purely as payout/prize currency (`193M $HYPE paid out`).
    const idx = m.index ?? 0;
    const before = text.slice(Math.max(0, idx - 45), idx);
    const after = text.slice(idx + m[0].length, idx + m[0].length + 25);
    if (PAYOUT_CURRENCY_PREFIX_RE.test(before) || /^\s*(?:\([^)]*\)\s*)?(?:paid\s+out|in\s+rewards|prize)/i.test(after)) {
      continue;
    }
    return sym;
  }
  return undefined;
}

export function extractChainsFromText(text: string): string[] {
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

function normalizeAlphaNum(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Matches a registrable domain label (e.g. `zeroguys.fun`, `getclocked.com`,
 * `cityprotocol.co`, `decalabs.ai`) against human-cased 1-3 word phrases in the
 * post text so cards display `"Zero Guys"`, `"Clocked"`, `"City Protocol"`,
 * `"DECA Labs"` instead of glued lowercase domain labels.
 */
function matchDomainNameInText(domainOrLabel: string, text: string): string | undefined {
  const rawLabel = domainOrLabel.includes('.') ? (domainOrLabel.split('.')[0] ?? domainOrLabel) : domainOrLabel;
  const target = normalizeAlphaNum(rawLabel);
  if (target.length < 3) return undefined;
  const core = target.replace(DOMAIN_VERB_PREFIX_RE, '');
  const strippedText = text.replace(/https?:\/\/\S+/g, ' ');

  const tokens = strippedText.match(/[A-Za-z0-9][A-Za-z0-9._-]*/g) ?? [];
  for (let i = 0; i < tokens.length; i++) {
    for (let span = 3; span >= 1; span--) {
      if (i + span > tokens.length) continue;
      const slice = tokens.slice(i, i + span);
      // Avoid grabbing lowercase filler phrases; require at least one capitalized token.
      if (!slice.some(tok => /^[A-Z]/.test(tok))) continue;
      const phrase = slice.join(' ');
      const norm = normalizeAlphaNum(phrase);
      if (
        norm === target ||
        (core.length >= 4 && norm === core) ||
        (target.endsWith('s') && norm === target.slice(0, -1)) ||
        (norm.endsWith('s') && norm.slice(0, -1) === target)
      ) {
        if (!isStopName(phrase)) return phrase;
      }
    }
  }
  return undefined;
}

function sanitizeCandidateName(raw: string): string | undefined {
  const stripped = stripOrTranslateCjk(raw)
    .replace(/^[\s*#@:|\-\u2013\u2014]+/, '')
    .replace(/[\s*#@:|\-\u2013\u2014(]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (stripped.length < 2 || stripped.length > 32) return undefined;
  if (isStopName(stripped)) return undefined;
  // Reject names made entirely of stopwords.
  const words = stripped.split(/\s+/);
  if (words.every(w => isStopName(w))) return undefined;
  if (CHAIN_PATTERNS.some(([name]) => name.toUpperCase() === stripped.toUpperCase())) return undefined;
  return stripped;
}

/**
 * Extracts a project name from common Telegram airdrop post headers
 * (`New Waitlist: PLUMBERS`, `TopNod Free Daily Spin`, `Update Psy Testnet`,
 * `#Update please check Topnod result`).
 */
function extractStructuredProjectName(text: string): string | undefined {
  const stripped = text.replace(/https?:\/\/\S+/g, ' ').replace(/\r/g, '');
  const firstLines = stripped
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(' ');

  const patterns: RegExp[] = [
    // "New Waitlist: ZUNKI", "New Airdrops: TopNod Spin & Win", "New Whitelist : De1 Platform"
    /\b(?:New\s+)?(?:Airdrops?|Waitlist|Whitelist|Testnet|Quest|Campaign|Mint|Checker)\s*(?:NFT\s*)?[:|]\s*([A-Z0-9][A-Za-z0-9._-]*(?:\s+[A-Z0-9][A-Za-z0-9._-]*)?)/,
    // "Update Voice New Polls", "Update Psy Tesnet", "Update DAC New Badge"
    /\bUpdate\s+([A-Z][A-Za-z0-9._-]*(?:\s+[A-Z][A-Za-z0-9._-]*)?)(?=\s+(?:New|Quest|Testnet|Tesnet|Airdrop|Campaign|Shutdown|Badge|Checker|Update|Live)\b)/,
    // "TopNod Free Daily Spin", "StrikeLabs Waitlist", "Galxe Shutdown Update"
    /(?:^|[\p{Emoji_Presentation}\s])([A-Z][A-Za-z0-9._-]*(?:\s+[A-Z][A-Za-z0-9._-]*)?)\s+(?:Waitlist|Whitelist|Testnet|Tesnet|Airdrop|Quest|Faucet|Mint|Campaign|Early\s+Access|Checker|Shutdown|Bounty|Free\s+Daily\s+Spin|Spin\s*&\s*Win)\b/u,
    // "#Update please check Topnod result and claim"
    /\b(?:check|claim)\s+([A-Z][A-Za-z0-9._-]{2,20})\s+(?:result|rewards?|airdrop|eligibility|allocation|checker)\b/i,
  ];

  for (const re of patterns) {
    const m = firstLines.match(re);
    if (!m?.[1]) continue;
    const candidate = sanitizeCandidateName(m[1]);
    if (candidate) return candidate;
  }
  return undefined;
}

function guessCapitalizedToken(text: string): string | undefined {
  const stripped = text.replace(/https?:\/\/\S+/g, ' ');
  const matches = stripped.match(/\b[A-Z][A-Za-z0-9]{2,20}\b/g) ?? [];
  for (const tok of matches) {
    if (isStopName(tok)) continue;
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
  sourceLang?: string,
): { summary: string; isNonLatin: boolean } {
  const hasNonLatin = HAN_RE.test(text) || FORBIDDEN_CJK_RE.test(text) || NON_LATIN_SCRIPT_RE.test(text);
  const cleaned = cleanSummaryText(text, sourceLang);
  const isNonEnglishLatin = !hasNonLatin && detectNonEnglishLatin(cleaned, sourceLang);
  const needsTranslation = hasNonLatin || isNonEnglishLatin;

  if (!cleaned || hasNonLatin || isNonEnglishLatin) {
    const tasksText = taskTypes.join(', ');
    const chainsText = chains.length > 0 ? ` on ${chains.join(', ')}` : '';
    const safeProject = stripOrTranslateCjk(project) || 'Web3 Project';
    return {
      summary: truncateAtWordBoundary(`${safeProject}: ${tasksText}${chainsText}`, 195),
      isNonLatin: needsTranslation,
    };
  }

  return {
    summary: truncateAtWordBoundary(cleaned, 195),
    isNonLatin: false,
  };
}

export function parseDropPost(text: string, htmlUrls: string[] = [], ctx: ParseContext = {}): ParsedDrop {
  const urls = extractUrls(text, htmlUrls);
  const rawIpUrls = extractSuspiciousRawIpUrls(text, htmlUrls);
  let projectDomain: string | undefined;
  let wrapperHint: string | undefined;

  for (const u of urls) {
    const dom = getRegistrableDomain(u);
    if (!dom || URL_SHORTENERS[dom]) continue;
    if (!wrapperHint) {
      wrapperHint = extractWrapperSubdomainHint(u);
    }
    if (isPlatformDomain(dom)) continue;
    projectDomain = dom;
    break;
  }

  const ticker = extractTicker(text);
  const chains = extractChainsFromText(text);
  const taskTypes = extractTaskTypes(text, urls);

  // A domain-identified post keeps its identity: a $TICKER pointing at a
  // different surf card must not rename it.
  const surfMatch =
    (projectDomain && ctx.surfByDomain?.get(projectDomain)) ||
    (!projectDomain && ticker && ctx.surfByTicker?.get(ticker)) ||
    undefined;

  const domainTextMatch = projectDomain ? matchDomainNameInText(projectDomain, text) : undefined;
  const wrapperTextMatch = !projectDomain && wrapperHint ? matchDomainNameInText(wrapperHint, text) : undefined;
  const structuredName = !projectDomain ? extractStructuredProjectName(text) : undefined;

  const rawProject =
    surfMatch?.name ||
    (projectDomain && ctx.knownDomains?.get(projectDomain)) ||
    domainTextMatch ||
    (projectDomain && titleFromDomain(projectDomain)) ||
    wrapperTextMatch ||
    (wrapperHint && titleFromDomain(wrapperHint)) ||
    structuredName ||
    guessCapitalizedToken(text) ||
    (ticker ? `$${ticker}` : 'Web3 Project');

  const project = stripOrTranslateCjk(rawProject) || 'Web3 Project';

  const { summary, isNonLatin } = buildRuleSummary(text, project, taskTypes, chains, ctx.sourceLang);

  const relevance = classifyDropRelevance({
    text,
    urls,
    projectDomain,
    taskTypes,
    hasSurfMatch: Boolean(surfMatch),
  });

  return {
    urls,
    rawIpUrls,
    projectDomain,
    ticker,
    chains,
    taskTypes,
    project,
    summary,
    isNonLatinSource: isNonLatin,
    isRelevantDrop: relevance.isDrop,
  };
}
