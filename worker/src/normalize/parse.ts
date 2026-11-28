import type { TaskType } from '../../../shared/types';
import { isGamblingPost } from '../../../shared/gamblingFilter';
import { DOUBLING_SCAM_RE, DRAINER_RE } from '../safety';
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
  stripEmoji,
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

/**
 * Structured, deterministic drop metadata extracted from the post text.
 * All fields are optional plain display strings; `steps` holds at most 4 entries.
 */
export interface RichDropMeta {
  rewardPool?: string;
  deadline?: string;
  cost?: string;
  steps?: string[];
}

export interface ParsedDrop extends RichDropMeta {
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
  logo?: string;
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

// Acronyms and brand words that keep their own casing after a split.
const LABEL_CASING: Record<string, string> = {
  rgb: 'RGB', nft: 'NFT', nfts: 'NFTs', dex: 'DEX', dao: 'DAO', ai: 'AI', btc: 'BTC', eth: 'ETH', defi: 'DeFi',
  zksync: 'zkSync', dydx: 'dYdX', l1: 'L1', l2: 'L2', evm: 'EVM', usd: 'USD', usdc: 'USDC', usdt: 'USDT', tvl: 'TVL',
  apr: 'APR', apy: 'APY', pfp: 'PFP', sbt: 'SBT', rwa: 'RWA', ido: 'IDO', ico: 'ICO', api: 'API', sdk: 'SDK', gm: 'GM',
};

// Words that can split a glued registrable label: `lawoftheabyss` -> `Law Of The Abyss`,
// `rgbstone` -> `RGB Stone`. Kept to nouns and a few function words on purpose;
// an unknown label stays one word.
const LABEL_SPLIT_WORDS = new Set(
  (
    // Function words (useful only inside three-plus-word labels).
    'of the to in on by my at up for and all out ' +
    // Web3 and product vocabulary.
    'chain coin token money bank pay swap stake pool farm mine mint vault forge block protocol finance ' +
    'network web app lab labs hub base core main genesis origin node wallet ledger book data code byte ' +
    'point points trade market exchange fund funds grant yield earn win drop drops gift prize reward rewards ' +
    'bonus loot treasure budget squad crew club house home studio team group union pact ' +
    // Plain English nouns and adjectives that show up in project names.
    'law abyss stone rock star moon sun sky sea ocean deep wave waves fire ice snow rain wind storm cloud ' +
    'light shadow dark bright blue green gold silver iron steel city island land world zone space gate bridge ' +
    'path road magic pixel cube game play quest dragon wolf bear bull whale shark frog ape cat dog fox owl bee ' +
    'ant bird snake king queen hero legend titan giant guys soul mind brain smart wise key lock clock strike ' +
    'force power energy pulse flux drift echo voice sound signal speed turbo hyper mega ultra super cyber meta ' +
    'virtual digital future frontier edge apex peak summit prime royal noble holy sacred eternal infinite ' +
    'quantum atom atoms orbit comet planet rocket ship journey mission guide compass map scout ranger hunter ' +
    'wizard witch knight angel ghost phantom demon devil monster beast eagle hawk raven crow lion tiger horse ' +
    'pony rabbit deer duck goose crane swan fish octopus crab turtle cobra viper spider beetle moth butterfly ' +
    'plaza garden flower tree leaf root seed wood forest river mountain valley desert wall street survival crypto ' +
    'crystal pearl gem amber jade ruby obsidian neon chrome carbon helium hydrogen oxygen plasma photon ' +
    'neutron proton electron drone robot droid machine engine motor gear wheel pilot captain sailor voyager voyage ' +
    'alpha omega zero one two ten first last next big small little great grand top free open safe secure fast ' +
    'quick slow wild brave bold true real rich lucky wealth fortune page story tale song art ink line ring loop ' +
    'port harbor bay cape reef coral jack'
  )
    .split(/\s+/)
    .concat(Object.keys(LABEL_CASING))
    .filter(word => /^[a-z0-9]{2,}$/.test(word)),
);

/**
 * Splits a lowercase glued label into dictionary words with the fewest parts
 * (longest words first on ties). Short labels, labels with digits, and timid
 * two-word splits are left alone, which protects brand names such as `bitget`,
 * `coinbase`, `stargate`, or `topnod`.
 */
function splitLabelWords(label: string): string[] | undefined {
  if (label.length < 8 || label.length > 32 || /\d/.test(label)) return undefined;
  const n = label.length;
  const best = new Array<number>(n + 1).fill(Infinity);
  const prev = new Array<number>(n + 1).fill(-1);
  best[0] = 0;
  for (let i = 0; i < n; i++) {
    const base = best[i];
    if (!Number.isFinite(base)) continue;
    for (let j = Math.min(n, i + 14); j > i + 1; j--) {
      const word = label.slice(i, j);
      if (!LABEL_SPLIT_WORDS.has(word)) continue;
      const cost = base + 1 + 1 / (word.length + 2);
      if (cost < best[j]) {
        best[j] = cost;
        prev[j] = i;
      }
    }
  }
  if (!Number.isFinite(best[n])) return undefined;
  const parts: string[] = [];
  for (let end = n; end > 0; ) {
    const start = prev[end] ?? -1;
    if (start < 0) return undefined;
    parts.unshift(label.slice(start, end));
    end = start;
  }
  if (parts.length < 2 || parts.length > 5) return undefined;
  if (parts.length === 2) {
    // A two-word split is trusted only with an acronym head (`rgbstone`) or two long words (`coinisland`).
    const head = parts[0] ?? '';
    const tail = parts[1] ?? '';
    const confident =
      LABEL_CASING[head] !== undefined || (label.length >= 10 && head.length >= 4 && tail.length >= 4);
    if (!confident) return undefined;
  }
  return parts;
}

/** Turns a registrable domain or wrapper label into a readable project name. */
function titleFromDomain(domainOrLabel: string): string {
  const raw = domainOrLabel.includes('.') ? (domainOrLabel.split('.')[0] ?? domainOrLabel) : domainOrLabel;
  const name = raw
    .toLowerCase()
    .split(/[-_]+/)
    .map(part => {
      const words = splitLabelWords(part) ?? [part];
      if (words.length === 1) {
        const word = words[0] ?? part;
        // `zklend` -> `zkLend`: the zk prefix is written in camel case by convention.
        if (/^zk[a-z]{3,}$/.test(word)) return `zk${word.charAt(2).toUpperCase()}${word.slice(3)}`;
      }
      return words.map(w => LABEL_CASING[w] ?? w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    })
    .filter(Boolean)
    .join(' ');
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function normalizeAlphaNum(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Matches a registrable domain label (e.g. `zeroguys.fun`, `getclocked.com`,
 * `cityprotocol.co`, `decalabs.ai`) against human-cased 1-5 word phrases in the
 * post text so cards display `"Zero Guys"`, `"Clocked"`, `"City Protocol"`,
 * `"DECA Labs"` instead of glued lowercase domain labels. A glued single token
 * (`Lawoftheabyss`, `RGBSTONE`) is split into words; author camel case
 * (`MagicBlock`, `StrikeLabs`) is kept as written.
 */
function matchDomainNameInText(domainOrLabel: string, text: string): string | undefined {
  const rawLabel = domainOrLabel.includes('.') ? (domainOrLabel.split('.')[0] ?? domainOrLabel) : domainOrLabel;
  const target = normalizeAlphaNum(rawLabel);
  if (target.length < 3) return undefined;
  const core = target.replace(DOMAIN_VERB_PREFIX_RE, '');
  const strippedText = text.replace(/https?:\/\/\S+/g, ' ');

  const tokens = strippedText.match(/[A-Za-z0-9][A-Za-z0-9._-]*/g) ?? [];
  for (let i = 0; i < tokens.length; i++) {
    // Longest phrase first, so `The Big Book Of Crypto` wins over its tail.
    for (let span = 5; span >= 1; span--) {
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
        if (isStopName(phrase)) continue;
        const token = slice[0] ?? phrase;
        // Only a glued single token that spells the whole label is re-cased.
        if (slice.length === 1 && norm === target && !/[a-z0-9][A-Z]/.test(token)) {
          const split = titleFromDomain(target);
          if (split !== token && !isStopName(split)) return split;
        }
        return phrase;
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
      summary: truncateAtWordBoundary(`${safeProject}: ${tasksText}${chainsText}`),
      isNonLatin: needsTranslation,
    };
  }

  return {
    summary: truncateAtWordBoundary(cleaned),
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

  const isGambling = isGamblingPost({ project, domain: projectDomain, text, urls });
  const relevance = isGambling
    ? { isDrop: false, reason: 'gambling-or-betting' }
    : classifyDropRelevance({
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
    // Only relevant drops carry structured metadata; noise is never persisted.
    ...(relevance.isDrop ? extractRichMetadata(text) : {}),
  };
}

// ---------------------------------------------------------------------------
// Structured drop metadata: reward pool, deadline, cost, and task steps.
// Everything here is a deterministic regex extraction over the raw post text.
// ---------------------------------------------------------------------------

// Reward amounts: `$500K`, `$1.2M`, `$50,000`, `10M $TOKEN`, `2% of total supply`, `50,000 USDC`.
const REWARD_AMOUNT_RE =
  /\$\s?\d[\d.,]*\s?[kmb]?(?![a-z])|\d[\d.,]*\s?[kmb]?\s+\$[A-Z][A-Z0-9]{1,9}\b|\d+(?:\.\d+)?\s*%\s*(?:of\s+)?(?:the\s+)?(?:total\s+|token\s+|genesis\s+)?supply|\d[\d.,]*\s?[kmb]?\s+(?:usdc|usdt|usd|dai|eth|sol|btc|bnb|ton|sui|matic|arb|op|avax|ftm|near|apt|sei|tia|hype)\b/gi;

// A reward amount counts only next to reward language; `Raised $12M` is funding, not a pool.
const REWARD_CONTEXT_BEFORE_RE =
  /\b(?:reward|prize|airdrop|giveaway|incentive|grant|trading|liquidity|mining|staking)s?\s+pool\b|\bpool\b|\btotal\s+rewards?\b|\brewards?\s+(?:worth|of)\b|\bworth\b|\bup\s+(?:to|for\s+grabs)\b|\bgiveaway\b|\bairdrop\b|\bdrops?\b|\bgenesis\b|\ballocation\b|\brewards?\b|\bprizes?\b|\bgrand\s+prize\b|\bbudget\b|\bincentives?\b|\bwin\b|\bearns?\b|\bpaid\s+out\b|\bpayout\b|\bbacked\s+by\b|\bfunded\b[^.;:\n]{0,14}$/i;
const REWARD_CONTEXT_AFTER_RE =
  /^\s*(?:usd|usdc|usdt|tokens?|points?)?\s*(?:in\s+)?(?:reward|prize|airdrop|trading|liquidity|mining|staking)\s+pool\b|^\s*(?:in\s+)?rewards?\b|^\s+(?:airdrop|giveaway|prizes?|grand\s+prize)\b|^\s+supply\b/i;

function trimToClauseBefore(raw: string): string {
  const parts = raw.split(/[\n;!?·•|]|\.(?=\s)/);
  return parts[parts.length - 1] ?? '';
}

function trimToClauseAfter(raw: string): string {
  const parts = raw.split(/[\n;!?·•|]|\.(?=\s|$)/);
  return parts[0] ?? '';
}

function extractRewardPool(text: string): string | undefined {
  for (const match of text.matchAll(REWARD_AMOUNT_RE)) {
    const start = match.index ?? 0;
    const before = trimToClauseBefore(text.slice(Math.max(0, start - 32), start));
    const after = trimToClauseAfter(text.slice(start + match[0].length, start + match[0].length + 24));
    if (!REWARD_CONTEXT_BEFORE_RE.test(before) && !REWARD_CONTEXT_AFTER_RE.test(after)) continue;

    const percent = match[0].match(/(\d+(?:\.\d+)?)\s*%\s*(?:of\s+)?(?:the\s+)?(?:total\s+|token\s+|genesis\s+)?supply$/i);
    if (percent) return `${percent[1]}% supply`;
    return match[0]
      .replace(/\$\s+/g, '$')
      .replace(/\s+/g, ' ')
      .replace(/(\d)\s*([kmb])(?![a-z])/gi, (_m, digit: string, suffix: string) => digit + suffix.toUpperCase())
      .trim();
  }
  return undefined;
}

const MONTH_SRC =
  '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const WEEKDAY_SRC = '(?:mon|tues|wednes|thurs|fri|satur|sun)day';
// Absolute values are returned as written; relative ones keep their keyword (`Ends Friday`).
const RELATIVE_DEADLINE_VALUE_RE = new RegExp(
  `^(?:today|tonight|tomorrow|tmrw|eod|eof|end\\s+of|this\\s+|next\\s+|q[1-4](?:\\s|$)|${WEEKDAY_SRC}$)`,
  'i',
);
const DEADLINE_RE = new RegExp(
  `\\b(end\\s+date|closing\\s+date|deadline|last\\s+call|last\\s+chance|last\\s+day|final\\s+day|time\\s+left|cut\\s*-\\s*off|cutoff|runs\\s+until|ending|ends?|closing|closes?|expiring|expires?|lasting|lasts?|until|till|before|within|through|hurry|due|only|by)\\b` +
    `(?:\\s*(?:[:=]|\\b(?:in|on|at|by|until|before|the|this|of|around)\\b))?\\s*` +
    `(\\d{4}-\\d{2}-\\d{2}|${MONTH_SRC}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?|\\d{1,2}\\s+${MONTH_SRC}(?:,?\\s+\\d{4})?|${MONTH_SRC}\\s+20\\d{2}|\\d{1,3}\\s*-\\s*\\d{1,3}\\s*h|\\d{1,3}\\s*(?:h|hr|hrs)\\b|(?:\\d+|a|an|one|two|three|few|several|couple\\s+of)\\s+(?:hours?|hrs?|days?|weeks?)\\b|today|tonight|tomorrow|tmrw|eod|eof|end\\s+of\\s+(?:day|week|month|year|quarter)|this\\s+(?:week|month|year|${WEEKDAY_SRC})|next\\s+(?:week|month|year|${WEEKDAY_SRC})|${WEEKDAY_SRC}|q[1-4](?:\\s*20\\d{2})?)`,
  'gi',
);
const EXPLICIT_DEADLINE_KEYWORDS = new Set([
  'end date', 'closing date', 'deadline', 'last call', 'last chance', 'last day', 'final day',
  'time left', 'cutoff', 'cut-off', 'runs until', 'ending', 'end', 'ends', 'closing', 'close',
  'closes', 'expiring', 'expire', 'expires', 'due',
]);
const DEADLINE_KEYWORD_CANON: Record<string, string> = {
  'end date': 'End date', 'closing date': 'Closing date', deadline: 'Deadline', 'last call': 'Last call',
  'last chance': 'Last chance', 'last day': 'Last day', 'final day': 'Final day', 'time left': 'Time left',
  cutoff: 'Cutoff', 'cut-off': 'Cutoff', 'runs until': 'Runs until', ending: 'Ends', end: 'Ends', ends: 'Ends',
  closing: 'Closes', close: 'Closes', closes: 'Closes', expiring: 'Expires', expire: 'Expires',
  expires: 'Expires', lasting: 'Lasts', last: 'Lasts', lasts: 'Lasts', until: 'Until', till: 'Till',
  before: 'Before', within: 'Within', through: 'Through', hurry: 'Hurry', due: 'Due', only: 'Only', by: 'By',
};

function extractDeadline(text: string): string | undefined {
  let chosen: RegExpMatchArray | null = null;
  for (const match of text.matchAll(DEADLINE_RE)) {
    if (!chosen) chosen = match;
    const kw = (match[1] ?? '').toLowerCase().replace(/\s+/g, ' ');
    if (EXPLICIT_DEADLINE_KEYWORDS.has(kw)) {
      chosen = match;
      break;
    }
  }
  if (!chosen) return undefined;
  const keyword = (chosen[1] ?? '').toLowerCase().replace(/\s+/g, ' ');
  const value = (chosen[2] ?? '').replace(/\s+/g, ' ').trim();
  if (RELATIVE_DEADLINE_VALUE_RE.test(value)) {
    const label =
      DEADLINE_KEYWORD_CANON[keyword] ?? keyword.charAt(0).toUpperCase() + keyword.slice(1);
    return truncateAtWordBoundary(`${label} ${value}`, 40);
  }
  return truncateAtWordBoundary(value, 40);
}

// Costs, most specific first: an explicit price label, a stake/deposit requirement,
// gas-only wording, free entry, and a zero price. No wording means no cost field.
const COST_LABEL_RE =
  /\b(?:cost|price|fee|entry(?:\s+fee)?|mint\s+(?:price|cost))\s*[:=→]\s*(\S.{0,15}?)(?=\s+(?:to|for|until|and|if|when|per)\b|[;\n]|[.,](?!\d)|$)/i;
const STAKE_COST_RE =
  /\b(?:stake|deposit|hold|lock|pay|spend|swap|bridge|buy|bond)(?:\s+(?:at\s+least|min(?:imum)?(?:\s+of)?))?\s+(\$\s?[\d.,]+[kmb]?\+?|[\d.,]+[kmb]?\+?\s*\$?[a-z]{2,6}\+?)(?=\s|[.,;]|$)/i;
const GAS_ONLY_RE = /\b(?:gas\s*(?:fees?\s*)?only|only\s+gas|just\s+gas|\+\s*gas|excluding\s+gas)\b/i;
const FREE_RE = /\bfree\b(?!\s+(?:trial|version|vpn|range|fall|tax|from)\b)/i;
const ZERO_COST_RE = /\$\s?0\b|\b0\s*(?:usd|usdc|usdt|dai|eth|sol)\b|\bno\s+(?:entry\s+)?(?:fee|cost)\b|\bzero\s+(?:fee|cost)\b/i;

function capitalizePhrase(phrase: string): string {
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

function extractCost(text: string): string | undefined {
  const labeled = text.match(COST_LABEL_RE)?.[1]?.replace(/\s+/g, ' ').trim();
  if (labeled) return truncateAtWordBoundary(capitalizePhrase(labeled), 40);
  const stake = text.match(STAKE_COST_RE)?.[0].replace(/\s+/g, ' ').trim();
  if (stake) return truncateAtWordBoundary(capitalizePhrase(stake), 40);
  if (GAS_ONLY_RE.test(text)) return 'Gas only';
  if (FREE_RE.test(text)) return 'Free';
  const zero = text.match(ZERO_COST_RE)?.[0].replace(/\s+/g, ' ').trim();
  return zero ? truncateAtWordBoundary(capitalizePhrase(zero), 40) : undefined;
}

const MAX_STEPS = 4;
const MAX_STEP_LEN = 100;
// Links, bare domains, and @handles are cut out of a step before it is judged.
const STEP_URL_RE =
  /https?:\/\/\S+|\bt\.me\/\S+|(?<![\w@.])(?:[\w-]+\.)+(?:com|io|xyz|fun|app|gg|ai|org|net|co|me|site|fi|so|to|dev|eth|sol)(?:\/\S*)?|@\w{2,32}\b/gi;
// A step must open with an imperative task verb; descriptive sentences never qualify.
const STEP_VERB_RE =
  /^(?:please\s+)?(?:add|answer|bind|boost|bridge|browse|buy|claim|collect|comment|complete|connect|create|delegate|deposit|download|earn|explore|fill|finish|follow|get|go|grab|hold|install|invite|join|learn|like|link|lock|log\s*in|login|mint|open|opt\s+in|participate|play|post|provide|redeem|refer|register|restake|retweet|run|set\s+up|share|sign\s+(?:up|in)|spin|stake|start|submit|swap|tag|test|trade|transfer|try|upload|verify|vote|watch|win)\b/i;
// Wallet secrets, drainer phrasing, referral handles, and channel promos are never steps.
const STEP_UNSAFE_RE =
  /\b(?:seed\s+phrase|recovery\s+phrase|private\s+key|mnemonic|passphrase)\b|0x[a-fA-F0-9]{6,}|\b[1-9A-HJ-NP-Za-km-z]{32,44}\b|\bfor\s+more\s+(?:airdrops?|updates?|alpha)\b|\bsubscribe\b/i;
const STEP_LIST_MARKER_RE =
  /^\s*(?:\d{1,2}\s*[.):\-]|[*(•▪●▸►➖❯‣⁃]️?|[-–—]\s+|step\s*\d{1,2}\s*[:.\-)]?\s*|step\s*[:\-]\s*)/iu;

function extractSteps(text: string): string[] {
  const steps: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string): boolean => {
    if (steps.length >= MAX_STEPS) return true;
    const step = stripEmoji(raw)
      .replace(STEP_URL_RE, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[\s,;:|/\\)\]}]+/, '')
      .replace(/[\s,;:|/\\)+–—.]+$/, '')
      .trim();
    if (step.length < 8 || step.length > MAX_STEP_LEN) return false;
    if (!STEP_VERB_RE.test(step)) return false;
    if (STEP_UNSAFE_RE.test(step) || DRAINER_RE.test(step) || DOUBLING_SCAM_RE.test(step)) return false;
    const key = normalizeAlphaNum(step);
    if (seen.has(key)) return false;
    seen.add(key);
    steps.push(step);
    return steps.length >= MAX_STEPS;
  };

  const lines = stripOrTranslateCjk(text).split('\n');
  // Numbered or bulleted lines first: they are the author's own task list.
  for (const line of lines) {
    const cleaned = line.replace(STEP_URL_RE, ' ');
    const marker = cleaned.match(STEP_LIST_MARKER_RE);
    if (marker && push(cleaned.slice(marker[0].length))) return steps;
  }
  // Then any sentence that opens with a task verb. A dot only ends a sentence before whitespace,
  // so decimals such as `Deposit 0.5 ETH` stay whole.
  for (const line of lines) {
    for (const segment of line.split(/(?<=[.!?])\s+|[•●▪➖|]+/)) {
      if (push(segment)) return steps;
    }
  }
  return steps;
}

/** Extracts deterministic structured metadata for a relevant drop (absent fields are omitted). */
export function extractRichMetadata(text: string): RichDropMeta {
  const rewardPool = extractRewardPool(text);
  const deadline = extractDeadline(text);
  const cost = extractCost(text);
  const steps = extractSteps(text);
  return {
    ...(rewardPool ? { rewardPool } : {}),
    ...(deadline ? { deadline } : {}),
    ...(cost ? { cost } : {}),
    ...(steps.length > 0 ? { steps } : {}),
  };
}
