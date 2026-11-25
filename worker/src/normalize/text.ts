import type { TaskType } from '../../../shared/types';
import { getRegistrableDomain, isNewsDomain, isPlatformDomain, isQuestDomain } from './domains';
import { hasCjkDropSignal } from './i18n';

/**
 * Words that must never become a fallback project name or `proj:` cluster key.
 * Covers English stopwords/wire prefixes/months/days, exchanges/KYC vendors,
 * Indonesian chat fillers, and macro/news nouns seen in live feed audits.
 */
export const STOP_NAMES = new Set<string>([
  // English function/stop words & generic web3 labels
  'THE', 'THIS', 'THAT', 'THESE', 'THOSE', 'NEW', 'FREE', 'AIRDROP', 'AIRDROPS', 'TESTNET', 'MAINNET',
  'CLAIM', 'HOW', 'HERE', 'JOIN', 'UPDATE', 'UDDATE', 'ALERT', 'LIVE', 'NOW', 'CHECK', 'GUIDE', 'TASK',
  'TASKS', 'REWARD', 'REWARDS', 'TOKEN', 'TOKENS', 'POINTS', 'SEASON', 'OFFICIAL', 'LINK', 'LINKS',
  'CRYPTO', 'WEB3', 'HTTP', 'HTTPS', 'WHAT', 'WHEN', 'WHERE', 'WHO', 'WHY', 'WILL', 'WITH', 'FROM',
  'YOUR', 'THEIR', 'ABOUT', 'AFTER', 'BEFORE', 'MORE', 'MOST', 'ONLY', 'JUST', 'ALSO', 'SOME', 'MANY',
  'VERY', 'MUCH', 'EVEN', 'STILL', 'BACK', 'DOWN', 'OVER', 'INTO', 'ONTO', 'UNDER', 'DONE', 'SOON',
  'ALL', 'ANY', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'FIRST', 'LAST', 'NEXT', 'BEST', 'GOOD', 'BIG',
  'REAL', 'OPEN', 'START', 'STOP', 'PLAY', 'EARN', 'WIN', 'GET', 'MAKE', 'LOOK', 'SEE', 'READ', 'WATCH',
  'SHARE', 'FOLLOW', 'SUBMIT', 'CONNECT', 'COMPLETE', 'REGISTER', 'APPLY', 'VERIFY', 'DOWNLOAD', 'CREATE',
  'TOTAL', 'MIN', 'MAX', 'POOL', 'PRIZE', 'BONUS', 'CODE', 'REF', 'REFF', 'INVITE', 'SOURCE', 'SORCE',
  'DETAILS', 'DISCLAIMER', 'LIST', 'WEEKLY', 'DAILY', 'MONTHLY', 'TODAY', 'TOMORROW', 'YESTERDAY',
  'WEEKEND', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY',
  'JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER',
  'NOVEMBER', 'DECEMBER', 'BLACK', 'WHITE', 'BORN', 'SORRY', 'SERIOUS', 'INTRODUCING', 'INSTANT',
  'RECENT', 'TRACK', 'PIVOTING', 'MALICIOUS', 'INVESTIGATION', 'MACRO', 'NEWS', 'BREAKING', 'LATEST',
  'INSIGHT', 'REGULATION', 'REPORT', 'SURVEY', 'NEWSLETTER', 'ROLLUP', 'BTW', 'GM', 'GN', 'LFG', 'WAGMI',
  'TBA', 'FCFS', 'NFT', 'NFTS', 'SBT', 'DAO', 'DEX', 'CEX', 'KYC', 'USD', 'USDT', 'USDC', 'AI', 'ETH',
  'BTC', 'SOL', 'BNB', 'BITCOIN', 'ETHEREUM', 'SOLANA', 'STRATEGY', 'SELLER', 'WAITLIST', 'WHITELIST',
  'ALLOWLIST', 'MINT', 'MINTDATE', 'CHECKER', 'WINNER', 'WINNERLIST', 'ELIGIBILITY', 'CAMPAIGN',
  'PHASE', 'EPOCH', 'REMINDER', 'URGENT', 'GIVEAWAY', 'FAM', 'FRENS', 'GUYS',
  // Wire/macro/political/person names, CEX exchanges, and KYC vendors seen causing false clusters live
  'HUANG', 'JENSEN', 'NVIDIA', 'NVDA', 'TRUMP', 'DEMOCRATS', 'REPUBLICANS', 'RUSSIA', 'CHINA', 'AMERICA',
  'EUROPE', 'ANTHROPIC', 'OPENAI', 'APPLE', 'SAMSUNG', 'GOOGLE', 'SPACEX', 'TESLA', 'NICK', 'ROB', 'OMID',
  'UPBIT', 'BITHUMB', 'BINANCE', 'COINBASE', 'BYBIT', 'OKX', 'KUCOIN', 'BITGET', 'MEXC', 'GATE', 'HTX',
  'KRAKEN', 'BINGX', 'BITMART', 'LBANK', 'SHEERID', 'SUMSUB', 'COINDESK', 'COINTELEGRAPH', 'THEBLOCK',
  'WATCHERGURU',
  // Indonesian casual chat fillers / slang
  'TAPI', 'SUDAH', 'UDAH', 'ADA', 'INI', 'ITU', 'YANG', 'UNTUK', 'BUAT', 'DENGAN', 'DARI', 'TIDAK',
  'GAK', 'BELUM', 'KALO', 'KALAU', 'BISA', 'AJA', 'CUMA', 'BANGET', 'PAKE', 'DAPET', 'KALIAN', 'GUE',
  'AKU', 'KAMU', 'BANG', 'BRO', 'CUY', 'GES', 'GAES', 'NIH', 'YUK', 'GAS', 'GASS', 'GASKEUN', 'SKUY',
  'AYO', 'COBA', 'MANTAP', 'COK', 'SUMPAH', 'SEPI', 'BURUAN', 'CEK', 'MENDING', 'LANGSUNG', 'ABSEN',
  'MUSANG', 'MUSENG', 'BINGUNG', 'RECEH', 'BANSOS', 'CALON', 'RUSAK', 'NAPA', 'OIYA', 'JELAS', 'LUCU',
  'KELAKUAN', 'ANDAI', 'ALHAMDULILLAH', 'WIARSOBEK', 'BOTTOMHOKI', 'SIAP', 'MOHON', 'MAAF', 'MIRIP',
  'UMUR', 'GIMANA', 'KENAPA', 'SIAPA', 'DISINI', 'JADI', 'BIAR', 'CUAN', 'GARAPAN', 'SAMA', 'JUGA', 'PUNYA',
]);

