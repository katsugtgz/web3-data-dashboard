import type { AirdropFeed, Card, CardTask, FeedItem, FeedResponse, Tge } from './types';

/**
 * Single source of truth for hard-filtering gambling, casino, sportsbook,
 * lottery, and prediction-market betting airdrops across ingestion, live API
 * serving, static snapshot generation, GitHub Pages build gates, CI, and UI.
 */

export const GAMBLING_TLDS: ReadonlySet<string> = new Set([
  'bet',
  'casino',
  'poker',
  'bingo',
  'lotto',
]);

export const GAMBLING_SUBDOMAIN_LABELS: ReadonlySet<string> = new Set([
  'bet',
  'bets',
  'betting',
  'casino',
  'casinos',
  'poker',
  'slots',
  'sportsbook',
  'gamble',
  'gambling',
  'gamblefi',
  'lottery',
  'lotto',
  'predictions',
  'predict',
]);

/**
 * Canonical registrable domains for crypto casinos, sportsbooks, GambleFi
 * protocols, lotteries, and event/prediction betting platforms.
 * Matched against exact hostname and subdomains (`foo.yeet.com` -> `yeet.com`).
 */
export const GAMBLING_DOMAINS: ReadonlySet<string> = new Set([
  // Crypto casinos, sportsbooks & GambleFi
  'yeet.com',
  'stake.com',
  'stake.us',
  'rollbit.com',
  'shuffle.com',
  'bc.game',
  'bcgame.top',
  'bc.fun',
  'duelbits.com',
  'roobet.com',
  'cloudbet.com',
  'betfury.io',
  'betfury.com',
  'bitcasino.io',
  'sportsbet.io',
  'mbitcasino.io',
  '7bitcasino.com',
  'wild.io',
  'metawin.com',
  'gamdom.com',
  'csgoempire.com',
  'rainbet.com',
  'razed.com',
  'chips.gg',
  'betmode.io',
  'betfin.network',
  'tg.casino',
  'megadice.com',
  'luckyblock.com',
  'wsmcasino.com',
  'coinpoker.com',
  'pokernow.club',
  'betpanda.io',
  'cryptorino.io',
  'jackbit.com',
  'flush.com',
  'vave.com',
  'winz.io',
  'weiss.bet',
  'bets.io',
  'fairspin.io',
  'solcasino.io',
  'degen.bet',
  'whalecasino.com',
  'monkeytilt.com',
  'thrill.com',
  'spartans.com',
  'bovada.lv',
  'bet365.com',
  'draftkings.com',
  'fanduel.com',
  'betmgm.com',
  '1xbet.com',
  'pinnacle.com',
  'betsson.com',
  'betano.com',
  'unibet.com',
  'betfair.com',
  'smarkets.com',
  'matchbook.com',
  'azuro.org',
  'azuro.io',
  'sx.bet',
  'overtime.io',
  'overtimemarkets.xyz',
  'bookmaker.xyz',
  'dexwin.bet',
  'divvy.bet',
  'purebet.io',
  'betdex.com',
  'winr.games',
  'just.bet',
  'zkasino.io',
  'degencoinflip.com',
  'solanashuffle.com',
  'doubleup.fun',
  'flip.gg',
  'loot.bet',
  'gambit.trade',
  'gamblefi.io',
  'pooltogether.com',
  // Prediction markets & event betting platforms
  'polymarket.com',
  'polymarket.us',
  'kalshi.com',
  'kalshi.co',
  '42.space',
  'melee.markets',
  'kairos.trade',
  'xo.market',
  'myriad.markets',
  'outcome.market',
  'outcome.xyz',
  'blinq.fi',
  'catalyst.markets',
  'upshot.cards',
  'touch.market',
  'world.xyz',
  'predict.fun',
  'forecastprotocol.xyz',
  'hit.one',
  'tf.xyz',
  'limitless.exchange',
  'opinion.trade',
  'opinionlabs.xyz',
  'probable.markets',
  'manifold.markets',
  'metaculus.com',
  'augur.net',
  'zeitgeist.pm',
  'hedgehog.markets',
  'polkamarkets.com',
  'plotx.io',
  'futuur.com',
  'insightprediction.com',
  'truemarkets.org',
  'predictit.org',
]);

