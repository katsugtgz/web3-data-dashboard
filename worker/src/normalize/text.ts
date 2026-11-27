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

// Emoji run: pictographs plus their variation selector, ZWJ joiner, and skin-tone modifiers.
const EMOJI_RUN = String.raw`[\p{Emoji_Presentation}\p{Extended_Pictographic}‍️\p{Emoji_Modifier}]+`;
const EMOJI_RE = new RegExp(EMOJI_RUN, 'gu');
/** Replaces every emoji (with its joiners and modifiers) with a space. */
export function stripEmoji(text: string): string {
  return text.replace(EMOJI_RE, ' ');
}
// Decorative emoji prefix that opens a post, with any separator glued to it.
const LEADING_EMOJI_RE = new RegExp(String.raw`^(?:${EMOJI_RUN}\s*[|·:;,\-~>*\s]*)+`, 'u');

// Caption labels that make up Telegram channel signature rows (`Atoms | Chat | Boost`,
// `News | Markets | YouTube`). Such a row is channel navigation, never drop content.
const FOOTER_LABEL =
  String.raw`(?:official\s+)?(?:links?|chat|boost|website|site|web|app|holder|dns|x|twitter|discord|telegram|tg|channel|group|community|announcements?|news|markets|youtube|updates?|medium|blog|docs|gitbook|whitepaper|dapp|dashboard|github|instagram|tiktok|threads|reddit|forum|email|contact|support|donate|source|sorce|socials?|media|atoms|us|more|info|about|subscribe|follow|join|dex|explorer|audit|tokenomics|litepaper)`;

// Two or more pipe-joined caption labels, anywhere in the text.
const FOOTER_LABEL_ROW_RE = new RegExp(
  String.raw`(?:\s*\|\s*|\s+|^)(?:${EMOJI_RUN}\s*)?${FOOTER_LABEL}(?:\s*\|\s*(?:${EMOJI_RUN}\s*)?${FOOTER_LABEL})+\s*[.!?]?(?=\s|$)`,
  'giu',
);

// A single trailing caption with its leading pipe (`... is live | Chat`).
const TRAILING_CAPTION_RE = new RegExp(
  String.raw`\s\|\s*(?:${EMOJI_RUN}\s*)?${FOOTER_LABEL}\s*[.!?]?(?=\s*$)`,
  'gim',
);

// A line that only captions a link (`Chat`, `| Chat`) or captions it with a URL-like leftover
// (`DNS 1.1.1.1`, `Holder Agent.id`) once the URL itself was removed.
const LINK_CAPTION_LINE_RE = new RegExp(
  String.raw`^[\s|>·*_-]*(?:${EMOJI_RUN}\s*)*(?:official\s+)?(?:links?|chat|boost|website|site|web|app|holder|dns|x|twitter|discord|telegram|tg|channel|group|announcements?|source|sorce|docs|whitepaper|explorer|audit|medium|blog|github|youtube|instagram|tiktok|reddit|forum|contact|support)\s*[:→➡>-]?\s*(?:[\w@./:?=&%+#-]*[./@][\w@./:?=&%+#-]*)?\s*[.!?]?$`,
  'iu',
);

function stripTrailingLinkCaptions(text: string): string {
  const lines = text.split('\n');
  let end = lines.length;
  while (end > 0) {
    const line = lines[end - 1].trim();
    if (line && !LINK_CAPTION_LINE_RE.test(line)) break;
    end--;
  }
  return lines.slice(0, end).join('\n');
}

// Channel-growth promos appended to a post: `Subscribe to our channel`,
// `Join our Telegram channel`, `Follow us on X`, `Turn on notifications`.
const CHANNEL_PROMO_RE = new RegExp(
  String.raw`(^|[.!?…·]|\n|\d[.)])\s*(?:${EMOJI_RUN}\s*)?(?:subscrib(?:e|ed)\b|join\s+(?:our|the|us)\b[^.!?\n]{0,30}\b(?:telegram|tg|channel|group)\b|follow\s+us\b[^.!?\n]{0,20}\b(?:x|twitter|telegram|tg|channel)\b|(?:turn\s+on|enable)\s+(?:the\s+|post\s+)?notifications?\b)[^\n]*?(?:[.!?](?=\s|$)|(?=\n)|$)`,
  'giu',
);