/**
 * Major base assets, stablecoins, and equities that must never hijack a drop's
 * `$TICKER` field or serve as a cross-source clustering key.
 */
export const MAJOR_TICKERS = new Set<string>([
  'USD', 'USDT', 'USDC', 'DAI', 'USDE', 'USDS', 'FDUSD', 'TUSD', 'BUSD', 'PYUSD', 'EUR', 'EURC',
  'BTC', 'WBTC', 'ETH', 'WETH', 'STETH', 'WSTETH', 'CBETH', 'SOL', 'WSOL', 'BNB', 'XRP', 'ADA',
  'DOGE', 'DOT', 'ATOM', 'AVAX', 'MATIC', 'POL', 'ARB', 'OP', 'SUI', 'APT', 'TON', 'TRX', 'LTC',
  'BCH', 'LINK', 'UNI', 'AAVE', 'XMR', 'NEAR', 'FIL', 'ICP', 'ETC', 'XLM', 'SHIB', 'PEPE', 'WIF', 'HYPE',
  // Stock tickers leaking from macro/TradFi wire channels
  'NVDA', 'AAPL', 'TSLA', 'MSFT', 'AMZN', 'META', 'GOOGL', 'GOOG', 'AMD', 'INTC', 'PLTR', 'MSTR',
  'COIN', 'HOOD', 'SPCX', 'SPY', 'QQQ', 'JNJ', 'NIO', 'AMDL',
]);

export function isStopName(word: string): boolean {
  return STOP_NAMES.has(word.trim().toUpperCase());
}