/**
 * Unambiguous normalized alphanumeric keys for gambling/casino/betting/prediction
 * projects, catching entries whose URL is a generic Google Form / Tally / Discord.
 */
export const GAMBLING_PROJECT_KEYS: ReadonlySet<string> = new Set([
  'yeet',
  'yeetcasino',
  'rollbit',
  'duelbits',
  'roobet',
  'cloudbet',
  'betfury',
  'bitcasino',
  'sportsbet',
  'mbitcasino',
  '7bitcasino',
  'metawin',
  'gamdom',
  'csgoempire',
  'rainbet',
  'razed',
  'betmode',
  'betfin',
  'tgcasino',
  'megadice',
  'luckyblock',
  'wsmcasino',
  'coinpoker',
  'pokernow',
  'betpanda',
  'cryptorino',
  'jackbit',
  'fairspin',
  'solcasino',
  'whalecasino',
  'monkeytilt',
  'zkasino',
  'azuro',
  'sxbet',
  'overtimemarkets',
  'purebet',
  'betdex',
  'justbet',
  'degencoinflip',
  'solanashuffle',
  'pooltogether',
  'draftkings',
  'fanduel',
  'bet365',
  'betmgm',
  '1xbet',
  'bovada',
  'pinnacle',
  'betsson',
  'betano',
  'unibet',
  'betfair',
  'smarkets',
  'matchbook',
  'polymarket',
  'kalshi',
  'melee',
  'meleemarkets',
  'xomarket',
  'myriad',
  'myriadmarkets',
  'outcomemarket',
  'catalystmarkets',
  'touchmarket',
  'predictfun',
  'forecastprotocol',
  'alkimiya',
  '42prevalkimiya',
  'blinq',
  'turboflow',
  'worldxyz',
  'limitlessexchange',
  'opiniontrade',
  'probablemarkets',
  'manifoldmarkets',
  'polkamarkets',
  'truemarkets',
  'predictit',
]);

const GAMBLING_CATEGORIES: ReadonlySet<string> = new Set([
  'gambling',
  'casino',
  'casinos',
  'betting',
  'gaming / betting',
  'sportsbook',
  'sportsbooks',
  'lottery',
  'lotto',
  'gamblefi',
  'igaming',
  'i-gaming',
  'prediction',
  'predictions',
  'prediction market',
  'prediction markets',
  'betting stake',
]);

// Non-betting English words ending in `bet` that must never trigger compound `*bet` matching.
const SAFE_BET_SUFFIX_WORDS: ReadonlySet<string> = new Set([
  'alphabet',
  'alphabets',
  'tibet',
  'sherbet',
  'sorbet',
  'gibbet',
  'corbet',
  'barbet',
  'elizabeth',
  'macbeth',
]);

// Built from code points so neither source nor Vite dist bundles ever emit literal CJK characters.
const GAMBLING_CJK_RE = new RegExp(
  [
    [0x535a, 0x5f69], // gambling/betting
    [0x8d4c, 0x535a], // gambling
    [0x8d4c, 0x573a], // casino
    [0x83e0, 0x83dc], // gambling slang
    [0x5f69, 0x7968], // lottery
    [0x9884, 0x6d4b, 0x5e02, 0x573a], // prediction market
    [0x62bc, 0x6ce8], // wager
    [0x4e0b, 0x6ce8], // place bet
    [0x7ade, 0x731c], // sports betting/quiz
  ]
    .map(codes => String.fromCharCode(...codes))
    .join('|'),
);
const GAMBLING_CJK_CATEGORY_RE = new RegExp(
  `^(?:${[
    [0x9884, 0x6d4b],
    [0x9884, 0x6d4b, 0x5e02, 0x573a],
    [0x535a, 0x5f69],
    [0x8d4c, 0x535a],
    [0x8d4c, 0x573a],
    [0x5f69, 0x7968],
    [0x7ade, 0x731c],
  ]
    .map(codes => String.fromCharCode(...codes))
    .join('|')})$`,
);

const GAMBLING_HOST_COMPOUND_RE =
  /(?:casino|sportsbook|gambl|poker|roulette|blackjack|baccarat|lottery|lotto|plinko|jackpot|parlay|betting|wager|predict|igaming)/i;

