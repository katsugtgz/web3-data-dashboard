import type { MarketRow, MarketSection, MarketSector } from '../../../shared/types';
import { FETCH_TIMEOUT_MS, USER_AGENT, fmtInt, fmtIsoDate, fmtPct, fmtPrice, fmtUsd } from '../lib/format';
import { safeHttpUrl, safeHttpsUrl } from '../lib/url';
import { stripOrTranslateCjk } from '../normalize/i18n';
import { truncateAtWordBoundary } from '../normalize/text';

export interface CryptoFetchResult {
  section: MarketSection;
  sectors: MarketSector[];
}

export interface MarketUrls {
  coingeckoMarkets?: string;
  coingeckoCategories?: string;
  coinpaprikaTickers?: string;
  binanceTickers?: string;
  polymarket?: string;
  dexBoosts?: string;
  dexProfiles?: string;
  github?: string;
}

const DEFAULT_URLS = {
  coingeckoMarkets:
    'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=50&page=1&sparkline=false&price_change_percentage=24h',
  coingeckoCategories:
    'https://api.coingecko.com/api/v3/coins/categories?order=market_cap_change_24h_desc',
  coinpaprikaTickers: 'https://api.coinpaprika.com/v1/tickers?quotes=USD',
  binanceTickers: 'https://data-api.binance.vision/api/v3/ticker/24hr',
  polymarket:
    'https://gamma-api.polymarket.com/markets?active=true&closed=false&order=volume24hr&ascending=false&limit=30',
  dexBoosts: 'https://api.dexscreener.com/token-boosts/latest/v1',
  dexProfiles: 'https://api.dexscreener.com/token-profiles/latest/v1',
};

function stableFallbackId(prefix: string, seed: string): string {
  const hash = Array.from(seed)
    .reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7)
    .toString(36);
  return `${prefix}-${hash}`;
}

function errorSummary(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new Error(`Invalid JSON from ${url}: ${String(e)}`);
  }
}

interface CgCoin {
  id: string;
  symbol: string;
  name: string;
  image?: string;
  current_price: number;
  market_cap: number;
  total_volume: number;
  price_change_percentage_24h: number | null;
}

interface CgCategory {
  id: string;
  name: string;
  market_cap: number | null;
  market_cap_change_24h: number | null;
}

interface CoinPaprikaTicker {
  id?: string;
  name?: string;
  symbol?: string;
  rank?: number;
  quotes?: {
    USD?: {
      price?: number | null;
      volume_24h?: number | null;
      market_cap?: number | null;
      percent_change_24h?: number | null;
    };
  };
}

interface BinanceTicker {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string;
  quoteVolume: string;
}

const SAFE_COINPAPRIKA_ID_RE = /^[a-z0-9]{2,12}-[a-z0-9][a-z0-9-]{1,60}$/i;
const SAFE_LLAMA_SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/i;
const SAFE_GH_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const LLAMA_ICON_FALLBACK_PREFIX = 'https://icons.llamao.fi/icons/protocols/';

function llamaSlugIconUrl(slug: string): string | undefined {
  const clean = slug.trim().toLowerCase();
  if (!clean || !SAFE_LLAMA_SLUG_RE.test(clean)) return undefined;
  return `${LLAMA_ICON_FALLBACK_PREFIX}${encodeURIComponent(clean)}?w=48&h=48`;
}