function stripChannelPromos(text: string): string {
  // A promo phrased as a list step (`· Join our Telegram channel ·`, `2. Follow us on X`) is task content.
  return text.replace(CHANNEL_PROMO_RE, (match, lead: string) => {
    if (lead === '·' || /\d[.)]$/.test(lead)) return match;
    return lead === '\n' ? '\n' : lead;
  });
}

/**
 * Cleans raw post text for human-readable English card summaries: removes wire
 * prefixes, Telegram channel signature footers and promo tails, URLs, bare
 * referral URLs, dangling link labels, decorative emoji, and normalizes
 * squashed Telegram bullets into clean ` · ` separators.
 */
export function cleanSummaryText(raw: string, sourceLang?: string): string {
  let text = stripBilingualDuplicate(raw.replace(LEADING_EMOJI_RE, ''));
  text = stripNonEnglishLines(text, sourceLang);

  // Remove channel signature rows and wire markers.
  text = text
    .replace(FOOTER_LABEL_ROW_RE, ' ')
    .replace(TRAILING_CAPTION_RE, ' ')
    .replace(/\s*[\u2013\u2014-]\s*Link\b/gi, ' ')
    .replace(/\s+@[A-Za-z0-9_]{3,32}\s*$/g, ' ')
    .replace(/^\s*(?:\*+[A-Z0-9\s]{2,20}:|BREAKING:|JUST IN:|LATEST:|REGULATION:|INSIGHT:|BIG:)\s*/i, '');

  // Strip full URLs and bare URLs with paths/referral params.
  text = text
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(BARE_URL_WITH_PATH_RE, ' ');

  // Drop the caption lines those URLs left behind (`Chat`, `Boost`, `Site`).
  text = stripTrailingLinkCaptions(text);

  // Normalize decorative divider lines (`____`, `----`) and convert bullet markers to ` · `.
  text = text
    .replace(/[_]{3,}|[-]{4,}/g, ' ')
    .replace(/(?:^|\n|\s)(?:[\u2796\u2022\u25AA\u25CF\u25B8\u25BA]\uFE0F?|\u2615\uFE0F?|\u{1F7E2}|-\s+)/gu, ' \u00b7 ');

  // Strip channel promo tails that follow a sentence boundary.
  text = stripChannelPromos(text);

  // Strip dangling empty link/source labels left behind after URL removal.
  // Repeat twice to catch chained labels like `Register : -> Link :`.
  for (let i = 0; i < 2; i++) {
    text = text.replace(
      /(?:[\p{Emoji_Presentation}\p{Extended_Pictographic}]\uFE0F?\s*)*\b(?:Official (?:announcement|link|website|channel)|(?:Check your (?:points|rewards?|airdrop|allocation|eligibility)|Link|Join|Claim) here|Source|Sorce|Link|Links|Register|Apply Now|Apply here|Check Here|Check your Airdrop here|Complete Here|Completed Here|Spend Here|Mint Link|Join Waitlist|Go to|Winnerlist|LFG|More details|Details)\b\s*[:\u2192\u27A1\uFE0F]*\s*(?=(?:\u00b7|\n|$|\b(?:Source|Sorce|Link|Register|Apply|Check|Complete|Done|Official|Join|More)\b))/giu,
      ' ',
    );
  }

  // Strip stray pointer arrows, orphan variation selectors, dangling colons before ` · `, and excess punctuation.
  text = text
    .replace(/[\u27A1\u2192\u{1F449}\u{1F517}\u{1F4D6}\u{1FA82}\u2728]\uFE0F?/gu, ' ')
    .replace(/(^|[\s\u00b7])[\uFE0E\uFE0F]+/gu, '$1')
    .replace(/:\s*(?=\u00b7|$)/g, ' ')
    .replace(/\s*\u00b7\s*/g, ' \u00b7 ')
    .replace(/(?:\s*\u00b7\s*){2,}/g, ' \u00b7 ')
    .replace(/^[\s\u00b7:;,\-|\u2013\u2014]+/, '')
    .replace(/[\s\u00b7:;,\-|\u2013\u2014]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Drop decorative emoji that survived: a leading run, or one glued to the end of a word.
  text = text
    .replace(LEADING_EMOJI_RE, '')
    .replace(new RegExp(String.raw`(\S)${EMOJI_RUN}(?=\s|$|[\u00b7,.;:!?])`, 'gu'), '$1')
    .trim();

  return text;
}

export const DEFAULT_SUMMARY_MAX_LEN = 320;

const SENTENCE_ABBREVIATIONS = new Set([
  'e.g', 'i.e', 'vs', 'etc', 'est', 'approx', 'min', 'max', 'no', 'mr', 'mrs', 'ms', 'dr', 'st', 'inc', 'ltd', 'co', 'u.s',
]);

const DANGLING_CONNECTORS = new Set([
  'and', 'or', 'but', 'nor', 'so', 'yet',
  'with', 'without', 'for', 'of', 'to', 'in', 'on', 'at', 'by', 'from', 'into', 'onto', 'over', 'under', 'via', 'as',
  'a', 'an', 'the',
  'that', 'which', 'who', 'whose', 'where', 'when', 'if', 'than',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'will', 'can', 'may',
  'their', 'your', 'our', 'its', 'this', 'these', 'those',
  'including', 'across', 'through', 'between', 'among', 'about', 'after', 'before', 'during', 'using', 'per',
]);

const TRAILING_CUT_PUNCT_RE = /[\s,;:\-\u2013\u2014(\[\u00b7/+&"'\u2018\u201C]+$/;

function findCleanSentenceEnd(cps: string[], maxLen: number): string | null {
  const minSentenceLen = Math.floor(maxLen * 0.65);
  let bestEndIdx = -1;

  for (let i = minSentenceLen - 1; i < maxLen && i < cps.length; i++) {
    const ch = cps[i];
    if (ch !== '.' && ch !== '!' && ch !== '?') continue;
    const next = cps[i + 1];
    // Require whitespace (or end) after sentence punctuation so decimals ($1.5M) and domains (app.xyz) never split.
    if (next !== undefined && !/\s/.test(next)) continue;

    if (ch === '.') {
      // Skip ellipses ("..") and numeric lists ("1.").
      const prev = i > 0 ? cps[i - 1] : '';
      if (prev === '.' || /[0-9]/.test(prev)) continue;
      // Skip common abbreviations ("e.g.", "vs.", "U.S.") and single-letter initials.
      const prefix = cps.slice(Math.max(0, i - 12), i).join('');
      const wordMatch = prefix.match(/(?:^|\s)([A-Za-z](?:\.[A-Za-z])*|[A-Za-z]{1,8})$/);
      if (wordMatch) {
        const token = wordMatch[1];
        if (token.length === 1 || SENTENCE_ABBREVIATIONS.has(token.toLowerCase())) continue;
      }
    }

    bestEndIdx = i;
  }

  return bestEndIdx >= 0 ? cps.slice(0, bestEndIdx + 1).join('').trimEnd() : null;
}

/**
 * Truncates text cleanly without cutting mid-word or mid-thought (code-point
 * safe so emoji surrogate pairs never split). Prefers a complete sentence
 * boundary (`.` / `!` / `?`) when >= 65% of `maxLen`, otherwise truncates at
 * a word boundary and strips trailing dangling connectors before `…`.
 */
export function truncateAtWordBoundary(text: string, maxLen = DEFAULT_SUMMARY_MAX_LEN): string {
  const trimmed = text.trim();
  const cps = [...trimmed];
  if (cps.length <= maxLen) return trimmed;
  if (maxLen <= 1) return cps.slice(0, Math.max(0, maxLen)).join('');

  const sentenceFit = findCleanSentenceEnd(cps, maxLen);
  if (sentenceFit) return sentenceFit;

  const budget = maxLen - 1;
  const slice = cps.slice(0, budget).join('');
  const nextCp = cps[budget];
  const isExactWordEnd = !nextCp || /\s/.test(nextCp);
  const minBoundary = Math.floor(maxLen * 0.45);
  const lastSpace = slice.lastIndexOf(' ');

  let candidate = isExactWordEnd
    ? slice
    : lastSpace >= minBoundary
      ? slice.slice(0, lastSpace)
      : slice;
  candidate = candidate.replace(TRAILING_CUT_PUNCT_RE, '');

  // Avoid cutting mid-parenthetical like "(TikTok, Instagram…".
  const lastOpenParen = candidate.lastIndexOf('(');
  const lastCloseParen = candidate.lastIndexOf(')');
  if (lastOpenParen > lastCloseParen) {
    const beforeParen = candidate.slice(0, lastOpenParen).replace(TRAILING_CUT_PUNCT_RE, '');
    if ([...beforeParen].length >= minBoundary) {
      candidate = beforeParen;
    }
  }

  const minAfterStrip = Math.floor(maxLen * 0.4);
  for (let step = 0; step < 4; step++) {
    const m = candidate.match(/\s+([A-Za-z0-9'\u2019-]+)$/);
    if (!m || !DANGLING_CONNECTORS.has(m[1].toLowerCase())) break;
    const shortened = candidate.slice(0, m.index).replace(TRAILING_CUT_PUNCT_RE, '');
    if ([...shortened].length < minAfterStrip) break;
    candidate = shortened;
  }

  candidate = candidate.replace(TRAILING_CUT_PUNCT_RE, '');
  if (!candidate) {
    return `${cps.slice(0, budget).join('').trimEnd()}\u2026`;
  }
  if (/[.!?]$/.test(candidate)) {
    return candidate;
  }
  return `${candidate}\u2026`;
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

// Bare status update (`Update Buzzchain.`) or label-only post (`Voice: social`).
const STUB_STATUS_RE = /^(?:update|updated|ping|bump|status|info|news)\s*[:–—-]?\s*[@#$]?\w{1,24}[.!]?$/i;
const STUB_LABEL_RE =
  /^[@#$]?\w{1,24}\s*[:–—-]\s*(?:social|other|update|live|soon|new|claim|airdrop|quest|testnet|mint|points)\s*[.!]?$/i;
// Question openers and Indonesian chat markers that mark a line as banter.
const BANTER_OPENER_RE =
  /^(?:anyone|any|who|what|when|where|why|how|is|are|am|did|does|do|can|could|will|would|has|have|had|apakah|ada|kapan|siapa|berapa|gimana|kenapa|udah|sudah|belum|tolong|btw)\b/i;
const BANTER_MARKER_RE =
  /\b(?:kapan|siapa|berapa|gimana|kenapa|apakah|ada\s+yg|ada\s+yang|udah\s+blm|kah|dong|deh|sih|wkwk|lol|lmao|haha)\b/i;
// Phrasing that turns a short line into an announcement rather than a question.
const LIVE_CUE_RE =
  /\b(?:is|are|now|goes|went)\s+live\b|\bclaim\s+(?:now|your|here|at|free)\b|\bout\s+now\b|\bdown\s+now\b|\bsekarang\b|\blangsung\b/i;

/**
 * A linkless post that carries no action a reader can take: a bare status update,
 * a label-only stub, a thin social repost (follow / join only), or a
 * single-sentence question or banter.
 */
function isLinklessStub(text: string, taskTypes: TaskType[]): boolean {
  if (STUB_STATUS_RE.test(text) || STUB_LABEL_RE.test(text)) return true;

  const plain = text
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\$[A-Z]{2,10}\b/g, ' ')
    .replace(/#[\w]+/g, ' ')
    .replace(/@[A-Za-z0-9_]{2,32}/g, ' ')
    .replace(EMOJI_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = plain.split(' ').filter(Boolean);
  if (words.length === 0) return true;
  if (words.length > 10) return false;

  const isAnnouncement = LIVE_CUE_RE.test(plain);
  if (!isAnnouncement && !taskTypes.some(t => t !== 'other' && t !== 'social') && taskTypes.includes('social')) {
    return true;
  }
  if (isAnnouncement || words.length > 9) return false;
  if (plain.split(/[.!?]+/).filter(s => s.trim()).length > 1) return false;
  return /\?/.test(plain) || BANTER_OPENER_RE.test(plain) || BANTER_MARKER_RE.test(plain);
}

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

  // Linkless stubs carry no action a reader can take (bare status updates,
  // label-only posts, thin social reposts, single-sentence banter).
  if (urls.length === 0 && !hasProjectDomain && isLinklessStub(text, input.taskTypes)) {
    return { isDrop: false, reason: 'linkless-stub' };
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