// Indonesian/Malay function words and casual Telegram slang (word-boundary matched).
const INDONESIAN_MARKER_RE =
  /\b(?:yang|yg|untuk|buat|dengan|dari|tidak|gak|enggak|udah|sudah|belum|blm|kalo|kalau|bisa|aja|cuma|banget|bgt|pake|pakai|dapet|dapat|kalian|gue|gw|aku|kamu|bang|ges|cok|anjink|sumpah|gada|sepi|buruan|keburu|soalnya|komen|nonton|ceritain|diceritain|rusak|linknya|mending|langsung|tapi|juga|lagi|masih|harus|punya|gimana|kenapa|siapa|disini|disana|klo|jadi|biar|cuan|garapan|bansos|musang|museng|receh|serok|bingung|takpalah|tumben|gabut|maen|walaupun|keliatan|dibutuhkan|sehari|upah|turun|nyari|dulu|alhamdulillah|absen|siap2|cek|reff|kelakuan|oiya|jelas|lucu|andai|mohon|maaf|mirip|intinya|dapetin|kripto|ngedump|perasaan|sebenrnya|sekrang|bersebrangan|gampang|ngatain|kemaslhatan|coba|nih|hoki|sirkel|klaim|akhirnya|pengidap|penyakit|gila|hantam|jejak|mumpung|dan|semua|bukan|atau|mantap|skuy|gaskeun|garap|alokasi|hadiah|gratis|skrg|udh|utk)\b/gi;

// Turkish-specific letters & common wire translation words (`AstronomicaNews` EN+TR posts).
const TURKISH_DIACRITIC_RE = /[ğşışİçöüĞŞÇÖÜ]/;
const TURKISH_WORD_RE =
  /\b(?:bir|ve|veya|i[cç]in|olarak|g[oö]re|dedi|a[cç][iı]klad[iı]|s[oö]yledi|ancak|fakat|daha|[cç]ok|ile|kaynak|yat[iı]r[iı]m|piyasa|kripto|hisse|dolar|milyar|milyon|oldu[gğ]unu|yapaca[gğ][iı]n[iı]|etmedi[gğ]ini|d[uü][sş][uü]nm[uü]yor)\b/gi;

function countDistinctMatches(text: string, re: RegExp): number {
  const hits = new Set<string>();
  const matches = text.match(re);
  if (!matches) return 0;
  for (const m of matches) hits.add(m.toLowerCase());
  return hits.size;
}

export function isTurkishSegment(text: string): boolean {
  const words = countDistinctMatches(text, TURKISH_WORD_RE);
  if (words >= 2) return true;
  return TURKISH_DIACRITIC_RE.test(text) && words >= 1;
}

export function isIndonesianSegment(text: string, sourceLang?: string): boolean {
  const words = countDistinctMatches(text, INDONESIAN_MARKER_RE);
  if (words >= 2) return true;
  if (sourceLang?.toLowerCase() === 'id' && words >= 1) return true;
  return false;
}

/**
 * Detects non-English Latin-script posts (Indonesian / Turkish) that bypass
 * `NON_LATIN_SCRIPT_RE` and would otherwise ship untranslated in an English feed.
 */
export function detectNonEnglishLatin(text: string, sourceLang?: string): boolean {
  return isIndonesianSegment(text, sourceLang) || isTurkishSegment(text);
}

/**
 * Removes Turkish translation lines/halves and verbatim repeated lines/halves
 * (e.g. EN+TR wire posts or duplicated message strings).
 */
export function stripBilingualDuplicate(text: string): string {
  const rawLines = text
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);

  if (rawLines.length === 0) return '';

  // Drop Turkish translation paragraphs when an English paragraph is already present.
  const nonTurkishLines = rawLines.filter(line => !isTurkishSegment(line));
  const lines = nonTurkishLines.length > 0 ? nonTurkishLines : rawLines;

  // Deduplicate exact repeated lines (case-insensitive).
  const uniqueLines: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const key = line.toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueLines.push(line);
  }

  // Handle inline EN + `*Bir kaynak...` Turkish split on a single line.
  const joined = uniqueLines.join('\n').replace(/\s+\*[^*\n]{10,}$/g, m => (isTurkishSegment(m) ? '' : m));

  // Collapse exact inline doubled text (`Check Reward Make FunCheck Reward Make Fun`
  // or `Check Reward Make Fun Check Reward Make Fun`).
  const flat = joined.replace(/\s+/g, ' ').trim();
  if (flat.length >= 16) {
    const half = Math.floor(flat.length / 2);
    const left = flat.slice(0, half).trim();
    const right = flat.slice(half).trim();
    if (left.length >= 8 && left.toLowerCase() === right.toLowerCase()) {
      return left;
    }
  }

  return joined.trim();
}