function finiteOrNull(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export async function fetchCryptoSection(nowMs = Date.now(), urls: MarketUrls = {}): Promise<CryptoFetchResult> {
  const cgUrl = urls.coingeckoMarkets ?? DEFAULT_URLS.coingeckoMarkets;
  const catUrl = urls.coingeckoCategories ?? DEFAULT_URLS.coingeckoCategories;
  const paprikaUrl = urls.coinpaprikaTickers ?? DEFAULT_URLS.coinpaprikaTickers;
  const binUrl = urls.binanceTickers ?? DEFAULT_URLS.binanceTickers;

  let cgErr: unknown;
  try {
    const coins = await fetchJson<CgCoin[]>(cgUrl);
    if (!Array.isArray(coins) || coins.length === 0) throw new Error('Empty CoinGecko markets');
    const rows: MarketRow[] = coins.slice(0, 50).map(c => {
      const sym = (stripOrTranslateCjk(c.symbol ?? '') || 'COIN').toUpperCase();
      const name = stripOrTranslateCjk(c.name ?? '') || sym;
      const label = `${name} (${sym})`;
      const id = stripOrTranslateCjk(c.id ?? '') || stableFallbackId('coin', c.id || sym);
      const change24h = finiteOrNull(c.price_change_percentage_24h);
      const icon = safeHttpsUrl(c.image) ?? undefined;
      return {
        id,
        cells: [
          label,
          fmtPrice(c.current_price),
          fmtPct(change24h),
          fmtUsd(c.total_volume),
          fmtUsd(c.market_cap),
        ],
        sortValues: [
          label,
          usdSort(c.current_price),
          change24h,
          usdSort(c.total_volume),
          usdSort(c.market_cap),
        ],
        href: c.id ? `https://www.coingecko.com/en/coins/${encodeURIComponent(c.id)}` : undefined,
        ...(icon ? { icon } : {}),
      };
    });

    let sectors: MarketSector[] = [];
    try {
      const cats = await fetchJson<CgCategory[]>(catUrl);
      if (Array.isArray(cats)) {
        sectors = cats
          .filter(c => typeof c.market_cap === 'number' && c.market_cap > 10_000_000 && typeof c.market_cap_change_24h === 'number')
          .slice(0, 6)
          .map(c => ({
            name: stripOrTranslateCjk(c.name ?? '') || stripOrTranslateCjk(c.id ?? '') || 'Sector',
            change24h: fmtPct(c.market_cap_change_24h),
            marketCap: fmtUsd(c.market_cap ?? 0),
          }));
      }
    } catch {
      sectors = [];
    }

    return {
      section: {
        id: 'crypto',
        title: 'Crypto Market',
        blurb: 'Top 50 cryptocurrencies by market cap plus top 24h sector movers.',
        cols: ['Coin', 'Price', '24h', '24h volume', 'Market cap'],
        rows,
        source: 'CoinGecko',
        sourceUrl: 'https://www.coingecko.com',
        fetchedAt: nowMs,
        stale: false,
      },
      sectors,
    };
  } catch (err) {
    cgErr = err;
    console.warn('markets:crypto primary failed', err);
  }

  let cpErr: unknown;
  try {
    const tickers = await fetchJson<CoinPaprikaTicker[]>(paprikaUrl);
    if (!Array.isArray(tickers) || tickers.length === 0) throw new Error('Empty CoinPaprika tickers');
    const ranked = tickers
      .filter(t => typeof t.quotes?.USD?.market_cap === 'number' && t.quotes.USD.market_cap > 0)
      .sort((a, b) => (b.quotes?.USD?.market_cap ?? 0) - (a.quotes?.USD?.market_cap ?? 0) || (a.rank ?? 9999) - (b.rank ?? 9999))
      .slice(0, 50);
    if (ranked.length === 0) throw new Error('No ranked CoinPaprika USD tickers');

    const rows: MarketRow[] = ranked.map(t => {
      const usd = t.quotes?.USD;
      const sym = (stripOrTranslateCjk(t.symbol ?? '') || 'COIN').toUpperCase();
      const name = stripOrTranslateCjk(t.name ?? '') || sym;
      const label = `${name} (${sym})`;
      const id = stripOrTranslateCjk(t.id ?? '') || stableFallbackId('coin', t.id || sym);
      const price = usd?.price ?? NaN;
      const change24h = finiteOrNull(usd?.percent_change_24h);
      const volume = usd?.volume_24h ?? NaN;
      const marketCap = usd?.market_cap ?? NaN;
      const rawId = (t.id ?? '').trim();
      const icon =
        rawId && SAFE_COINPAPRIKA_ID_RE.test(rawId)
          ? `https://static.coinpaprika.com/coin/${encodeURIComponent(rawId)}/logo.png`
          : undefined;
      return {
        id,
        cells: [label, fmtPrice(price), fmtPct(change24h), fmtUsd(volume), fmtUsd(marketCap)],
        sortValues: [label, usdSort(price), change24h, usdSort(volume), usdSort(marketCap)],
        href: t.id ? `https://coinpaprika.com/coin/${encodeURIComponent(t.id)}` : undefined,
        ...(icon ? { icon } : {}),
      };
    });

    return {
      section: {
        id: 'crypto',
        title: 'Crypto Market',
        blurb: 'Top 50 cryptocurrencies by market cap (CoinPaprika fallback).',
        cols: ['Coin', 'Price', '24h', '24h volume', 'Market cap'],
        rows,
        source: 'CoinPaprika',
        sourceUrl: 'https://coinpaprika.com',
        fetchedAt: nowMs,
        stale: false,
      },
      sectors: [],
    };
  } catch (err) {
    cpErr = err;
    console.warn('markets:crypto coinpaprika fallback failed', err);
  }

  try {
    const tickers = await fetchJson<BinanceTicker[]>(binUrl);
    if (!Array.isArray(tickers) || tickers.length === 0) throw new Error('Empty Binance tickers');
    const usdt = tickers
      .filter(t => t.symbol.endsWith('USDT') && !t.symbol.endsWith('DOWNUSDT') && !t.symbol.endsWith('UPUSDT'))
      .map(t => ({
        rawBase: t.symbol.slice(0, -4),
        base: stripOrTranslateCjk(t.symbol.slice(0, -4)) || 'TOKEN',
        price: Number(t.lastPrice),
        change: Number(t.priceChangePercent),
        vol: Number(t.quoteVolume),
      }))
      .filter(t => Number.isFinite(t.vol) && t.vol > 0)
      .sort((a, b) => b.vol - a.vol)
      .slice(0, 50);

    return {
      section: {
        id: 'crypto',
        title: 'Crypto Market',
        blurb: 'Top 50 USDT spot pairs by 24h quote volume (Binance public fallback).',
        cols: ['Coin', 'Price', '24h', '24h volume', 'Pair'],
        rows: usdt.map(t => {
          const change = Number.isFinite(t.change) ? t.change : null;
          return {
            id: `${t.base}USDT`,
            cells: [t.base, fmtPrice(t.price), fmtPct(change), fmtUsd(t.vol), `${t.base}/USDT`],
            sortValues: [t.base, usdSort(t.price), change, usdSort(t.vol), `${t.base}/USDT`],
            href: `https://www.binance.com/en/trade/${encodeURIComponent(t.rawBase)}_USDT`,
          };
        }),
        source: 'Binance Vision',
        sourceUrl: 'https://data-api.binance.vision',
        fetchedAt: nowMs,
        stale: false,
      },
      sectors: [],
    };
  } catch (binErr) {
    throw new Error(
      `Crypto market fetch failed — CoinGecko: ${errorSummary(cgErr)}; CoinPaprika: ${errorSummary(cpErr)}; Binance: ${errorSummary(binErr)}`,
    );
  }
}

interface PolyMarket {
  question?: string;
  slug?: string;
  conditionId?: string;
  id?: number | string;
  icon?: string;
  image?: string;
  outcomePrices?: string;
  volume24hr?: number | string;
  liquidity?: number | string;
  endDate?: string;
}

/** Numeric sort anchor for USD-formatted cells; null mirrors fmtUsd's absent value. */
function usdSort(amount: number | string | null | undefined): number | null {
  const n = Number(amount ?? NaN);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Numeric anchor for a 0..1 probability; null mirrors parseYesProb's "—". */
function yesProbSort(outcomePrices?: string): number | null {
  if (!outcomePrices) return null;
  try {
    const p = Number(JSON.parse(outcomePrices)[0]);
    return Number.isFinite(p) && p >= 0 && p <= 1 ? p : null;
  } catch {
    return null;
  }
}

/** Unix-ms anchor for an ISO date cell; null mirrors fmtIsoDate's "TBA". */
function isoDateSort(input?: string | null): number | null {
  if (!input) return null;
  const t = Date.parse(input);
  return Number.isNaN(t) ? null : t;
}

function parseYesProb(outcomePrices?: string): string {
  if (!outcomePrices) return '—';
  try {
    const arr = JSON.parse(outcomePrices) as unknown[];
    const p = Number(arr[0]);
    if (Number.isFinite(p) && p >= 0 && p <= 1) {
      if (p > 0 && p < 0.005) return '<1%';
      if (p > 0.995 && p < 1) return '>99%';
      return `${Math.round(p * 100)}%`;
    }
  } catch {
    return '—';
  }
  return '—';
}

/** Pure row mapping for the Polymarket payload: the sort contract's seam. */
export function normalizePredictionRows(markets: PolyMarket[]): MarketRow[] {
  return markets.slice(0, 30).map(m => {
    const icon = safeHttpsUrl(m.icon) ?? safeHttpsUrl(m.image) ?? undefined;
    return {
      // slug (unique, feeds href) > conditionId (contract key) > numeric id.
      id: m.slug ?? m.conditionId ?? (m.id != null ? String(m.id) : undefined),
      cells: [
        stripOrTranslateCjk(m.question ?? 'Market') || 'Market',
        parseYesProb(m.outcomePrices),
        fmtUsd(Number(m.volume24hr ?? 0)),
        fmtUsd(Number(m.liquidity ?? 0)),
        fmtIsoDate(m.endDate),
      ],
      sortValues: [
        stripOrTranslateCjk(m.question ?? 'Market') || 'Market',
        yesProbSort(m.outcomePrices),
        usdSort(m.volume24hr),
        usdSort(m.liquidity),
        isoDateSort(m.endDate),
      ],
      href: m.slug ? `https://polymarket.com/event/${encodeURIComponent(m.slug)}` : undefined,
      ...(icon ? { icon } : {}),
    };
  });
}

export async function fetchPredictionsSection(nowMs = Date.now(), urls: MarketUrls = {}): Promise<MarketSection> {
  const url = urls.polymarket ?? DEFAULT_URLS.polymarket;
  const markets = await fetchJson<PolyMarket[]>(url);
  if (!Array.isArray(markets) || markets.length === 0) throw new Error('Empty Polymarket feed');
  return {
    id: 'predictions',
    title: 'Prediction Markets',
    blurb: 'Active Polymarket event contracts ranked by 24h trading volume.',
    cols: ['Market', 'Yes %', '24h volume', 'Liquidity', 'Ends'],
    rows: normalizePredictionRows(markets),
    source: 'Polymarket',
    sourceUrl: 'https://polymarket.com',
    fetchedAt: nowMs,
    stale: false,
  };
}

interface DexTokenEntry {
  url?: string;
  chainId?: string;
  tokenAddress?: string;
  icon?: string;
  description?: string;
  totalAmount?: number;
  amount?: number;
  links?: { type?: string; label?: string; url?: string }[];
}

function normalizeChainLabel(chainId?: string): string {
  if (!chainId) return 'Unknown';
  const cleaned = stripOrTranslateCjk(chainId);
  if (!cleaned) return 'Unknown';
  const map: Record<string, string> = {
    solana: 'Solana',
    ethereum: 'Ethereum',
    base: 'Base',
    bsc: 'BNB',
    arbitrum: 'Arbitrum',
    optimism: 'Optimism',
    polygon: 'Polygon',
    avalanche: 'Avalanche',
    sui: 'Sui',
    ton: 'TON',
    abstract: 'Abstract',
    sonic: 'Sonic',
  };
  return map[cleaned.toLowerCase()] ?? cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/** Pure row mapping for the DexScreener payload: the sort contract's seam. */
export function normalizeTrendingRows(items: DexTokenEntry[]): MarketRow[] {
  return items.map(it => {
    const chain = normalizeChainLabel(it.chainId);
    const cleanChainId = stripOrTranslateCjk(it.chainId ?? '') || chain.toLowerCase();
    const addr = stripOrTranslateCjk(it.tokenAddress ?? '');
    const shortAddr = addr.length > 10 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
    const boostCount = it.totalAmount ?? it.amount ?? 0;
    const extLink = it.links?.map(l => safeHttpUrl(l.url)).find((u): u is string => u !== null);
    const safeUrl = safeHttpUrl(it.url) ?? undefined;
    const icon = safeHttpsUrl(it.icon) ?? undefined;
    const cleanDesc = it.description ? stripOrTranslateCjk(it.description).replace(/\s+/g, ' ').trim() : '';
    const desc = cleanDesc ? truncateAtWordBoundary(cleanDesc, 96) : '';
    const tokenLabel = desc ? `${shortAddr} · ${desc}` : shortAddr;
    const links = extLink ?? safeUrl ?? '—';
    return {
      id: `${cleanChainId}:${addr.toLowerCase()}`,
      cells: [tokenLabel, chain, boostCount > 0 ? fmtInt(boostCount) : 'Profile', links],
      sortValues: [
        tokenLabel,
        chain,
        boostCount > 0 ? boostCount : null,
        links === '—' ? null : links,
      ],
      chain,
      href: safeUrl,
      ...(icon ? { icon } : {}),
    };
  });
}

export async function fetchTrendingSection(nowMs = Date.now(), urls: MarketUrls = {}): Promise<MarketSection> {
  const [boosts, profiles] = await Promise.all([
    fetchJson<DexTokenEntry[]>(urls.dexBoosts ?? DEFAULT_URLS.dexBoosts),
    fetchJson<DexTokenEntry[]>(urls.dexProfiles ?? DEFAULT_URLS.dexProfiles).catch(() => [] as DexTokenEntry[]),
  ]);
  const merged = new Map<string, DexTokenEntry>();
  for (const entry of [...(Array.isArray(boosts) ? boosts : []), ...(Array.isArray(profiles) ? profiles : [])]) {
    if (!entry.chainId || !entry.tokenAddress) continue;
    const key = `${entry.chainId}:${entry.tokenAddress.toLowerCase()}`;
    const prev = merged.get(key);
    if (!prev) {
      merged.set(key, entry);
    } else if ((entry.totalAmount ?? 0) > (prev.totalAmount ?? 0)) {
      merged.set(key, {
        ...entry,
        icon: entry.icon || prev.icon,
        description: entry.description || prev.description,
        links: entry.links?.length ? entry.links : prev.links,
        url: entry.url || prev.url,
      });
    } else if (
      (!prev.icon && entry.icon) ||
      (!prev.description && entry.description) ||
      (!prev.links?.length && entry.links?.length) ||
      (!prev.url && entry.url)
    ) {
      merged.set(key, {
        ...prev,
        icon: prev.icon || entry.icon,
        description: prev.description || entry.description,
        links: prev.links?.length ? prev.links : entry.links,
        url: prev.url || entry.url,
      });
    }
  }
  const items = [...merged.values()].slice(0, 30);
  if (items.length === 0) throw new Error('Empty DexScreener feed');

  return {
    id: 'trending',
    title: 'Trending Tokens',
    blurb: 'Recently boosted and updated tokens across on-chain DEX pairs.',
    cols: ['Token', 'Chain', 'Boosts', 'Links'],
    rows: normalizeTrendingRows(items),
    source: 'DexScreener',
    sourceUrl: 'https://dexscreener.com',
    fetchedAt: nowMs,
    stale: false,
  };
}

interface GithubSearchResult {
  items?: {
    full_name: string;
    language: string | null;
    stargazers_count: number;
    pushed_at: string;
    html_url: string;
    owner?: {
      avatar_url?: string;
    };
  }[];
}

export async function fetchGithubSection(nowMs = Date.now(), urls: MarketUrls = {}): Promise<MarketSection> {
  const since = new Date(nowMs - 30 * 86400_000).toISOString().slice(0, 10);
  const url =
    urls.github ??
    `https://api.github.com/search/repositories?q=${encodeURIComponent(`(airdrop OR testnet OR sybil OR claimer) web3 pushed:>${since}`)}&sort=updated&order=desc&per_page=30`;
  const body = await fetchJson<GithubSearchResult>(url);
  const items = body.items ?? [];
  if (items.length === 0) throw new Error('Empty GitHub search feed');

  const rows: MarketRow[] = items.slice(0, 30).map(repo => {
    const cleanName = stripOrTranslateCjk(repo.full_name ?? '') || stableFallbackId('repo', repo.full_name ?? '');
    const language = stripOrTranslateCjk(repo.language ?? '') || 'Unknown';
    const rawAvatar = repo.owner?.avatar_url;
    let icon: string | undefined;
    if (rawAvatar != null && rawAvatar !== '') {
      icon = safeHttpsUrl(rawAvatar) ?? undefined;
    } else {
      const owner = cleanName.split('/')[0]?.trim() ?? '';
      if (owner && SAFE_GH_OWNER_RE.test(owner)) {
        icon = `https://github.com/${encodeURIComponent(owner)}.png?size=64`;
      }
    }
    return {
      id: cleanName,
      cells: [
        cleanName,
        language,
        fmtInt(repo.stargazers_count),
        fmtIsoDate(repo.pushed_at),
      ],
      sortValues: [
        cleanName,
        language,
        repo.stargazers_count,
        isoDateSort(repo.pushed_at),
      ],
      href: safeHttpUrl(repo.html_url) ?? undefined,
      ...(icon ? { icon } : {}),
    };
  });

  return {
    id: 'github',
    title: 'GitHub Radar',
    blurb: 'Recently pushed public airdrop, testnet, and tooling repositories.',
    cols: ['Repo', 'Language', 'Stars', 'Updated'],
    rows,
    source: 'GitHub Search',
    sourceUrl: 'https://github.com/search',
    fetchedAt: nowMs,
    stale: false,
  };
}

interface LlamaProtocol {
  id?: number | string;
  slug?: string;
  name?: string;
  logo?: string;
  category?: string;
  chain?: string;
  chains?: string[];
  tvl?: number;
  change_1d?: number | null;
  change_7d?: number | null;
  url?: string;
}

export function normalizeDefiProtocols(raw: unknown, nowMs = Date.now()): MarketSection {
  if (!Array.isArray(raw)) throw new Error('Expected DefiLlama protocols array');
  const rows: MarketRow[] = (raw as LlamaProtocol[])
    .filter(p => p.name && p.category !== 'CEX' && typeof p.tvl === 'number' && p.tvl > 0)
    .sort((a, b) => (b.tvl ?? 0) - (a.tvl ?? 0))
    .slice(0, 50)
    .map(p => {
      const rawChains = Array.isArray(p.chains) && p.chains.length > 0 ? p.chains : p.chain ? [p.chain] : [];
      const cleanedChains = [...new Set(rawChains.map(c => stripOrTranslateCjk(c)).filter(Boolean))];
      const chains = cleanedChains.length > 0 ? cleanedChains : ['Multi-Chain'];
      const chainLabel = chains.length > 2 ? `${chains[0]}, ${chains[1]} +${chains.length - 2}` : chains.join(', ');
      const cleanName = stripOrTranslateCjk(p.name ?? '') || 'Protocol';
      const cleanCategory = stripOrTranslateCjk(p.category ?? 'DeFi') || 'DeFi';
      const cleanSlug = p.slug ? stripOrTranslateCjk(p.slug) : '';
      const cleanId = p.id != null ? stripOrTranslateCjk(String(p.id)) : '';
      const icon =
        p.logo != null && p.logo !== ''
          ? safeHttpsUrl(p.logo) ?? undefined
          : cleanSlug
            ? llamaSlugIconUrl(cleanSlug)
            : undefined;
      return {
        // id must stay zero-CJK too: the p.name fallback can carry Han
        // (slug/id absent on some payloads) and then leaks into snapshots.
        id: cleanSlug || cleanId || stripOrTranslateCjk(p.name ?? '') || stableFallbackId('protocol', p.name ?? ''),
        cells: [
          cleanName,
          cleanCategory,
          chainLabel,
          fmtUsd(p.tvl ?? 0),
          fmtPct(p.change_1d),
          fmtPct(p.change_7d),
        ],
        sortValues: [
          cleanName,
          cleanCategory,
          chainLabel,
          p.tvl ?? null,
          p.change_1d ?? null,
          p.change_7d ?? null,
        ],
        chain: chains[0],
        chains,
        href: safeHttpUrl(p.url) ?? undefined,
        ...(icon ? { icon } : {}),
      };
    });

  return {
    id: 'defi',
    title: 'DeFi TVL',
    blurb: 'Top 50 decentralized protocols ranked by total value locked.',
    cols: ['Protocol', 'Category', 'Chains', 'TVL', '1d', '7d'],
    rows,
    source: 'DefiLlama',
    sourceUrl: 'https://defillama.com',
    fetchedAt: nowMs,
    stale: false,
  };
}

interface LlamaPool {
  pool?: string;
  symbol?: string;
  project?: string;
  chain?: string;
  tvlUsd?: number;
  apy?: number | null;
  ilRisk?: string | null;
  logo?: string;
  icon?: string;
}

interface LlamaPoolsPayload {
  data?: LlamaPool[];
}

function normalizeProtocolSlugKey(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

const YIELD_SLUG_SUFFIX_RE = /-(?:v[1-9]|stake|staking|lending|finance|protocol|swap|dex|earn|vaults?|pools?)$/i;

/**
 * Cross-populates missing `MarketRow.icon` on DefiLlama yields rows from the
 * DeFi TVL protocols section by exact slug, normalized key, or base slug.
 */
export function enrichYieldRowIcons(
  yields: MarketSection,
  defi?: MarketSection | null,
): MarketSection {
  if (!defi?.rows?.length || !yields.rows?.length) return yields;

  const bySlug = new Map<string, string>();
  const byNorm = new Map<string, string>();
  for (const row of defi.rows) {
    const icon = safeHttpsUrl(row.icon);
    if (!icon) continue;
    if (row.id) {
      const slugLower = row.id.trim().toLowerCase();
      if (slugLower && !bySlug.has(slugLower)) bySlug.set(slugLower, icon);
      const normId = normalizeProtocolSlugKey(row.id);
      if (normId.length >= 2 && !byNorm.has(normId)) byNorm.set(normId, icon);
    }
    const name = row.cells?.[0];
    if (name) {
      const normName = normalizeProtocolSlugKey(name);
      if (normName.length >= 2 && !byNorm.has(normName)) byNorm.set(normName, icon);
    }
  }
  if (bySlug.size === 0 && byNorm.size === 0) return yields;

  let changed = false;
  const rows = yields.rows.map(row => {
    const existingIcon = safeHttpsUrl(row.icon);
    const existingIsFallback = Boolean(existingIcon && existingIcon.startsWith(LLAMA_ICON_FALLBACK_PREFIX));
    if (existingIcon && !existingIsFallback) return row;
    const project = (row.cells?.[1] ?? '').trim();
    if (!project) return row;
    const lower = project.toLowerCase();
    const norm = normalizeProtocolSlugKey(project);
    const baseSlug = lower.replace(YIELD_SLUG_SUFFIX_RE, '');
    const icon =
      bySlug.get(lower) ??
      byNorm.get(norm) ??
      (baseSlug.length >= 3 ? bySlug.get(baseSlug) ?? byNorm.get(normalizeProtocolSlugKey(baseSlug)) : undefined);
    if (!icon || icon === existingIcon) return row;
    if (existingIsFallback && icon.startsWith(LLAMA_ICON_FALLBACK_PREFIX)) return row;
    changed = true;
    return { ...row, icon };
  });

  return changed ? { ...yields, rows } : yields;
}

export function normalizeDefiYields(
  raw: unknown,
  nowMs = Date.now(),
  protocolIcons?: ReadonlyMap<string, string>,
): MarketSection {
  const payload = raw as LlamaPoolsPayload | null;
  const list = Array.isArray(payload?.data) ? payload.data : Array.isArray(raw) ? (raw as LlamaPool[]) : null;
  if (!list) throw new Error('Expected DefiLlama yields payload');

  const rows: MarketRow[] = list
    .filter(p => p.symbol && p.project && typeof p.tvlUsd === 'number' && p.tvlUsd > 1_000_000)
    .sort((a, b) => (b.tvlUsd ?? 0) - (a.tvlUsd ?? 0))
    .slice(0, 50)
    .map(p => {
      const cleanSymbol = stripOrTranslateCjk(p.symbol ?? '') || 'Pool';
      const cleanProject = stripOrTranslateCjk(p.project ?? '') || 'Protocol';
      const chain = stripOrTranslateCjk(p.chain ?? '') || 'Multi-Chain';
      const cleanPool = p.pool ? stripOrTranslateCjk(p.pool) : '';
      const mappedIcon =
        protocolIcons?.get(cleanProject.toLowerCase()) ??
        protocolIcons?.get(normalizeProtocolSlugKey(cleanProject));
      const explicitLogo = p.logo ?? p.icon;
      const icon =
        explicitLogo != null && explicitLogo !== ''
          ? safeHttpsUrl(explicitLogo) ?? undefined
          : safeHttpsUrl(mappedIcon) ?? llamaSlugIconUrl(cleanProject);
      return {
        // DefiLlama's stable pool UUID; distinct pools of one protocol get
        // distinct ids. Fallback is a lossy slug only when the upstream omits
        // `pool` (should not happen on current API).
        id:
          cleanPool ||
          `${cleanProject.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${cleanSymbol}`,
        cells: [
          cleanSymbol,
          cleanProject,
          chain,
          fmtUsd(p.tvlUsd ?? 0),
          fmtPct(p.apy).replace(/^\+/, ''),
          p.ilRisk === 'yes' ? 'Yes' : p.ilRisk === 'no' ? 'No' : '—',
        ],
        sortValues: [
          cleanSymbol,
          cleanProject,
          chain,
          p.tvlUsd ?? null,
          p.apy ?? null,
          p.ilRisk === 'yes' ? 1 : p.ilRisk === 'no' ? 0 : null,
        ],
        chain,
        href: p.pool ? `https://defillama.com/yields/pool/${encodeURIComponent(p.pool)}` : undefined,
        ...(icon ? { icon } : {}),
      };
    });

  return {
    id: 'yields',
    title: 'Yields & Liquidity',
    blurb: 'Top 50 liquidity pools with > $1M TVL ranked by depth.',
    cols: ['Pool', 'Project', 'Chain', 'TVL', 'APY', 'IL risk'],
    rows,
    source: 'DefiLlama Yields',
    sourceUrl: 'https://defillama.com/yields',
    fetchedAt: nowMs,
    stale: false,
  };
}