const GAMBLING_URL_PATH_RE =
  /(?:^|\/)(?:casino|casinos|sportsbook|betting|bets|bet|poker|slots|roulette|blackjack|baccarat|lottery|lotto|wager|wagering|parlay|parlays|gamble|gambling|gamblefi|prediction|predictions|prediction-market|prediction-markets)(?:\/|$)/i;

const SOCIAL_OR_QUEST_HOSTS: ReadonlySet<string> = new Set([
  'x.com',
  'twitter.com',
  't.me',
  'telegram.me',
  'galxe.com',
  'app.galxe.com',
  'zealy.io',
  'guild.xyz',
  'discord.gg',
]);

const GAMBLING_NAME_WORD_RE =
  /\b(?:bet|bets|betting|casino|casinos|gambl(?:e|er|ers|ing)|gamblefi|igaming|i-gaming|poker|slots?|roulette|blackjack|baccarat|craps|keno|plinko|sportsbook|sportsbooks|bookmaker|bookmakers|bookie|bookies|wager|wagers|wagering|lottery|lotteries|lotto|jackpot|jackpots|sweepstakes?|parlay|parlays|parimutuel|predict|predictions?)\b/i;

const GAMBLING_CAMEL_BET_RE = /^Bet[A-Z0-9]/;

export const GAMBLING_TEXT_RE =
  /\b(?:casino|casinos|gambl(?:e|er|ers|ing)|gamblefi|igaming|i-gaming|sportsbook|sportsbooks|bookmaker|bookmakers|bookie|bookies|wager|wagers|wagering|slot\s+machines?|(?:online|crypto|web3|casino)\s+slots?|slots\s+and\s+(?:roulette|blackjack|poker)|roulette|blackjack|baccarat|craps|keno|plinko|crash\s+game|dice\s+game|(?:online|crypto|web3)\s+poker|texas\s+hold['\u2019]?em|live\s+dealer|provably\s+fair|jackpot|jackpots|sweepstakes?|parlay|parlays|parimutuel|punter|punters|betting|place\s+(?:a\s+)?bets?|(?:sports|crypto|on-?chain|event|binary)\s+bets?|bet[- ]to[- ]earn|bet\s+on\s+(?:sports|crypto|events|outcomes|matches|games|politics)|lottery|lotteries|lotto|powerball|prediction\s+markets?|predictions?\s+market|predict[- ]to[- ]earn|world\s+cup\s+predict(?:\s+arena)?|coinbase\s+predict|kairos\s+predictions|polymarket|kalshi|rollbit|duelbits|roobet|cloudbet|betfury|bitcasino|sportsbet|metawin|gamdom|rainbet|betmode|megadice|luckyblock|coinpoker|zkasino|azuro|predict\.fun|yeet\s+casino)\b/i;

function normalizeKey(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function stripParenthetical(raw: string): string {
  return raw.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseUrlLenient(raw?: string | null): URL | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  try {
    if (/^https?:\/\//i.test(trimmed)) return new URL(trimmed);
    if (/^[a-z0-9](?:[a-z0-9-]*\.)+[a-z]{2,}(?:[/?#].*)?$/i.test(trimmed)) {
      return new URL(`https://${trimmed}`);
    }
    return null;
  } catch {
    return null;
  }
}

function extractHostname(raw?: string | null): string | null {
  if (!raw) return null;
  const parsed = parseUrlLenient(raw);
  if (parsed?.hostname) {
    return parsed.hostname.toLowerCase().replace(/\.+$/, '').replace(/^www\./, '') || null;
  }
  const trimmed = raw.trim().toLowerCase().replace(/\.+$/, '').replace(/^www\./, '');
  if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(trimmed)) return trimmed;
  return null;
}

function isGamblingBetSuffixToken(lowerToken: string): boolean {
  if (lowerToken.length < 5) return false;
  if (SAFE_BET_SUFFIX_WORDS.has(lowerToken)) return false;
  return /^[a-z0-9]{2,}bets?$/.test(lowerToken);
}

/**
 * True when a hostname or URL belongs to a known gambling, casino, sportsbook,
 * lottery, or prediction-market betting domain, TLD, or subdomain.
 */
export function isGamblingDomain(hostOrUrl?: string | null): boolean {
  const host = extractHostname(hostOrUrl);
  if (!host) return false;

  const labels = host.split('.').filter(Boolean);
  if (labels.length < 2) return false;

  const tld = labels[labels.length - 1];
  if (GAMBLING_TLDS.has(tld)) return true;

  for (let i = 0; i < labels.length - 1; i++) {
    const label = labels[i];
    if (GAMBLING_SUBDOMAIN_LABELS.has(label)) return true;
    if (GAMBLING_HOST_COMPOUND_RE.test(label)) return true;
    if (isGamblingBetSuffixToken(label)) return true;
  }

  for (let i = 0; i <= labels.length - 2; i++) {
    const candidate = labels.slice(i).join('.');
    if (GAMBLING_DOMAINS.has(candidate)) return true;
  }

  return false;
}

/**
 * True when a URL points to a gambling domain OR a gambling/betting/prediction
 * subpath (e.g. `coinbase.com/predictions`, `jup.ag/prediction`, `x.com/Polymarket/...`).
 */
export function isGamblingTaskUrl(rawUrl?: string | null): boolean {
  if (!rawUrl) return false;
  if (isGamblingDomain(rawUrl)) return true;

  const parsed = parseUrlLenient(rawUrl);
  if (!parsed) return false;

  const pathname = parsed.pathname;
  if (GAMBLING_URL_PATH_RE.test(pathname)) return true;

  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (SOCIAL_OR_QUEST_HOSTS.has(host)) {
    const segments = pathname.split('/').filter(Boolean);
    const slug =
      (host === 'galxe.com' || host === 'app.galxe.com') && segments[0]?.toLowerCase() === 'quest'
        ? segments[1]
        : host === 'zealy.io' && segments[0]?.toLowerCase() === 'cw'
          ? segments[1]
          : segments[0];
    if (slug) {
      const slugNorm = normalizeKey(slug);
      if (GAMBLING_PROJECT_KEYS.has(slugNorm) || GAMBLING_HOST_COMPOUND_RE.test(slug)) {
        return true;
      }
    }
  }

  return false;
}

export function isGamblingCategory(category?: string | null): boolean {
  if (!category) return false;
  const trimmed = category.trim();
  if (!trimmed) return false;
  if (GAMBLING_CATEGORIES.has(trimmed.toLowerCase())) return true;
  if (GAMBLING_CJK_CATEGORY_RE.test(trimmed)) return true;
  return isGamblingText(trimmed);
}

export function isGamblingText(text?: string | null): boolean {
  if (!text) return false;
  return GAMBLING_TEXT_RE.test(text) || GAMBLING_CJK_RE.test(text);
}

export function isGamblingProjectName(name?: string | null): boolean {
  if (!name) return false;
  const trimmed = name.trim();
  if (!trimmed) return false;

  if (GAMBLING_CJK_RE.test(trimmed)) return true;

  const stripped = stripParenthetical(trimmed);
  for (const variant of [trimmed, stripped]) {
    const key = normalizeKey(variant);
    if (key && GAMBLING_PROJECT_KEYS.has(key)) return true;
    if (GAMBLING_NAME_WORD_RE.test(variant)) return true;
  }

  // Catch compound brand names like `SolBet`, `BetFury`, `MegaCasino`, `PredictFun`.
  const tokens = trimmed.split(/[^A-Za-z0-9]+/).filter(Boolean);
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (GAMBLING_HOST_COMPOUND_RE.test(lower)) return true;
    if (GAMBLING_CAMEL_BET_RE.test(token)) return true;
    if (isGamblingBetSuffixToken(lower)) return true;
  }

  return false;
}

export function isGamblingTask(task: Pick<CardTask, 'title' | 'type' | 'url'>): boolean {
  if (task.type?.trim().toLowerCase() === 'predictions') return true;
  if (isGamblingTaskUrl(task.url)) return true;
  if (isGamblingText(task.title)) return true;
  return false;
}

/**
 * True when an airdrop card represents a gambling, casino, sportsbook, lottery,
 * or prediction-market betting project as a whole.
 */
export function isGamblingCard(card: Card): boolean {
  if (isGamblingProjectName(card.n)) return true;
  if (isGamblingDomain(card.url)) return true;
  if (card.best?.ty?.trim().toLowerCase() === 'predictions') return true;
  if (card.taskTypes && card.taskTypes.length > 0 && card.taskTypes.every(t => t.trim().toLowerCase() === 'predictions')) {
    return true;
  }
  if (isGamblingText(card.description)) return true;

  if (card.tasks && card.tasks.length > 0) {
    if (card.tasks.some(t => isGamblingDomain(t.url))) return true;
    if (card.tasks.every(t => isGamblingTask(t))) return true;
  } else {
    if (isGamblingTaskUrl(card.url)) return true;
    if (isGamblingText(card.best?.n)) return true;
  }

  return false;
}

function isClosedTaskStatus(status?: string): boolean {
  return /^(?:closed|ended)$/i.test((status ?? '').trim());
}

function formatTaskCost(cost: number): string {
  return Number.isFinite(cost) && cost > 0 ? `$${cost}` : 'Free';
}

function formatTaskMinutes(timeMinutes: number | null): string {
  return typeof timeMinutes === 'number' && Number.isFinite(timeMinutes) && timeMinutes > 0
    ? `${timeMinutes} min`
    : '—';
}

/**
 * Drops gambling/betting/casino cards completely and strips individual betting /
 * prediction tasks from surviving multi-product cards (e.g. Base, Jupiter).
 */
export function sanitizeAirdropCard(card: Card): Card | null {
  if (isGamblingCard(card)) return null;

  const hasPredictionsType = Boolean(card.taskTypes?.some(t => t.trim().toLowerCase() === 'predictions'));
  const origTasks = card.tasks;

  if (origTasks && origTasks.length > 0) {
    const keptTasks = origTasks.filter(t => !isGamblingTask(t));
    if (keptTasks.length === 0) return null;

    const tasksChanged = keptTasks.length !== origTasks.length;
    const urlNeedsReplace = isGamblingTaskUrl(card.url);
    const bestNeedsReplace =
      card.best.ty.trim().toLowerCase() === 'predictions' ||
      isGamblingText(card.best.n) ||
      urlNeedsReplace;

    if (!tasksChanged && !hasPredictionsType && !bestNeedsReplace) {
      return card;
    }

    const openCount = keptTasks.filter(t => !isClosedTaskStatus(t.status)).length;
    const typeSet = new Set<string>();
    for (const t of keptTasks) {
      const ty = t.type?.trim();
      if (ty && ty.toLowerCase() !== 'predictions') typeSet.add(ty);
    }

    let nextBest = card.best;
    let nextCostNum = card.costNum;
    let nextUrl = card.url;

    if (bestNeedsReplace) {
      const candidate = keptTasks.find(t => !isClosedTaskStatus(t.status)) ?? keptTasks[0];
      nextBest = {
        n: candidate.title,
        ty: candidate.type || 'other',
        c: formatTaskCost(candidate.cost),
        m: formatTaskMinutes(candidate.timeMinutes),
      };
      nextCostNum = candidate.cost;
      if (urlNeedsReplace || !nextUrl) {
        nextUrl = candidate.url ?? null;
      }
    }

    const nextTaskTypes =
      typeSet.size > 0
        ? [...typeSet]
        : nextBest.ty && nextBest.ty.toLowerCase() !== 'predictions'
          ? [nextBest.ty]
          : ['other'];

    return {
      ...card,
      tk: `${openCount}/${keptTasks.length}`,
      best: nextBest,
      costNum: nextCostNum,
      taskTypes: nextTaskTypes,
      tasks: keptTasks,
      url: nextUrl,
    };
  }

  if (hasPredictionsType) {
    const nextTypes = (card.taskTypes ?? []).filter(t => t.trim().toLowerCase() !== 'predictions');
    if (nextTypes.length === 0) return null;
    return {
      ...card,
      taskTypes: nextTypes,
    };
  }

  return card;
}

export function isGamblingTge(tge: Pick<Tge, 'n' | 't' | 's' | 'url'>): boolean {
  if (isGamblingProjectName(tge.n)) return true;
  if (isGamblingTaskUrl(tge.url)) return true;
  if (isGamblingText(tge.n) || isGamblingText(tge.s)) return true;
  return false;
}

export interface GamblingPostInput {
  project?: string | null;
  domain?: string | null;
  text?: string | null;
  urls?: readonly (string | null | undefined)[];
}

export function isGamblingPost(input: GamblingPostInput): boolean {
  if (isGamblingProjectName(input.project)) return true;
  if (isGamblingDomain(input.domain)) return true;
  if (input.urls && input.urls.some(u => isGamblingTaskUrl(u))) return true;
  if (isGamblingText(input.text)) return true;
  return false;
}

export function isGamblingFeedItem(
  item: Pick<FeedItem, 'project' | 'domain' | 'summary' | 'links' | 'ogTitle' | 'ogDescription' | 'steps'>,
): boolean {
  const combinedText = [item.summary, item.ogTitle, item.ogDescription, ...(item.steps ?? [])]
    .filter(Boolean)
    .join('\n');
  return isGamblingPost({
    project: item.project,
    domain: item.domain,
    text: combinedText,
    urls: (item.links ?? []).map(l => l.url),
  });
}

/**
 * Hard-filters an entire AirdropFeed: removes gambling/casino/betting cards and
 * TGE entries, strips prediction/betting tasks from surviving multi-product
 * cards, renumbers surviving ranks, and recomputes counts.
 */
export function filterGamblingAirdropFeed(feed: AirdropFeed): AirdropFeed {
  const origCards = Array.isArray(feed.cards) ? feed.cards : [];
  const origTge = Array.isArray(feed.tge) ? feed.tge : [];

  let changed = false;
  const keptCards: Card[] = [];
  for (const card of origCards) {
    const clean = sanitizeAirdropCard(card);
    if (!clean) {
      changed = true;
      continue;
    }
    if (clean !== card) changed = true;
    keptCards.push(clean);
  }

  const keptTge = origTge.filter(entry => !isGamblingTge(entry));
  if (keptTge.length !== origTge.length) changed = true;

  if (!changed) return feed;

  const rankedCards = keptCards.map((c, idx) => (c.r === idx + 1 ? c : { ...c, r: idx + 1 }));
  return {
    ...feed,
    cards: rankedCards,
    tge: keptTge,
    counts: {
      active: rankedCards.length,
      preToken: rankedCards.filter(c => !c.b?.includes('token')).length,
    },
    fetchedAt: feed.fetchedAt,
  };
}

export function filterGamblingFeedItems(items: FeedItem[]): FeedItem[] {
  let changed = false;
  const kept: FeedItem[] = [];
  for (const item of items) {
    if (isGamblingFeedItem(item)) {
      changed = true;
      continue;
    }
    kept.push(item);
  }
  return changed ? kept : items;
}

/**
 * Strict validator for CI, snapshot generation, and GitHub Pages builds.
 * Returns human-readable violation strings; empty array means clean.
 */
export function findGamblingAirdropViolations(feed: AirdropFeed): string[] {
  const violations: string[] = [];
  for (const card of feed.cards ?? []) {
    if (isGamblingCard(card)) {
      violations.push(`airdrops.cards[#${card.r} ${card.n}] matched gambling/betting card filter`);
      continue;
    }
    if (card.best?.ty?.trim().toLowerCase() === 'predictions') {
      violations.push(`airdrops.cards[#${card.r} ${card.n}] has predictions best.ty`);
    }
    if (card.taskTypes?.some(t => t.trim().toLowerCase() === 'predictions')) {
      violations.push(`airdrops.cards[#${card.r} ${card.n}] has predictions in taskTypes`);
    }
    if (isGamblingTaskUrl(card.url)) {
      violations.push(`airdrops.cards[#${card.r} ${card.n}] has gambling/betting url ${card.url}`);
    }
    if (isGamblingText(card.best?.n)) {
      violations.push(`airdrops.cards[#${card.r} ${card.n}] has gambling/betting best.n "${card.best.n}"`);
    }
    for (const task of card.tasks ?? []) {
      if (isGamblingTask(task)) {
        violations.push(`airdrops.cards[#${card.r} ${card.n}] has gambling/betting task "${task.title}" (${task.type})`);
      }
    }
  }

  for (const tge of feed.tge ?? []) {
    if (isGamblingTge(tge)) {
      violations.push(`airdrops.tge[${tge.n}] matched gambling/betting TGE filter`);
    }
  }

  return violations;
}

export function findGamblingFeedViolations(feed: Pick<FeedResponse, 'items'>): string[] {
  const violations: string[] = [];
  for (const item of feed.items ?? []) {
    if (isGamblingFeedItem(item)) {
      violations.push(`feed.items[${item.id} ${item.project}] matched gambling/betting drop filter`);
    }
  }
  return violations;
}