function stripTrailingNonEnglishClause(line: string, sourceLang?: string): string {
  const sentences = line.split(/(?<=[.!?])\s+/).filter(Boolean);
  let current = line;
  if (sentences.length > 1) {
    const englishSentences = sentences.filter(
      s => !isIndonesianSegment(s, sourceLang) && !isTurkishSegment(s),
    );
    if (englishSentences.length > 0) {
      const joined = englishSentences.join(' ').trim();
      if (joined.length >= 15) current = joined;
    }
  }
  return current.replace(/,\s*[^,\n]{8,}$/g, m => (isIndonesianSegment(m, sourceLang) ? '' : m)).trim();
}

/**
 * Drops Indonesian-only disclaimer/commentary lines when the post already has
 * substantial English task instructions (e.g. `Getclocked` / `TopNod` posts that
 * end with an Indonesian ref-code note).
 */
export function stripNonEnglishLines(text: string, sourceLang?: string): string {
  const lines = text
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);
  if (lines.length <= 1) {
    // Also trim trailing Indonesian sentences or clauses when preceded by English.
    return stripTrailingNonEnglishClause(text, sourceLang);
  }
  const englishLines = lines.filter(line => !isIndonesianSegment(line, sourceLang) && !isTurkishSegment(line));
  if (englishLines.length > 0 && englishLines.join(' ').length >= 25) {
    return englishLines
      .map(l => stripTrailingNonEnglishClause(l, sourceLang))
      .join('\n')
      .trim();
  }
  return text;
}

// Inline bare domain URL with path or query (e.g. `getclocked.com/?ref=HQAKP9`, `zeroguys.fun/mint`).
const BARE_URL_WITH_PATH_RE =
  /\b(?:www\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9-]+)*\.(?:com|io|xyz|fun|app|gg|ai|org|net|co|me|site|wtf|voyage|cc|one|pro|network|finance|exchange|market|markets|systems|bot|live|club|fi|sh|so|to)(?:\/[^\s]*|\?[^\s]*)/gi;

/**
 * Cleans raw post text for human-readable English card summaries:
 * removes wire prefixes/footers, URLs, bare referral URLs, dangling link labels,
 * and normalizes squashed Telegram bullets into clean ` · ` separators.
 */
export function cleanSummaryText(raw: string, sourceLang?: string): string {
  let text = stripBilingualDuplicate(raw);
  text = stripNonEnglishLines(text, sourceLang);

  // Remove channel signature footers and wire markers.
  text = text
    .replace(/\bNews\s*\|\s*Markets\s*\|\s*YouTube\b/gi, ' ')
    .replace(/(?:\p{Emoji_Presentation}\s*)?Atoms\s*\|\s*(?:\p{Emoji_Presentation}\s*)?Chat\s*\|\s*(?:\p{Emoji_Presentation}\s*)?Boost/giu, ' ')
    .replace(/\s*[\u2013\u2014-]\s*Link\b/gi, ' ')
    .replace(/\s+@[A-Za-z0-9_]{3,32}\s*$/g, ' ')
    .replace(/^\s*(?:\*+[A-Z0-9\s]{2,20}:|BREAKING:|JUST IN:|LATEST:|REGULATION:|INSIGHT:|BIG:)\s*/i, '');

  // Strip full URLs and bare URLs with paths/referral params.
  text = text
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(BARE_URL_WITH_PATH_RE, ' ');

  // Normalize decorative divider lines (`____`, `----`) and convert bullet markers to ` · `.
  text = text
    .replace(/[_]{3,}|[-]{4,}/g, ' ')
    .replace(/(?:^|\n|\s)(?:[\u2796\u2022\u25AA\u25CF\u25B8\u25BA]|\u2615\uFE0F?|\u{1F7E2}|-\s+)/gu, ' \u00b7 ');

  // Strip dangling empty link/source labels left behind after URL removal.
  // Repeat twice to catch chained labels like `Register : -> Link :`.
  for (let i = 0; i < 2; i++) {
    text = text.replace(
      /(?:[\p{Emoji_Presentation}\p{Extended_Pictographic}]\uFE0F?\s*)*\b(?:Source|Sorce|Link|Links|Register|Apply Now|Apply here|Check Here|Check your Airdrop here|Complete Here|Completed Here|Spend Here|Mint Link|Join Waitlist|Go to|Winnerlist|LFG|More details|Details)\b\s*[:\u2192\u27A1\uFE0F]*\s*(?=(?:\u00b7|\n|$|\b(?:Source|Sorce|Link|Register|Apply|Check|Complete|Done)\b))/giu,
      ' ',
    );
  }

  // Strip stray pointer arrows, emojis standing alone as labels, and excess punctuation.
  text = text
    .replace(/[\u27A1\u2192\u{1F449}\u{1F517}\u{1F4D6}\u{1FA82}\u2728]\uFE0F?/gu, ' ')
    .replace(/\s*\u00b7\s*/g, ' \u00b7 ')
    .replace(/(?:\s*\u00b7\s*){2,}/g, ' \u00b7 ')
    .replace(/^[\s\u00b7:;,\-|\u2013\u2014]+/, '')
    .replace(/[\s\u00b7:;,\-|\u2013\u2014]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();

  return text;
}

/**
 * Truncates text at a word boundary (code-point safe so emoji surrogate pairs
 * never split) instead of cutting mid-word (`including s...`).
 */
export function truncateAtWordBoundary(text: string, maxLen = 195): string {
  const cps = [...text.trim()];
  if (cps.length <= maxLen) return text.trim();

  const slice = cps.slice(0, maxLen - 1).join('');
  const minBoundary = Math.floor(maxLen * 0.6);
  const lastSpace = slice.lastIndexOf(' ');
  const candidate = lastSpace >= minBoundary ? slice.slice(0, lastSpace) : slice;
  return `${candidate.replace(/[\s,;:\-\u2013\u2014(\u00b7]+$/, '')}\u2026`;
}

// --- Drop Relevance Classification ---

const HARD_WIRE_PREFIX_RE =
  /^\s*(?:[\p{Emoji_Presentation}\p{Extended_Pictographic}]\uFE0F?\s*)*(?:JUST IN|BREAKING|LATEST|REGULATION|INSIGHT|BIG|UDDATE)\s*:/iu;
const HARD_WIRE_COLON_WIRE_RE = /^\s*\*[A-Z][A-Z0-9]{1,20}(?:\s+[A-Z0-9]{2,15})?\s*:/;
const HARD_WIRE_CAPS_WIRE_RE = /^\s*\*[A-Z]{2,}(?:\s+[A-Z0-9$%.,'-]{2,}){2,}/;
const ITALIC_SPAN_FIRST_LINE_RE = /^\s*\*[^*\n]+\S\*/;

function isHardWirePrefix(text: string): boolean {
  if (HARD_WIRE_PREFIX_RE.test(text) || HARD_WIRE_COLON_WIRE_RE.test(text)) {
    return true;
  }
  return HARD_WIRE_CAPS_WIRE_RE.test(text) && !ITALIC_SPAN_FIRST_LINE_RE.test(text);
}

const WIRE_FOOTER_RE =
  /\bNews\s*\|\s*Markets\s*\|\s*YouTube\b|@(?:WatcherGuru|News_Crypto)\b/i;

const WHALE_TRANSFER_RE =
  /\b\d[\d,.]+\s*\$?[A-Z]{2,8}\s*\([^)]*USD\)\s*transferred\s+from\b/i;

const MARKET_PRICE_TICKER_RE =
  /\b(?:Top Price movements|Drops Below \$|experiencing a sudden drop|liquidated over the past|SHARES OPEN AT \$|IPO PRICE OF \$|OPENS AT \$[\d.]+,\s*IPO|close \d{4} under \$|ETFs?\s+lose|outflow streak|adds\s+[A-Z0-9,\s&]+perpetuals?\s+with\s+up\s+to\s+\d+x|short-term holders?\s+(?:are\s+)?(?:capitulating|send)|assets under management|generated more revenue for its holders)\b/i;

const NEWSLETTER_ROLLUP_RE =
  /\bToday['\u2019]s Newsletter\b|\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:st|nd|rd|th)?\s+Rollup\b|\bWeekly\s+(?:Recap|Digest|Roundup|Rollup)\b/i;

const PROMO_SPAM_RE =
  /\b\d+%\s*DEPOSIT BONUS\b|\bGet\s+2X\s+your\s+deposit\b|\bBlack Friday is coming\b|\bMin\s+WD\s+\d+\s*Point/i;

const HACK_NEWS_RE =
  /\b(?:hack(?:er|ers|ed)?|vault\s+hack|crypto\s+hack|exploit|stolen\s+funds|malware|cyberattack|third-party\s+vendors|freeze\s+risk)\b/i;

const STRONG_DROP_SIGNAL_RE =
  /(?<![A-Za-z0-9])\$[A-Z0-9]{2,10}\s+claim\b|\b(?:airdrop|airdrops|retrodrop|testnet|tesnet|devnet|faucet|waitlist|whitelist|allowlist|wl|free\s*mint|mint\s*(?:live|now|date|price|starts|open|free)|sbt|soulbound|checker|checkers|eligibility|eligible|claim\s+(?:goes\s+live|is\s+live|live|open|opens|starts|available|now|here|your|portal|airdrop|reward|rewards|role|badge|sbt|username|free|sol|soulbound|tokens?)|tokenomics|genesis\s+(?:supply|airdrop|allocation|drop|event)|check\s+(?:your\s+)?(?:allocation|eligibility|if\s+you\s+qualify)|token\s+distribution|retroactive\s+rewards?|leaderboard\s+rewards?|(?:earn|farm|check|plume)\s+miles|(?:(?:new|easy|simple|quick|daily|social)\s+)*tasks?(?!\s+force)|garapan|klaim(?:\s*(?:poin|airdrop|reward|token|nft|badge|role))?|tugas|daftar\s*waitlist|cek\s+(?:elig\w*|alokasi|jp)|galxe|zealy|layer3|intract|questn|taskon|soquest|guild\.xyz|quests?|points?\s*(?:program|campaign|farm|farming|season|update|system)|earn\s*(?:points?|xp)|farm(?:ing)?\s*(?:points?|airdrop)|season\s*\d+(?:\s+\S+){0,3}\s+(?:drop|drops|points?|rewards?|airdrop|airdrops|farm(?:ing)?|claim|campaign|quests?|xp|badges?)|(?:drop|drops|points?|rewards?|airdrop|airdrops|farm(?:ing)?|claim|campaign|quests?|xp|badges?)\s+season\s*\d+|epoch\s*\d+|early\s*access|beta\s*access|invite\s*code|coding\s+bount(?:y|ies)|bount(?:y|ies)\s+for|creator\s+campaign|incentivized|run\s+(?:a\s+)?validator|validator\s+(?:testnet|node|rewards?|incentiv\w*)|run\s*a\s*node|depin\s+(?:airdrop|testnet|nodes?|farm(?:ing)?|points?|rewards?|earn|mining|campaign)|tge\s+(?:live|soon|claim|airdrop|checker|date|confirmed|announced|rewards?|is\s+live|this\s+week|this\s+month)|(?:pre[-\s]|before\s+|ahead\s+of\s+|until\s+)tge|snapshot(?:\s+\S+){0,3}\s+(?:drop|airdrop|eligib\w*|claim|rewards?|taken|date|live|coming|soon|completed|announced|confirmed)|(?:drop|airdrop|eligib\w*|claim|rewards?|pre-?)\s*snapshot|check-?ins?|daily\s*(?:spin|quest|check-?in|task|crate)|complete\s*(?:all\s*)?tasks?|submit\s*(?:your\s+)?(?:evm|sol|solana|wallet)\s*address|connect\s*(?:your\s+)?(?:x|twitter|discord|evm|solana|new)\s*(?:account|wallet)?|account\s+bindings?|winnerlist|hold\s+to\s+earn|spin\s*&\s*win|reward\s*pool|bridge\s+is\s+(?:also\s+)?live)\b/i;

const DROP_URL_PATH_RE =
  /\/(?:airdrop|claim|faucet|waitlist|whitelist|allowlist|quest|quests|mint|checker|apply|campaign|campaigns|rewards|points|testnet|early-access|socialcamp|sunset|walletchecker)(?:[/?#]|$)|#(?:early-access|walletchecker|quest)\b/i;

export interface DropRelevanceInput {
  text: string;
  urls: string[];
  projectDomain?: string;
  taskTypes: TaskType[];
  hasSurfMatch?: boolean;
}

export interface DropRelevanceResult {
  isDrop: boolean;
  reason: string;
}

/**
 * Classifies whether a post is an actionable Web3 drop / airdrop / testnet /
 * waitlist / mint / quest / points / claim signal vs news, whale alerts, price
 * bots, macro commentary, CEX deposit promos, or casual chat.
 */
export function classifyDropRelevance(input: DropRelevanceInput): DropRelevanceResult {
  const text = input.text.trim();
  const urls = input.urls;

  if (!text && urls.length === 0) {
    return { isDrop: false, reason: 'empty' };
  }

  // Hard rejections for non-drop bots, ads, newsletters, and wire news.
  if (WHALE_TRANSFER_RE.test(text)) {
    return { isDrop: false, reason: 'whale-alert' };
  }
  if (MARKET_PRICE_TICKER_RE.test(text)) {
    return { isDrop: false, reason: 'price-or-market-news' };
  }
  if (NEWSLETTER_ROLLUP_RE.test(text)) {
    return { isDrop: false, reason: 'newsletter-digest' };
  }
  if (PROMO_SPAM_RE.test(text)) {
    return { isDrop: false, reason: 'promo-or-survey-ad' };
  }

  const hasNewsUrl = urls.some(u => {
    const dom = getRegistrableDomain(u);
    return Boolean(dom && isNewsDomain(dom));
  });
  const hasStrongKeyword = STRONG_DROP_SIGNAL_RE.test(text) || hasCjkDropSignal(text);
  const hasActionableUrlPath = urls.some(u => {
    const dom = getRegistrableDomain(u);
    if (dom && isNewsDomain(dom)) return false;
    return DROP_URL_PATH_RE.test(u);
  });
  const hasQuestUrl = urls.some(u => {
    const dom = getRegistrableDomain(u);
    return Boolean(dom && isQuestDomain(dom));
  });
  const hasProjectDomain = Boolean(input.projectDomain && !isPlatformDomain(input.projectDomain));

  // Hack/exploit stories ("offers attacker 10% bounty") and wire-formatted news
  // must never pass even if they mention words like "bounty" or "claim".
  if (HACK_NEWS_RE.test(text) && !hasActionableUrlPath && !hasQuestUrl) {
    return { isDrop: false, reason: 'hack-or-security-news' };
  }
  if ((isHardWirePrefix(text) || WIRE_FOOTER_RE.test(text)) && !hasActionableUrlPath && !hasQuestUrl) {
    return { isDrop: false, reason: 'news-wire' };
  }
  if (hasNewsUrl && !hasProjectDomain && !hasActionableUrlPath && !hasQuestUrl) {
    return { isDrop: false, reason: 'news-outlet-link' };
  }
  // News-domain links inside a post with no non-news project/quest URL.
  if (input.projectDomain && isNewsDomain(input.projectDomain)) {
    return { isDrop: false, reason: 'news-project-domain' };
  }

  // Positive acceptance: requires at least one genuine drop/participation signal.
  if (hasStrongKeyword) {
    return { isDrop: true, reason: 'drop-keyword' };
  }
  if (hasActionableUrlPath || hasQuestUrl) {
    return { isDrop: true, reason: 'actionable-drop-url' };
  }
  if (input.hasSurfMatch && hasProjectDomain) {
    return { isDrop: true, reason: 'verified-surf-project' };
  }

  // Specific actionable taskTypes (excluding 'other') + a non-platform project domain.
  const hasSpecificTask = input.taskTypes.some(t => t !== 'other');
  if (hasSpecificTask && hasProjectDomain) {
    return { isDrop: true, reason: 'project-domain-with-task' };
  }

  return { isDrop: false, reason: 'no-drop-signal' };
}
