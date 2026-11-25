export type SvgPrimitive =
  | {
      tag: 'path';
      d: string;
      fill?: string;
      stroke?: string;
      strokeWidth?: number;
      opacity?: number;
      fillRule?: 'evenodd' | 'nonzero';
      strokeLinecap?: 'round' | 'butt' | 'square';
      strokeLinejoin?: 'round' | 'miter' | 'bevel';
    }
  | {
      tag: 'circle';
      cx: number;
      cy: number;
      r: number;
      fill?: string;
      stroke?: string;
      strokeWidth?: number;
      opacity?: number;
    }
  | {
      tag: 'rect';
      x: number;
      y: number;
      width: number;
      height: number;
      rx?: number;
      fill?: string;
      stroke?: string;
      strokeWidth?: number;
      opacity?: number;
      transform?: string;
    }
  | {
      tag: 'polygon';
      points: string;
      fill?: string;
      stroke?: string;
      strokeWidth?: number;
      opacity?: number;
    }
  | {
      tag: 'line';
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      stroke?: string;
      strokeWidth?: number;
      opacity?: number;
      strokeLinecap?: 'round' | 'butt' | 'square';
    }
  | {
      tag: 'ellipse';
      cx: number;
      cy: number;
      rx: number;
      ry: number;
      fill?: string;
      stroke?: string;
      strokeWidth?: number;
      opacity?: number;
      transform?: string;
    };

export interface CryptoVisual {
  symbol: string;
  name: string;
  bg: string;
  bgEnd?: string;
  fg: string;
  accent?: string;
  shapes: readonly SvgPrimitive[];
}

export interface ChainVisual {
  id: string;
  label: string;
  shortLabel: string;
  color: string;
  bgTint: string;
  shapes: readonly SvgPrimitive[];
}

export type SourceIconKind =
  | 'telegram'
  | 'x'
  | 'github'
  | 'globe'
  | 'rss'
  | 'sheet'
  | 'compass'
  | 'coins'
  | 'layers'
  | 'percent'
  | 'target'
  | 'trending'
  | 'sparkles'
  | 'radar'
  | 'flame'
  | 'database';

export interface SourceVisual {
  id: string;
  label: string;
  iconKind: SourceIconKind;
  color: string;
}

export type GeometricKind = 'hex' | 'diamond' | 'orbit' | 'prism' | 'shield' | 'cube' | 'wave' | 'spark';

export interface BrandPalette {
  bgStart: string;
  bgEnd: string;
  accent: string;
  fg: string;
}

export interface LogoIndexCardInput {
  n: string;
  t?: string | null;
  img?: string | null;
  url?: string | null;
}

export interface LogoIndexTgeInput {
  n: string;
  t?: string | null;
  logo?: string | null;
  url?: string | null;
}

export interface LogoIndexMarketRowInput {
  id?: string;
  cells: readonly string[];
  icon?: string | null;
  logo?: string | null;
  img?: string | null;
  href?: string;
  chain?: string;
  chains?: readonly string[];
}

export interface LogoIndexMarketSectionInput {
  id: string;
  rows: readonly LogoIndexMarketRowInput[];
}

export interface LogoIndexFeedItemInput {
  project: string;
  ticker?: string | null;
  domain?: string | null;
  logo?: string | null;
  links?: readonly { url: string; known?: boolean }[];
}

export interface ProjectLogoEntry {
  logoUrl?: string;
  ticker?: string;
  name?: string;
}

export interface ProjectLogoIndex {
  byName: Map<string, ProjectLogoEntry>;
  byDomain: Map<string, ProjectLogoEntry>;
  byTicker: Map<string, ProjectLogoEntry>;
}

export interface ResolveEntityVisualInput {
  name?: string | null;
  ticker?: string | null;
  symbol?: string | null;
  id?: string | null;
  protocolSlug?: string | null;
  source?: string | null;
  img?: string | null;
  logo?: string | null;
  icon?: string | null;
  url?: string | null;
  domain?: string | null;
  chain?: string | null;
  sectionId?: string | null;
  logoIndex?: ProjectLogoIndex | null;
}

export interface ResolvedEntityVisual {
  imageUrls: string[];
  cryptoVisual: CryptoVisual | null;
  chainVisual: ChainVisual | null;
  isChainEntity: boolean;
  monogram: string;
  palette: BrandPalette;
  geometricKind: GeometricKind;
  resolvedTicker: string | null;
}

interface CryptoSpec {
  visual: CryptoVisual;
  aliases: readonly string[];
}

interface ChainSpec {
  visual: ChainVisual;
  aliases: readonly string[];
}

// Reusable vector glyph builders in 32x32 viewBox for crisp 0ms coin marks
const BTC_SHAPES: readonly SvgPrimitive[] = [
  { tag: 'path', d: 'M13 8v16M17.2 8v16', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' },
  {
    tag: 'path',
    d: 'M11 10.5h7.2a3 3 0 0 1 0 5.5H11m0 0h7.8a3.2 3.2 0 0 1 0 6H11',
    stroke: 'currentColor',
    strokeWidth: 2.3,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  },
];

const ETH_SHAPES: readonly SvgPrimitive[] = [
  { tag: 'polygon', points: '16,5.5 9.5,16.2 16,19.8 22.5,16.2', fill: 'currentColor' },
  { tag: 'polygon', points: '16,5.5 16,19.8 22.5,16.2', fill: '#000000', opacity: 0.14 },
  { tag: 'polygon', points: '16,21.5 9.5,17.8 16,26.5 22.5,17.8', fill: 'currentColor', opacity: 0.92 },
  { tag: 'polygon', points: '16,21.5 16,26.5 22.5,17.8', fill: '#000000', opacity: 0.18 },
];

const DOLLAR_RING_SHAPES: readonly SvgPrimitive[] = [
  { tag: 'path', d: 'M11.8 9.2a7.8 7.8 0 0 0 0 13.6M20.2 9.2a7.8 7.8 0 0 1 0 13.6', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' },
  { tag: 'line', x1: 16, y1: 8.5, x2: 16, y2: 23.5, stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round' },
  {
    tag: 'path',
    d: 'M18.6 12.2c0-1.2-1.15-2-2.6-2s-2.6.8-2.6 2c0 1.3 1.1 1.7 2.6 2.1s2.6.9 2.6 2.2c0 1.25-1.15 2.1-2.6 2.1s-2.6-.8-2.6-2',
    stroke: 'currentColor',
    strokeWidth: 1.9,
    strokeLinecap: 'round',
  },
];

const TETHER_SHAPES: readonly SvgPrimitive[] = [
  { tag: 'path', d: 'M9.5 10.5h13M16 10.5v13', stroke: 'currentColor', strokeWidth: 2.6, strokeLinecap: 'round' },
  { tag: 'ellipse', cx: 16, cy: 15.8, rx: 7.5, ry: 2.4, stroke: 'currentColor', strokeWidth: 1.9 },
];

const SOL_SHAPES: readonly SvgPrimitive[] = [
  { tag: 'polygon', points: '9.5,11.5 21,11.5 23,8.8 11.5,8.8', fill: 'currentColor' },
  { tag: 'polygon', points: '22.5,17.4 11,17.4 9,14.6 20.5,14.6', fill: 'currentColor' },
  { tag: 'polygon', points: '9.5,23.2 21,23.2 23,20.4 11.5,20.4', fill: 'currentColor' },
];

const BNB_SHAPES: readonly SvgPrimitive[] = [
  { tag: 'polygon', points: '16,6.5 20.2,10.7 18.4,12.5 16,10.1 13.6,12.5 11.8,10.7', fill: 'currentColor' },
  { tag: 'polygon', points: '16,25.5 20.2,21.3 18.4,19.5 16,21.9 13.6,19.5 11.8,21.3', fill: 'currentColor' },
  { tag: 'polygon', points: '16,13.4 18.6,16 16,18.6 13.4,16', fill: 'currentColor' },
  { tag: 'polygon', points: '9.2,13.4 11.8,16 9.2,18.6 6.6,16', fill: 'currentColor' },
  { tag: 'polygon', points: '22.8,13.4 25.4,16 22.8,18.6 20.2,16', fill: 'currentColor' },
];

const STABLE_SHIELD_SHAPES: readonly SvgPrimitive[] = [
  { tag: 'path', d: 'M16 6.5 23.5 9.8v5.8c0 4.6-3.2 8.2-7.5 9.9-4.3-1.7-7.5-5.3-7.5-9.9V9.8L16 6.5Z', stroke: 'currentColor', strokeWidth: 2, strokeLinejoin: 'round' },
  { tag: 'line', x1: 16, y1: 10.5, x2: 16, y2: 21.5, stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' },
  { tag: 'path', d: 'M18.4 13.1c0-1-1.05-1.6-2.4-1.6s-2.4.65-2.4 1.65 1 1.45 2.4 1.8 2.4.75 2.4 1.85-1.05 1.7-2.4 1.7-2.4-.7-2.4-1.7', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' },
];

const CRYPTO_SPECS: readonly CryptoSpec[] = [
  {
    visual: { symbol: 'BTC', name: 'Bitcoin', bg: '#F7931A', bgEnd: '#DC7509', fg: '#FFFFFF', shapes: BTC_SHAPES },
    aliases: ['btc', 'bitcoin', 'btc-bitcoin'],
  },
  {
    visual: {
      symbol: 'WBTC',
      name: 'Wrapped Bitcoin',
      bg: '#282138',
      bgEnd: '#1A1426',
      fg: '#F09242',
      shapes: [
        { tag: 'circle', cx: 16, cy: 16, r: 10.8, stroke: '#F09242', strokeWidth: 1.5, opacity: 0.55 },
        ...BTC_SHAPES,
      ],
    },
    aliases: ['wbtc', 'wrapped-bitcoin', 'wbtc-wrapped-bitcoin'],
  },
  {
    visual: {
      symbol: 'CBBTC',
      name: 'Coinbase Wrapped BTC',
      bg: '#0052FF',
      bgEnd: '#0039B5',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'circle', cx: 16, cy: 16, r: 11, stroke: '#FFFFFF', strokeWidth: 1.5, opacity: 0.4 },
        ...BTC_SHAPES,
      ],
    },
    aliases: ['cbbtc', 'coinbase-wrapped-btc'],
  },
  {
    visual: { symbol: 'BCH', name: 'Bitcoin Cash', bg: '#0AC18E', bgEnd: '#059669', fg: '#FFFFFF', shapes: BTC_SHAPES },
    aliases: ['bch', 'bitcoin-cash', 'bch-bitcoin-cash'],
  },
  {
    visual: { symbol: 'ETH', name: 'Ethereum', bg: '#627EEA', bgEnd: '#4661C9', fg: '#FFFFFF', shapes: ETH_SHAPES },
    aliases: ['eth', 'ethereum', 'eth-ethereum'],
  },
  {
    visual: {
      symbol: 'WETH',
      name: 'Wrapped Ether',
      bg: '#EC4899',
      bgEnd: '#9333EA',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'circle', cx: 16, cy: 16, r: 11.2, stroke: '#FFFFFF', strokeWidth: 1.4, opacity: 0.45 },
        ...ETH_SHAPES,
      ],
    },
    aliases: ['weth', 'wrapped-ether'],
  },
  {
    visual: {
      symbol: 'STETH',
      name: 'Lido Staked Ether',
      bg: '#00A3FF',
      bgEnd: '#0284C7',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'polygon', points: '16,6 10.5,14.5 16,17.8 21.5,14.5', fill: 'currentColor' },
        { tag: 'path', d: 'M10.2 16.8C10.2 21.2 12.8 25 16 25s5.8-3.8 5.8-8.2L16 20l-5.8-3.2Z', fill: 'currentColor', opacity: 0.88 },
      ],
    },
    aliases: ['steth', 'staked-ether', 'lido-staked-ether'],
  },
  {
    visual: {
      symbol: 'WSTETH',
      name: 'Wrapped stETH',
      bg: '#0066CC',
      bgEnd: '#004899',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'circle', cx: 16, cy: 16, r: 11, stroke: '#FFFFFF', strokeWidth: 1.5, opacity: 0.45 },
        { tag: 'polygon', points: '16,7.5 11.2,14.8 16,17.6 20.8,14.8', fill: 'currentColor' },
        { tag: 'path', d: 'M11 16.8c0 3.7 2.2 6.8 5 6.8s5-3.1 5-6.8L16 19.6 11 16.8Z', fill: 'currentColor', opacity: 0.88 },
      ],
    },
    aliases: ['wsteth', 'wrapped-steth'],
  },
  {
    visual: {
      symbol: 'WBETH',
      name: 'Wrapped Beacon ETH',
      bg: '#1E2329',
      bgEnd: '#111418',
      fg: '#F3BA2F',
      shapes: ETH_SHAPES,
    },
    aliases: ['wbeth', 'wrapped-beacon-eth'],
  },
  {
    visual: {
      symbol: 'WEETH',
      name: 'Wrapped eETH',
      bg: '#6B4EFF',
      bgEnd: '#4338CA',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'polygon', points: '16,6.5 10.5,15.5 16,18.8 21.5,15.5', fill: 'currentColor' },
        { tag: 'path', d: 'M10.5 20.5c2 2.2 3.8 3.2 5.5 3.2s3.5-1 5.5-3.2', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round' },
      ],
    },
    aliases: ['weeth', 'wrapped-eeth', 'eeth', 'ethfi', 'ether-fi', 'etherfi'],
  },
  {
    visual: {
      symbol: 'RETH',
      name: 'Rocket Pool ETH',
      bg: '#FF6E30',
      bgEnd: '#EA580C',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'path', d: 'M16 6.5c3.5 2.5 5 6.4 5 10.5l-5 2.5-5-2.5c0-4.1 1.5-8 5-10.5Z', fill: 'currentColor' },
        { tag: 'path', d: 'M12.5 21.5 16 25.5l3.5-4', stroke: 'currentColor', strokeWidth: 2.1, strokeLinecap: 'round', strokeLinejoin: 'round' },
      ],
    },
    aliases: ['reth', 'rocket-pool-eth', 'rpl', 'rocket-pool'],
  },
  {
    visual: {
      symbol: 'RSETH',
      name: 'Kelp DAO rsETH',
      bg: '#0D9488',
      bgEnd: '#0F766E',
      fg: '#FFFFFF',
      shapes: ETH_SHAPES,
    },
    aliases: ['rseth', 'kelp-dao-restaked-eth'],
  },
  {
    visual: { symbol: 'USDT', name: 'Tether', bg: '#26A17B', bgEnd: '#1B8261', fg: '#FFFFFF', shapes: TETHER_SHAPES },
    aliases: ['usdt', 'tether', 'usdt-tether'],
  },
  {
    visual: { symbol: 'USDC', name: 'USD Coin', bg: '#2775CA', bgEnd: '#1B5AA3', fg: '#FFFFFF', shapes: DOLLAR_RING_SHAPES },
    aliases: ['usdc', 'usd-coin', 'usdc-usd-coin'],
  },
  {
    visual: { symbol: 'BNB', name: 'BNB', bg: '#F3BA2F', bgEnd: '#D99B10', fg: '#FFFFFF', shapes: BNB_SHAPES },
    aliases: ['bnb', 'binancecoin', 'bnb-binance-coin', 'binance-coin'],
  },
  {
    visual: { symbol: 'SOL', name: 'Solana', bg: '#9945FF', bgEnd: '#14F195', fg: '#FFFFFF', shapes: SOL_SHAPES },
    aliases: ['sol', 'solana', 'sol-solana'],
  },
  {
    visual: {
      symbol: 'JITOSOL',
      name: 'Jito Staked SOL',
      bg: '#15803D',
      bgEnd: '#065F46',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'circle', cx: 16, cy: 16, r: 10.8, stroke: '#86EFAC', strokeWidth: 1.5, opacity: 0.6 },
        ...SOL_SHAPES,
      ],
    },
    aliases: ['jitosol', 'jito-staked-sol', 'jto', 'jito'],
  },
  {
    visual: {
      symbol: 'BNSOL',
      name: 'Binance Staked SOL',
      bg: '#1E2329',
      bgEnd: '#111418',
      fg: '#F3BA2F',
      shapes: SOL_SHAPES,
    },
    aliases: ['bnsol', 'binance-staked-sol'],
  },
  {
    visual: {
      symbol: 'XRP',
      name: 'XRP',
      bg: '#1E293B',
      bgEnd: '#0F172A',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'path', d: 'M8.5 9.5c2.2 2.8 4.6 4.4 7.5 4.4s5.3-1.6 7.5-4.4', stroke: 'currentColor', strokeWidth: 2.6, strokeLinecap: 'round' },
        { tag: 'path', d: 'M8.5 22.5c2.2-2.8 4.6-4.4 7.5-4.4s5.3 1.6 7.5 4.4', stroke: 'currentColor', strokeWidth: 2.6, strokeLinecap: 'round' },
      ],
    },
    aliases: ['xrp', 'ripple', 'xrp-xrp'],
  },
  {
    visual: {
      symbol: 'DOGE',
      name: 'Dogecoin',
      bg: '#C2A633',
      bgEnd: '#A1851E',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'path', d: 'M11.5 9.5h4.2a6.5 6.5 0 1 1 0 13h-4.2V9.5Z', stroke: 'currentColor', strokeWidth: 2.4, strokeLinejoin: 'round' },
        { tag: 'line', x1: 9, y1: 16, x2: 18, y2: 16, stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round' },
      ],
    },
    aliases: ['doge', 'dogecoin', 'doge-dogecoin'],
  },
  {
    visual: {
      symbol: 'TRX',
      name: 'TRON',
      bg: '#EF0027',
      bgEnd: '#C4001F',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'polygon', points: '8.5,8.5 24,11.5 14.5,24.5', stroke: 'currentColor', strokeWidth: 2.1, fill: 'none' },
        { tag: 'path', d: 'M8.5 8.5 16.5 15l7.5-3.5M16.5 15l-2 9.5', stroke: 'currentColor', strokeWidth: 1.8, strokeLinejoin: 'round' },
      ],
    },
    aliases: ['trx', 'tron', 'trx-tron'],
  },
  {
    visual: {
      symbol: 'ADA',
      name: 'Cardano',
      bg: '#0033AD',
      bgEnd: '#00227A',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'circle', cx: 16, cy: 16, r: 2.4, fill: 'currentColor' },
        { tag: 'circle', cx: 16, cy: 9.8, r: 1.5, fill: 'currentColor' },
        { tag: 'circle', cx: 16, cy: 22.2, r: 1.5, fill: 'currentColor' },
        { tag: 'circle', cx: 10.6, cy: 12.9, r: 1.5, fill: 'currentColor' },
        { tag: 'circle', cx: 21.4, cy: 12.9, r: 1.5, fill: 'currentColor' },
        { tag: 'circle', cx: 10.6, cy: 19.1, r: 1.5, fill: 'currentColor' },
        { tag: 'circle', cx: 21.4, cy: 19.1, r: 1.5, fill: 'currentColor' },
        { tag: 'circle', cx: 16, cy: 6.2, r: 0.9, fill: 'currentColor', opacity: 0.7 },
        { tag: 'circle', cx: 16, cy: 25.8, r: 0.9, fill: 'currentColor', opacity: 0.7 },
      ],
    },
    aliases: ['ada', 'cardano', 'ada-cardano'],
  },
  {
    visual: {
      symbol: 'AVAX',
      name: 'Avalanche',
      bg: '#E84142',
      bgEnd: '#C42B2C',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'polygon', points: '15.2,8 8,21.5 12.4,21.5 17.4,12.2', fill: 'currentColor' },
        { tag: 'polygon', points: '19.5,15.2 15.8,21.5 23.2,21.5', fill: 'currentColor' },
      ],
    },
    aliases: ['avax', 'avalanche', 'avalanche-2', 'avax-avalanche'],
  },
  {
    visual: {
      symbol: 'LINK',
      name: 'Chainlink',
      bg: '#375BD2',
      bgEnd: '#2441A8',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'polygon', points: '16,6.8 24,11.4 24,20.6 16,25.2 8,20.6 8,11.4', stroke: 'currentColor', strokeWidth: 3.1, fill: 'none' },
      ],
    },
    aliases: ['link', 'chainlink', 'link-chainlink'],
  },
  {
    visual: {
      symbol: 'SUI',
      name: 'Sui',
      bg: '#4DA2FF',
      bgEnd: '#2563EB',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'path', d: 'M16 6.5C12 11.4 9.5 14.5 9.5 18a6.5 6.5 0 0 0 13 0c0-3.5-2.5-6.6-6.5-11.5Z', stroke: 'currentColor', strokeWidth: 2.3, strokeLinejoin: 'round' },
        { tag: 'path', d: 'M12.2 17.2c1.2-1.2 2.8-1 3.8.5s2.6 1.7 3.8.5', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round' },
      ],
    },
    aliases: ['sui', 'sui-sui'],
  },
  {
    visual: {
      symbol: 'HYPE',
      name: 'Hyperliquid',
      bg: '#042F2E',
      bgEnd: '#064E3B',
      fg: '#5EEAD4',
      shapes: [
        { tag: 'path', d: 'M7.5 16c0-3.2 2.4-5.2 4.6-4.2 1.6.7 2.4 2.6 3.9 2.6s2.3-2 4-2.8c2.2-1 4.5 1.1 4.5 4.4s-2.3 5.4-4.5 4.4c-1.7-.8-2.5-2.8-4-2.8s-2.3 1.9-3.9 2.6c-2.2 1-4.6-1-4.6-4.2Z', fill: 'currentColor' },
      ],
    },
    aliases: ['hype', 'hyperliquid', 'hyperevm', 'khype'],
  },
  {
    visual: {
      symbol: 'TON',
      name: 'Toncoin',
      bg: '#0098EA',
      bgEnd: '#0077C2',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'path', d: 'M9.8 10.5h12.4c1.1 0 1.8 1.2 1.2 2.1L16 24.5 8.6 12.6c-.6-.9.1-2.1 1.2-2.1Z', stroke: 'currentColor', strokeWidth: 2.2, strokeLinejoin: 'round' },
        { tag: 'line', x1: 16, y1: 10.5, x2: 16, y2: 24.2, stroke: 'currentColor', strokeWidth: 2 },
      ],
    },
    aliases: ['ton', 'toncoin', 'the-open-network', 'gram', 'ton-toncoin'],
  },
  {
    visual: {
      symbol: 'SHIB',
      name: 'Shiba Inu',
      bg: '#EA580C',
      bgEnd: '#DC2626',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'polygon', points: '9,11 12.5,7.5 14,12', fill: 'currentColor' },
        { tag: 'polygon', points: '23,11 19.5,7.5 18,12', fill: 'currentColor' },
        { tag: 'path', d: 'M9.5 14.5c0-2.5 2.8-4 6.5-4s6.5 1.5 6.5 4c0 4.5-3 8.5-6.5 9.5-3.5-1-6.5-5-6.5-9.5Z', stroke: 'currentColor', strokeWidth: 2.1, fill: 'none' },
        { tag: 'circle', cx: 13.5, cy: 15.2, r: 1.1, fill: 'currentColor' },
        { tag: 'circle', cx: 18.5, cy: 15.2, r: 1.1, fill: 'currentColor' },
        { tag: 'polygon', points: '14.8,18.4 17.2,18.4 16,20', fill: 'currentColor' },
      ],
    },
    aliases: ['shib', 'shiba-inu', 'shib-shiba-inu'],
  },
  {
    visual: {
      symbol: 'XLM',
      name: 'Stellar',
      bg: '#0F172A',
      bgEnd: '#1E293B',
      fg: '#38BDF8',
      shapes: [
        { tag: 'circle', cx: 16, cy: 16, r: 6.2, stroke: 'currentColor', strokeWidth: 2 },
        { tag: 'line', x1: 7.5, y1: 19.2, x2: 24.5, y2: 10.6, stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' },
        { tag: 'line', x1: 7.5, y1: 22.8, x2: 24.5, y2: 14.2, stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' },
      ],
    },
    aliases: ['xlm', 'stellar', 'xlm-stellar'],
  },
  {
    visual: {
      symbol: 'HBAR',
      name: 'Hedera',
      bg: '#18181B',
      bgEnd: '#27272A',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'line', x1: 11.5, y1: 8.5, x2: 11.5, y2: 23.5, stroke: 'currentColor', strokeWidth: 2.6, strokeLinecap: 'round' },
        { tag: 'line', x1: 20.5, y1: 8.5, x2: 20.5, y2: 23.5, stroke: 'currentColor', strokeWidth: 2.6, strokeLinecap: 'round' },
        { tag: 'line', x1: 11.5, y1: 14, x2: 20.5, y2: 14, stroke: 'currentColor', strokeWidth: 2 },
        { tag: 'line', x1: 11.5, y1: 18, x2: 20.5, y2: 18, stroke: 'currentColor', strokeWidth: 2 },
      ],
    },
    aliases: ['hbar', 'hedera', 'hedera-hashgraph', 'hbar-hedera-hashgraph'],
  },
  {
    visual: {
      symbol: 'DOT',
      name: 'Polkadot',
      bg: '#E6007A',
      bgEnd: '#BE0064',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'ellipse', cx: 16, cy: 8.5, rx: 3, ry: 2, fill: 'currentColor' },
        { tag: 'ellipse', cx: 16, cy: 23.5, rx: 3, ry: 2, fill: 'currentColor' },
        { tag: 'ellipse', cx: 9.5, cy: 12.2, rx: 3, ry: 2, fill: 'currentColor', transform: 'rotate(-60 9.5 12.2)' },
        { tag: 'ellipse', cx: 22.5, cy: 19.8, rx: 3, ry: 2, fill: 'currentColor', transform: 'rotate(-60 22.5 19.8)' },
        { tag: 'ellipse', cx: 22.5, cy: 12.2, rx: 3, ry: 2, fill: 'currentColor', transform: 'rotate(60 22.5 12.2)' },
        { tag: 'ellipse', cx: 9.5, cy: 19.8, rx: 3, ry: 2, fill: 'currentColor', transform: 'rotate(60 9.5 19.8)' },
      ],
    },
    aliases: ['dot', 'polkadot', 'dot-polkadot'],
  },
  {
    visual: {
      symbol: 'LTC',
      name: 'Litecoin',
      bg: '#345D9D',
      bgEnd: '#234378',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'path', d: 'M14.5 8.5 11.5 22.5h10', stroke: 'currentColor', strokeWidth: 3, strokeLinecap: 'round', strokeLinejoin: 'round' },
        { tag: 'line', x1: 9.5, y1: 16.5, x2: 17.5, y2: 13.5, stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round' },
      ],
    },
    aliases: ['ltc', 'litecoin', 'ltc-litecoin'],
  },
  {
    visual: {
      symbol: 'UNI',
      name: 'Uniswap',
      bg: '#FF007A',
      bgEnd: '#D80066',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'path', d: 'M11 9.5v8.2a5 5 0 0 0 10 0V9.5', stroke: 'currentColor', strokeWidth: 2.8, strokeLinecap: 'round' },
        { tag: 'path', d: 'M16 7.5 18.2 12l-4.4 0Z', fill: 'currentColor' },
      ],
    },
    aliases: ['uni', 'uniswap', 'uni-uniswap'],
  },
  {
    visual: {
      symbol: 'NEAR',
      name: 'NEAR Protocol',
      bg: '#111827',
      bgEnd: '#030712',
      fg: '#00EC97',
      shapes: [
        { tag: 'path', d: 'M10 22.5v-13l12 13v-13', stroke: 'currentColor', strokeWidth: 2.7, strokeLinecap: 'round', strokeLinejoin: 'round' },
      ],
    },
    aliases: ['near', 'near-protocol', 'near-near-protocol'],
  },
  {
    visual: {
      symbol: 'APT',
      name: 'Aptos',
      bg: '#0F172A',
      bgEnd: '#1E293B',
      fg: '#2DD4BF',
      shapes: [
        { tag: 'path', d: 'M7.5 11.5h17M7.5 16h17M7.5 20.5h17', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round' },
        { tag: 'polygon', points: '17,9.5 20.5,11.5 17,13.5', fill: '#0F172A' },
        { tag: 'polygon', points: '13,14 16.5,16 13,18', fill: '#0F172A' },
      ],
    },
    aliases: ['apt', 'aptos', 'apt-aptos'],
  },
  {
    visual: {
      symbol: 'ARB',
      name: 'Arbitrum',
      bg: '#213147',
      bgEnd: '#162235',
      fg: '#28A0F0',
      shapes: [
        { tag: 'polygon', points: '16,6.5 24,11 24,21 16,25.5 8,21 8,11', stroke: '#96BEDC', strokeWidth: 1.8, fill: 'none' },
        { tag: 'path', d: 'M12.5 21 16 11l3.5 10', stroke: '#FFFFFF', strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round' },
        { tag: 'path', d: 'M17.8 14.5 21 21', stroke: '#28A0F0', strokeWidth: 2.3, strokeLinecap: 'round' },
      ],
    },
    aliases: ['arb', 'arbitrum', 'arb-arbitrum'],
  },
  {
    visual: {
      symbol: 'OP',
      name: 'Optimism',
      bg: '#FF0420',
      bgEnd: '#CC0018',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'circle', cx: 12, cy: 16, r: 4.2, stroke: 'currentColor', strokeWidth: 2.4 },
        { tag: 'path', d: 'M19 20.5v-9h3a2.6 2.6 0 0 1 0 5.2h-3', stroke: 'currentColor', strokeWidth: 2.4, strokeLinecap: 'round', strokeLinejoin: 'round' },
      ],
    },
    aliases: ['op', 'optimism', 'op-optimism'],
  },
  {
    visual: {
      symbol: 'POL',
      name: 'Polygon',
      bg: '#8247E5',
      bgEnd: '#6329C9',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'path', d: 'M12.5 10.5 8.5 12.8v4.6l4 2.3 7-4 4 2.3v-4.6l-4-2.3-7 4Z', stroke: 'currentColor', strokeWidth: 2.1, strokeLinejoin: 'round' },
      ],
    },
    aliases: ['pol', 'matic', 'polygon', 'matic-network', 'polygon-ecosystem-token'],
  },
  {
    visual: {
      symbol: 'AAVE',
      name: 'Aave',
      bg: '#B6509E',
      bgEnd: '#2EBAC6',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'path', d: 'M10.5 22.5v-6a5.5 5.5 0 0 1 11 0v6', stroke: 'currentColor', strokeWidth: 2.5, strokeLinecap: 'round' },
        { tag: 'circle', cx: 13.8, cy: 15.2, r: 1.2, fill: 'currentColor' },
        { tag: 'circle', cx: 18.2, cy: 15.2, r: 1.2, fill: 'currentColor' },
      ],
    },
    aliases: ['aave', 'aave-aave'],
  },
  {
    visual: {
      symbol: 'PEPE',
      name: 'Pepe',
      bg: '#3D9A3D',
      bgEnd: '#257025',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'circle', cx: 12.2, cy: 12.8, r: 2.6, fill: 'currentColor' },
        { tag: 'circle', cx: 19.8, cy: 12.8, r: 2.6, fill: 'currentColor' },
        { tag: 'circle', cx: 12.8, cy: 12.8, r: 1.1, fill: '#111827' },
        { tag: 'circle', cx: 20.4, cy: 12.8, r: 1.1, fill: '#111827' },
        { tag: 'path', d: 'M9.5 19.5c2.2 1.8 10.8 1.8 13 0', stroke: '#DC2626', strokeWidth: 2.4, strokeLinecap: 'round' },
      ],
    },
    aliases: ['pepe', 'pepe-pepe'],
  },
  {
    visual: {
      symbol: 'ENA',
      name: 'Ethena',
      bg: '#0F172A',
      bgEnd: '#1E293B',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'polygon', points: '16,7 24.5,16 16,25 7.5,16', stroke: 'currentColor', strokeWidth: 2.1, fill: 'none' },
        { tag: 'path', d: 'M12.5 13h7M12.5 16h5.5M12.5 19h7', stroke: '#38BDF8', strokeWidth: 2, strokeLinecap: 'round' },
      ],
    },
    aliases: ['ena', 'ethena'],
  },
  {
    visual: {
      symbol: 'USDE',
      name: 'Ethena USDe',
      bg: '#111827',
      bgEnd: '#0F172A',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'circle', cx: 16, cy: 16, r: 10, stroke: '#38BDF8', strokeWidth: 1.8 },
        { tag: 'path', d: 'M12.5 12.5h7M12.5 16h5.5M12.5 19.5h7', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round' },
      ],
    },
    aliases: ['usde', 'ethena-usde'],
  },
  {
    visual: {
      symbol: 'SUSDE',
      name: 'Staked USDe',
      bg: '#065F46',
      bgEnd: '#047857',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'circle', cx: 16, cy: 16, r: 10, stroke: '#6EE7B7', strokeWidth: 1.8 },
        { tag: 'path', d: 'M12.5 12.5h7M12.5 16h5.5M12.5 19.5h7', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round' },
      ],
    },
    aliases: ['susde', 'ethena-staked-usde'],
  },
  {
    visual: {
      symbol: 'DAI',
      name: 'Dai',
      bg: '#F5AC37',
      bgEnd: '#D98E1B',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'path', d: 'M11 9.5h4.5a6.5 6.5 0 1 1 0 13H11V9.5Z', stroke: 'currentColor', strokeWidth: 2.3, strokeLinejoin: 'round' },
        { tag: 'line', x1: 8.5, y1: 14, x2: 23.5, y2: 14, stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round' },
        { tag: 'line', x1: 8.5, y1: 18, x2: 23.5, y2: 18, stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round' },
      ],
    },
    aliases: ['dai', 'dai-dai'],
  },
  {
    visual: {
      symbol: 'TAO',
      name: 'Bittensor',
      bg: '#111827',
      bgEnd: '#1F2937',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'path', d: 'M9 11.5c2-1.8 12-1.8 14 0', stroke: 'currentColor', strokeWidth: 2.5, strokeLinecap: 'round' },
        { tag: 'path', d: 'M15.5 11.5v8.8c0 1.8 1.2 2.7 3 2.7', stroke: 'currentColor', strokeWidth: 2.5, strokeLinecap: 'round' },
      ],
    },
    aliases: ['tao', 'bittensor'],
  },
  {
    visual: {
      symbol: 'ICP',
      name: 'Internet Computer',
      bg: '#522785',
      bgEnd: '#29ABE2',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'path', d: 'M8 16c0-3 2.4-4.8 5-3.4l6 3.4c2.6 1.4 5-.4 5-3.4M8 16c0 3 2.4 4.8 5 3.4l6-3.4c2.6-1.4 5 .4 5 3.4', stroke: 'currentColor', strokeWidth: 2.3, strokeLinecap: 'round' },
      ],
    },
    aliases: ['icp', 'internet-computer'],
  },
  {
    visual: { symbol: 'ETC', name: 'Ethereum Classic', bg: '#328332', bgEnd: '#216021', fg: '#FFFFFF', shapes: ETH_SHAPES },
    aliases: ['etc', 'ethereum-classic'],
  },
  {
    visual: {
      symbol: 'XMR',
      name: 'Monero',
      bg: '#FF6600',
      bgEnd: '#D95400',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'path', d: 'M7 20.5h4.2v-9.5L16 16.5l4.8-5.5v9.5H25', stroke: 'currentColor', strokeWidth: 2.5, strokeLinecap: 'round', strokeLinejoin: 'round' },
      ],
    },
    aliases: ['xmr', 'monero', 'xmr-monero'],
  },
  {
    visual: {
      symbol: 'ZEC',
      name: 'Zcash',
      bg: '#F4B728',
      bgEnd: '#D4980F',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'path', d: 'M11 11h10l-10 10h10', stroke: 'currentColor', strokeWidth: 2.5, strokeLinecap: 'round', strokeLinejoin: 'round' },
        { tag: 'line', x1: 16, y1: 7.5, x2: 16, y2: 11, stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round' },
        { tag: 'line', x1: 16, y1: 21, x2: 16, y2: 24.5, stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round' },
      ],
    },
    aliases: ['zec', 'zcash', 'zec-zcash'],
  },
  {
    visual: {
      symbol: 'FIL',
      name: 'Filecoin',
      bg: '#0090FF',
      bgEnd: '#006AD1',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'path', d: 'M18.8 9.5c-2.2 0-3.2 1.2-3.8 4.4l-1.5 8.6', stroke: 'currentColor', strokeWidth: 2.5, strokeLinecap: 'round' },
        { tag: 'line', x1: 10.5, y1: 14.2, x2: 21.5, y2: 12.6, stroke: 'currentColor', strokeWidth: 2.1, strokeLinecap: 'round' },
        { tag: 'line', x1: 10.5, y1: 18.2, x2: 20.5, y2: 16.6, stroke: 'currentColor', strokeWidth: 2.1, strokeLinecap: 'round' },
      ],
    },
    aliases: ['fil', 'filecoin'],
  },
  {
    visual: {
      symbol: 'ATOM',
      name: 'Cosmos',
      bg: '#2E3148',
      bgEnd: '#1E2033',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'circle', cx: 16, cy: 16, r: 2.2, fill: 'currentColor' },
        { tag: 'ellipse', cx: 16, cy: 16, rx: 9.5, ry: 3.8, stroke: 'currentColor', strokeWidth: 1.6 },
        { tag: 'ellipse', cx: 16, cy: 16, rx: 9.5, ry: 3.8, stroke: 'currentColor', strokeWidth: 1.6, transform: 'rotate(60 16 16)' },
        { tag: 'ellipse', cx: 16, cy: 16, rx: 9.5, ry: 3.8, stroke: 'currentColor', strokeWidth: 1.6, transform: 'rotate(-60 16 16)' },
      ],
    },
    aliases: ['atom', 'cosmos', 'atom-cosmos'],
  },
  {
    visual: {
      symbol: 'INJ',
      name: 'Injective',
      bg: '#00A2FF',
      bgEnd: '#0284C7',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'path', d: 'M10 13.5c2-4.5 7.5-6 11-3.5-3 1.2-5 3.6-5.2 6.8', stroke: 'currentColor', strokeWidth: 2.4, strokeLinecap: 'round' },
        { tag: 'path', d: 'M22 18.5c-2 4.5-7.5 6-11 3.5 3-1.2 5-3.6 5.2-6.8', stroke: 'currentColor', strokeWidth: 2.4, strokeLinecap: 'round' },
      ],
    },
    aliases: ['inj', 'injective', 'injective-protocol'],
  },
  {
    visual: {
      symbol: 'TIA',
      name: 'Celestia',
      bg: '#7B2BF9',
      bgEnd: '#5B21B6',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'path', d: 'M20.5 10.5a7.5 7.5 0 1 0 0 11 5.6 5.6 0 1 1 0-11Z', fill: 'currentColor' },
        { tag: 'circle', cx: 20.5, cy: 16, r: 1.8, fill: 'currentColor' },
      ],
    },
    aliases: ['tia', 'celestia'],
  },
  {
    visual: {
      symbol: 'SEI',
      name: 'Sei',
      bg: '#9B1C1C',
      bgEnd: '#7F1D1D',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'path', d: 'M9 12.5c2.5-2.5 5.5-2.5 7 0s4.5 2.5 7 0', stroke: 'currentColor', strokeWidth: 2.3, strokeLinecap: 'round' },
        { tag: 'path', d: 'M9 17c2.5-2.5 5.5-2.5 7 0s4.5 2.5 7 0', stroke: 'currentColor', strokeWidth: 2.3, strokeLinecap: 'round' },
        { tag: 'path', d: 'M9 21.5c2.5-2.5 5.5-2.5 7 0s4.5 2.5 7 0', stroke: 'currentColor', strokeWidth: 2.3, strokeLinecap: 'round' },
      ],
    },
    aliases: ['sei', 'sei-network'],
  },
  {
    visual: {
      symbol: 'MNT',
      name: 'Mantle',
      bg: '#0D9488',
      bgEnd: '#0F766E',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'circle', cx: 16, cy: 16, r: 9.5, stroke: 'currentColor', strokeWidth: 1.8 },
        { tag: 'path', d: 'M11 20.5v-8.5l5 5 5-5v8.5', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round' },
      ],
    },
    aliases: ['mnt', 'mantle'],
  },
  {
    visual: {
      symbol: 'BERA',
      name: 'Berachain',
      bg: '#B45309',
      bgEnd: '#92400E',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'circle', cx: 11, cy: 11, r: 2.6, fill: 'currentColor' },
        { tag: 'circle', cx: 21, cy: 11, r: 2.6, fill: 'currentColor' },
        { tag: 'circle', cx: 16, cy: 17.2, r: 6.2, fill: 'currentColor' },
        { tag: 'circle', cx: 14, cy: 16.2, r: 1, fill: '#92400E' },
        { tag: 'circle', cx: 18, cy: 16.2, r: 1, fill: '#92400E' },
        { tag: 'ellipse', cx: 16, cy: 19, rx: 1.9, ry: 1.3, fill: '#92400E' },
      ],
    },
    aliases: ['bera', 'berachain', 'berachain-bera'],
  },
  {
    visual: {
      symbol: 'PENDLE',
      name: 'Pendle',
      bg: '#0F2A43',
      bgEnd: '#0A1E32',
      fg: '#38BDF8',
      shapes: [
        { tag: 'path', d: 'M9 11a10 10 0 0 0 14 0', stroke: '#FFFFFF', strokeWidth: 2, strokeLinecap: 'round', opacity: 0.7 },
        { tag: 'line', x1: 16, y1: 8, x2: 19.5, y2: 19.5, stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round' },
        { tag: 'circle', cx: 20, cy: 21, r: 3.1, fill: 'currentColor' },
      ],
    },
    aliases: ['pendle', 'pendle-finance'],
  },
  {
    visual: {
      symbol: 'LDO',
      name: 'Lido DAO',
      bg: '#00A3FF',
      bgEnd: '#0369A1',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'polygon', points: '16,6.5 10.5,14.8 16,18 21.5,14.8', fill: 'currentColor' },
        { tag: 'path', d: 'M9.5 19.5c2 3.2 4.2 5 6.5 5s4.5-1.8 6.5-5', stroke: 'currentColor', strokeWidth: 2.3, strokeLinecap: 'round' },
      ],
    },
    aliases: ['ldo', 'lido', 'lido-dao'],
  },
  {
    visual: {
      symbol: 'EIGEN',
      name: 'EigenLayer',
      bg: '#1A0C6D',
      bgEnd: '#312E81',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'rect', x: 10, y: 8.5, width: 3.2, height: 15, rx: 0.6, fill: 'currentColor' },
        { tag: 'rect', x: 14.8, y: 8.5, width: 7.2, height: 3.2, rx: 0.6, fill: 'currentColor' },
        { tag: 'rect', x: 14.8, y: 14.4, width: 5.5, height: 3.2, rx: 0.6, fill: 'currentColor' },
        { tag: 'rect', x: 14.8, y: 20.3, width: 7.2, height: 3.2, rx: 0.6, fill: 'currentColor' },
      ],
    },
    aliases: ['eigen', 'eigenlayer'],
  },
  {
    visual: {
      symbol: 'MKR',
      name: 'Maker',
      bg: '#1AAB9B',
      bgEnd: '#0F766E',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'path', d: 'M8.5 22v-11l5.5 4.5V22M23.5 22v-11L18 15.5V22', stroke: 'currentColor', strokeWidth: 2.4, strokeLinecap: 'round', strokeLinejoin: 'round' },
      ],
    },
    aliases: ['mkr', 'maker'],
  },
  {
    visual: {
      symbol: 'SKY',
      name: 'Sky',
      bg: '#4F46E5',
      bgEnd: '#0EA5E9',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'circle', cx: 16, cy: 16, r: 3.4, fill: 'currentColor' },
        { tag: 'path', d: 'M16 7.5v3.2M16 21.3v3.2M7.5 16h3.2M21.3 16h3.2M10 10l2.2 2.2M19.8 19.8 22 22M22 10l-2.2 2.2M12.2 19.8 10 22', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' },
      ],
    },
    aliases: ['sky', 'sky-protocol'],
  },
  {
    visual: {
      symbol: 'CRV',
      name: 'Curve DAO',
      bg: '#2563EB',
      bgEnd: '#DC2626',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'path', d: 'M21 10.5c-4.5-2.2-10 .4-10 5.5s5.5 7.7 10 5.5', stroke: 'currentColor', strokeWidth: 2.7, strokeLinecap: 'round' },
        { tag: 'path', d: 'M14 16c2.5-2.5 5.5-2.5 8 0', stroke: '#FDE047', strokeWidth: 2.2, strokeLinecap: 'round' },
      ],
    },
    aliases: ['crv', 'curve', 'curve-dao-token'],
  },
  {
    visual: {
      symbol: 'ONDO',
      name: 'Ondo',
      bg: '#0F172A',
      bgEnd: '#1E3A8A',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'path', d: 'M9 13.5a7.5 7.5 0 0 1 14 0', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round' },
        { tag: 'path', d: 'M9 17.5a7.5 7.5 0 0 1 14 0', stroke: '#60A5FA', strokeWidth: 2.2, strokeLinecap: 'round' },
        { tag: 'path', d: 'M10.5 21.2a6 6 0 0 1 11 0', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', opacity: 0.75 },
      ],
    },
    aliases: ['ondo', 'ondo-finance'],
  },
  {
    visual: {
      symbol: 'USDY',
      name: 'Ondo US Dollar Yield',
      bg: '#0F172A',
      bgEnd: '#1E293B',
      fg: '#38BDF8',
      shapes: STABLE_SHIELD_SHAPES,
    },
    aliases: ['usdy', 'ondo-us-dollar-yield'],
  },
  {
    visual: {
      symbol: 'JUP',
      name: 'Jupiter',
      bg: '#16A34A',
      bgEnd: '#06B6D4',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'path', d: 'M9 11.5c4.5-2.2 9.5-2.2 14 0', stroke: 'currentColor', strokeWidth: 2.4, strokeLinecap: 'round' },
        { tag: 'path', d: 'M8 16c5-2.4 11-2.4 16 0', stroke: 'currentColor', strokeWidth: 2.6, strokeLinecap: 'round' },
        { tag: 'path', d: 'M10 20.8c3.8-1.8 8.2-1.8 12 0', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round' },
      ],
    },
    aliases: ['jup', 'jupiter', 'jupiter-exchange-solana'],
  },
  {
    visual: {
      symbol: 'PYTH',
      name: 'Pyth Network',
      bg: '#5B21B6',
      bgEnd: '#3B0764',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'path', d: 'M12 23.5v-14h5a4.5 4.5 0 0 1 0 9h-5', stroke: 'currentColor', strokeWidth: 2.6, strokeLinecap: 'round', strokeLinejoin: 'round' },
        { tag: 'circle', cx: 17.5, cy: 14, r: 1.4, fill: '#C4B5FD' },
      ],
    },
    aliases: ['pyth', 'pyth-network'],
  },
  {
    visual: {
      symbol: 'WLD',
      name: 'Worldcoin',
      bg: '#111827',
      bgEnd: '#27272A',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'circle', cx: 16, cy: 16, r: 9.2, stroke: 'currentColor', strokeWidth: 2.1 },
        { tag: 'path', d: 'M24.8 13.5H14a2.5 2.5 0 0 0 0 5h10.8', stroke: 'currentColor', strokeWidth: 2.1, strokeLinecap: 'round' },
      ],
    },
    aliases: ['wld', 'worldcoin', 'worldcoin-wld'],
  },
  {
    visual: {
      symbol: 'RENDER',
      name: 'Render',
      bg: '#E11D48',
      bgEnd: '#9F1239',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'circle', cx: 16, cy: 16, r: 8.5, stroke: 'currentColor', strokeWidth: 2.2 },
        { tag: 'circle', cx: 16, cy: 16, r: 3.4, fill: 'currentColor' },
        { tag: 'path', d: 'M16 7.5a8.5 8.5 0 0 1 8.5 8.5', stroke: '#FDA4AF', strokeWidth: 2.2, strokeLinecap: 'round' },
      ],
    },
    aliases: ['render', 'rndr', 'render-token'],
  },
  {
    visual: {
      symbol: 'FET',
      name: 'Artificial Superintelligence',
      bg: '#1E1B4B',
      bgEnd: '#312E81',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'circle', cx: 11, cy: 11, r: 1.7, fill: 'currentColor' },
        { tag: 'circle', cx: 16, cy: 11, r: 1.7, fill: 'currentColor' },
        { tag: 'circle', cx: 21, cy: 11, r: 1.7, fill: 'currentColor' },
        { tag: 'circle', cx: 11, cy: 16, r: 1.7, fill: 'currentColor' },
        { tag: 'circle', cx: 16, cy: 16, r: 1.7, fill: '#38BDF8' },
        { tag: 'circle', cx: 11, cy: 21, r: 1.7, fill: 'currentColor' },
        { tag: 'circle', cx: 21, cy: 21, r: 1.1, fill: '#38BDF8', opacity: 0.7 },
      ],
    },
    aliases: ['fet', 'fetch-ai', 'asi'],
  },
  {
    visual: {
      symbol: 'ZRO',
      name: 'LayerZero',
      bg: '#111827',
      bgEnd: '#1E293B',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'circle', cx: 16, cy: 16, r: 7.5, stroke: 'currentColor', strokeWidth: 2.5 },
        { tag: 'line', x1: 10, y1: 22, x2: 22, y2: 10, stroke: 'currentColor', strokeWidth: 2.3, strokeLinecap: 'round' },
      ],
    },
    aliases: ['zro', 'layerzero', 'layerzero-v2'],
  },
  {
    visual: {
      symbol: 'STRK',
      name: 'Starknet',
      bg: '#28286E',
      bgEnd: '#1B1B4F',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'path', d: 'M8.5 21.5c3.5-8.5 9-12 15-11', stroke: '#EC796B', strokeWidth: 2.6, strokeLinecap: 'round' },
        { tag: 'polygon', points: '20.5,14.5 21.8,17.2 24.5,18.2 21.8,19.4 20.5,22 19.2,19.4 16.5,18.2 19.2,17.2', fill: 'currentColor' },
      ],
    },
    aliases: ['strk', 'starknet'],
  },
  {
    visual: {
      symbol: 'ZK',
      name: 'ZKsync',
      bg: '#1D4ED8',
      bgEnd: '#1E3A8A',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'polygon', points: '17,9.5 24,16 17,22.5 17,18.5 11.5,18.5 17,14', fill: 'currentColor' },
        { tag: 'polygon', points: '15,22.5 8,16 15,9.5 15,13.5 20.5,13.5 15,18', fill: 'currentColor', opacity: 0.85 },
      ],
    },
    aliases: ['zk', 'zksync', 'zksync-era'],
  },
  {
    visual: {
      symbol: 'PAXG',
      name: 'PAX Gold',
      bg: '#D4AF37',
      bgEnd: '#A17C12',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'polygon', points: '11,18.5 13,12.5 19,12.5 21,18.5', fill: 'currentColor' },
        { tag: 'polygon', points: '8.5,22.5 10,19.5 22,19.5 23.5,22.5', fill: 'currentColor', opacity: 0.88 },
      ],
    },
    aliases: ['paxg', 'pax-gold'],
  },
  {
    visual: { symbol: 'XAUT', name: 'Tether Gold', bg: '#C59B27', bgEnd: '#9A7412', fg: '#FFFFFF', shapes: TETHER_SHAPES },
    aliases: ['xaut', 'tether-gold'],
  },
  {
    visual: { symbol: 'USDS', name: 'USDS', bg: '#0EA5E9', bgEnd: '#0284C7', fg: '#FFFFFF', shapes: DOLLAR_RING_SHAPES },
    aliases: ['usds', 'sky-dollar'],
  },
  {
    visual: { symbol: 'SUSDS', name: 'Savings USDS', bg: '#059669', bgEnd: '#047857', fg: '#FFFFFF', shapes: DOLLAR_RING_SHAPES },
    aliases: ['susds', 'savings-usds'],
  },
  {
    visual: { symbol: 'FDUSD', name: 'First Digital USD', bg: '#00B894', bgEnd: '#008F72', fg: '#FFFFFF', shapes: STABLE_SHIELD_SHAPES },
    aliases: ['fdusd', 'first-digital-usd'],
  },
  {
    visual: {
      symbol: 'PYUSD',
      name: 'PayPal USD',
      bg: '#0070BA',
      bgEnd: '#003087',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'path', d: 'M11 22.5v-12h5.2a3.4 3.4 0 0 1 0 6.8H11', stroke: 'currentColor', strokeWidth: 2.5, strokeLinecap: 'round', strokeLinejoin: 'round' },
        { tag: 'path', d: 'M15 24v-9.5h4.2a2.8 2.8 0 0 1 0 5.6H15', stroke: '#7DD3FC', strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round' },
      ],
    },
    aliases: ['pyusd', 'paypal-usd'],
  },
  {
    visual: { symbol: 'RLUSD', name: 'Ripple USD', bg: '#0085FF', bgEnd: '#0056B3', fg: '#FFFFFF', shapes: STABLE_SHIELD_SHAPES },
    aliases: ['rlusd', 'ripple-usd'],
  },
  {
    visual: { symbol: 'USD1', name: 'USD1', bg: '#1E3A8A', bgEnd: '#172554', fg: '#FBBF24', shapes: STABLE_SHIELD_SHAPES },
    aliases: ['usd1', 'usd1-wlfi'],
  },
  {
    visual: { symbol: 'USDG', name: 'Global Dollar', bg: '#0284C7', bgEnd: '#0369A1', fg: '#FFFFFF', shapes: DOLLAR_RING_SHAPES },
    aliases: ['usdg', 'global-dollar'],
  },
  {
    visual: { symbol: 'USYC', name: 'Circle USYC', bg: '#1D4ED8', bgEnd: '#1E40AF', fg: '#FFFFFF', shapes: DOLLAR_RING_SHAPES },
    aliases: ['usyc', 'hashnote-usyc', 'circle-usyc'],
  },
  {
    visual: { symbol: 'USDF', name: 'Falcon USD', bg: '#4F46E5', bgEnd: '#3730A3', fg: '#FFFFFF', shapes: STABLE_SHIELD_SHAPES },
    aliases: ['usdf', 'falcon-finance', 'falcon-usd'],
  },
  {
    visual: {
      symbol: 'BUIDL',
      name: 'BlackRock BUIDL',
      bg: '#18181B',
      bgEnd: '#09090B',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'rect', x: 9, y: 10, width: 4, height: 12, rx: 1, fill: 'currentColor' },
        { tag: 'rect', x: 14.5, y: 8, width: 4, height: 14, rx: 1, fill: '#38BDF8' },
        { tag: 'rect', x: 20, y: 12, width: 3.5, height: 10, rx: 1, fill: 'currentColor' },
      ],
    },
    aliases: ['buidl', 'blackrock-usd-institutional-digital-liquidity-fund'],
  },
  {
    visual: {
      symbol: 'WBT',
      name: 'WhiteBIT Coin',
      bg: '#1E293B',
      bgEnd: '#0F172A',
      fg: '#EAB308',
      shapes: [
        { tag: 'path', d: 'M8.5 11.5 12 21.5l4-7.5 4 7.5 3.5-10', stroke: 'currentColor', strokeWidth: 2.5, strokeLinecap: 'round', strokeLinejoin: 'round' },
      ],
    },
    aliases: ['wbt', 'whitebit'],
  },
  {
    visual: {
      symbol: 'LEO',
      name: 'LEO Token',
      bg: '#D97706',
      bgEnd: '#1E293B',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'polygon', points: '16,7.5 23.5,14.5 20.5,23.5 11.5,23.5 8.5,14.5', stroke: 'currentColor', strokeWidth: 2.2, fill: 'none' },
        { tag: 'polygon', points: '16,12 19.5,16 16,20 12.5,16', fill: '#FBBF24' },
      ],
    },
    aliases: ['leo', 'leo-token'],
  },
  {
    visual: {
      symbol: 'OKB',
      name: 'OKB',
      bg: '#111827',
      bgEnd: '#1F2937',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'rect', x: 8.5, y: 8.5, width: 4.5, height: 4.5, rx: 0.8, fill: 'currentColor' },
        { tag: 'rect', x: 19, y: 8.5, width: 4.5, height: 4.5, rx: 0.8, fill: 'currentColor' },
        { tag: 'rect', x: 13.75, y: 13.75, width: 4.5, height: 4.5, rx: 0.8, fill: 'currentColor' },
        { tag: 'rect', x: 8.5, y: 19, width: 4.5, height: 4.5, rx: 0.8, fill: 'currentColor' },
        { tag: 'rect', x: 19, y: 19, width: 4.5, height: 4.5, rx: 0.8, fill: 'currentColor' },
      ],
    },
    aliases: ['okb', 'okx'],
  },
  {
    visual: {
      symbol: 'BGB',
      name: 'Bitget Token',
      bg: '#00B8D9',
      bgEnd: '#008BA3',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'path', d: 'M12 10.5 19.5 15l-7.5 4.5', stroke: 'currentColor', strokeWidth: 2.6, strokeLinecap: 'round', strokeLinejoin: 'round' },
        { tag: 'path', d: 'M20 21.5 12.5 17l7.5-4.5', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round', opacity: 0.72 },
      ],
    },
    aliases: ['bgb', 'bitget-token'],
  },
  {
    visual: {
      symbol: 'CRO',
      name: 'Cronos',
      bg: '#002D74',
      bgEnd: '#001B47',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'polygon', points: '16,6.8 23.8,11.3 23.8,20.7 16,25.2 8.2,20.7 8.2,11.3', stroke: 'currentColor', strokeWidth: 2.1, fill: 'none' },
        { tag: 'path', d: 'M19 12.8a4.5 4.5 0 1 0 0 6.4', stroke: '#60A5FA', strokeWidth: 2.3, strokeLinecap: 'round' },
      ],
    },
    aliases: ['cro', 'cronos', 'crypto-com-chain'],
  },
  {
    visual: {
      symbol: 'KCS',
      name: 'KuCoin Token',
      bg: '#23AF91',
      bgEnd: '#17856D',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'line', x1: 11, y1: 9.5, x2: 11, y2: 22.5, stroke: 'currentColor', strokeWidth: 2.6, strokeLinecap: 'round' },
        { tag: 'path', d: 'M21 10.5 14.5 16 21 21.5', stroke: 'currentColor', strokeWidth: 2.6, strokeLinecap: 'round', strokeLinejoin: 'round' },
        { tag: 'circle', cx: 20.5, cy: 16, r: 1.6, fill: 'currentColor' },
      ],
    },
    aliases: ['kcs', 'kucoin-shares'],
  },
  {
    visual: {
      symbol: 'PENGU',
      name: 'Pudgy Penguins',
      bg: '#38BDF8',
      bgEnd: '#0284C7',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'circle', cx: 16, cy: 16, r: 8.5, fill: 'currentColor' },
        { tag: 'circle', cx: 13.2, cy: 14.2, r: 1.3, fill: '#0F172A' },
        { tag: 'circle', cx: 18.8, cy: 14.2, r: 1.3, fill: '#0F172A' },
        { tag: 'polygon', points: '13.5,17.2 18.5,17.2 16,20.4', fill: '#F97316' },
      ],
    },
    aliases: ['pengu', 'pudgy-penguins'],
  },
  {
    visual: {
      symbol: 'TRUMP',
      name: 'Official Trump',
      bg: '#1E3A8A',
      bgEnd: '#991B1B',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'polygon', points: '16,8 18.2,13.2 23.8,13.6 19.5,17.2 20.8,22.8 16,19.8 11.2,22.8 12.5,17.2 8.2,13.6 13.8,13.2', fill: '#FBBF24' },
      ],
    },
    aliases: ['trump', 'official-trump'],
  },
  {
    visual: {
      symbol: 'QNT',
      name: 'Quant',
      bg: '#312E81',
      bgEnd: '#1E1B4B',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'polygon', points: '16,7.5 23,11.5 23,19.5 16,23.5 9,19.5 9,11.5', stroke: 'currentColor', strokeWidth: 2.3, fill: 'none' },
        { tag: 'line', x1: 18, y1: 18, x2: 24, y2: 24, stroke: '#38BDF8', strokeWidth: 2.4, strokeLinecap: 'round' },
      ],
    },
    aliases: ['qnt', 'quant', 'quant-network'],
  },
  {
    visual: {
      symbol: 'CC',
      name: 'Canton',
      bg: '#4F46E5',
      bgEnd: '#3730A3',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'path', d: 'M20.5 11.2a7 7 0 1 0 0 9.6', stroke: 'currentColor', strokeWidth: 2.5, strokeLinecap: 'round' },
        { tag: 'path', d: 'M19 13.8a3.5 3.5 0 1 0 0 4.4', stroke: '#A5B4FC', strokeWidth: 2, strokeLinecap: 'round' },
      ],
    },
    aliases: ['cc', 'canton', 'canton-network'],
  },
  {
    visual: {
      symbol: 'MORPHO',
      name: 'Morpho',
      bg: '#2563EB',
      bgEnd: '#1D4ED8',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'path', d: 'M9 10.5c3.5 1 5.8 3.5 7 5.5 1.2-2 3.5-4.5 7-5.5v11c-3.5-1-5.8-3.5-7-5.5-1.2 2-3.5 4.5-7 5.5v-11Z', fill: 'currentColor' },
      ],
    },
    aliases: ['morpho', 'morpho-blue'],
  },
  {
    visual: {
      symbol: 'MON',
      name: 'Monad',
      bg: '#836EF9',
      bgEnd: '#5B45D6',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'rect', x: 9.5, y: 9.5, width: 13, height: 13, rx: 4.5, stroke: 'currentColor', strokeWidth: 2.8, transform: 'rotate(45 16 16)' },
      ],
    },
    aliases: ['mon', 'monad'],
  },
  {
    visual: {
      symbol: 'MEGA',
      name: 'MegaETH',
      bg: '#7C3AED',
      bgEnd: '#4C1D95',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'path', d: 'M9 22v-12l7 7 7-7v12', stroke: 'currentColor', strokeWidth: 2.6, strokeLinecap: 'round', strokeLinejoin: 'round' },
      ],
    },
    aliases: ['mega', 'megaeth'],
  },
  {
    visual: {
      symbol: 'S',
      name: 'Sonic',
      bg: '#F97316',
      bgEnd: '#2563EB',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'path', d: 'M21 11.5c-1.2-1.8-7.5-2.2-9.2.6-1.4 2.2 1.2 3.4 4.2 4s5.6 1.8 4.2 4c-1.7 2.8-8 2.4-9.2.6', stroke: 'currentColor', strokeWidth: 2.5, strokeLinecap: 'round' },
      ],
    },
    aliases: ['s', 'sonic', 'ftm', 'fantom'],
  },
  {
    visual: {
      symbol: 'AERO',
      name: 'Aerodrome',
      bg: '#0052FF',
      bgEnd: '#0369A1',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'polygon', points: '16,7.5 23.5,22 16,18.5 8.5,22', fill: 'currentColor' },
      ],
    },
    aliases: ['aero', 'aerodrome', 'aerodrome-finance'],
  },
  {
    visual: {
      symbol: 'CAKE',
      name: 'PancakeSwap',
      bg: '#D1884F',
      bgEnd: '#06B6D4',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'rect', x: 10.5, y: 7.5, width: 3.4, height: 7.5, rx: 1.7, fill: 'currentColor' },
        { tag: 'rect', x: 18.1, y: 7.5, width: 3.4, height: 7.5, rx: 1.7, fill: 'currentColor' },
        { tag: 'rect', x: 9, y: 13.5, width: 14, height: 10, rx: 5, fill: 'currentColor' },
      ],
    },
    aliases: ['cake', 'pancakeswap'],
  },
  {
    visual: {
      symbol: 'GMX',
      name: 'GMX',
      bg: '#2D42FC',
      bgEnd: '#0EA5E9',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'polygon', points: '16,7.5 24,22.5 8,22.5', fill: 'currentColor' },
        { tag: 'polygon', points: '16,14 19.5,20.5 12.5,20.5', fill: '#1E1B4B' },
      ],
    },
    aliases: ['gmx'],
  },
  {
    visual: {
      symbol: 'DYDX',
      name: 'dYdX',
      bg: '#1E1B4B',
      bgEnd: '#312E81',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'line', x1: 21, y1: 9, x2: 11, y2: 23, stroke: 'currentColor', strokeWidth: 2.8, strokeLinecap: 'round' },
        { tag: 'line', x1: 11, y1: 9, x2: 14.5, y2: 14, stroke: '#818CF8', strokeWidth: 2.6, strokeLinecap: 'round' },
        { tag: 'line', x1: 17.5, y1: 18, x2: 21, y2: 23, stroke: '#818CF8', strokeWidth: 2.6, strokeLinecap: 'round' },
      ],
    },
    aliases: ['dydx'],
  },
  {
    visual: {
      symbol: 'RAY',
      name: 'Raydium',
      bg: '#6366F1',
      bgEnd: '#06B6D4',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'polygon', points: '16,7 23.5,11.5 23.5,20.5 16,25 8.5,20.5 8.5,11.5', stroke: 'currentColor', strokeWidth: 2, fill: 'none' },
        { tag: 'path', d: 'M13 20v-8h4.2a2.4 2.4 0 0 1 0 4.8H13m3.5 0 3 3.2', stroke: 'currentColor', strokeWidth: 2.1, strokeLinecap: 'round', strokeLinejoin: 'round' },
      ],
    },
    aliases: ['ray', 'raydium'],
  },
  {
    visual: {
      symbol: 'BONK',
      name: 'Bonk',
      bg: '#F97316',
      bgEnd: '#EA580C',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'circle', cx: 16, cy: 17.5, r: 5.5, fill: 'currentColor' },
        { tag: 'circle', cx: 10.5, cy: 11.5, r: 2, fill: '#FDE047' },
        { tag: 'circle', cx: 16, cy: 9.5, r: 2, fill: '#FDE047' },
        { tag: 'circle', cx: 21.5, cy: 11.5, r: 2, fill: '#FDE047' },
      ],
    },
    aliases: ['bonk'],
  },
  {
    visual: {
      symbol: 'WIF',
      name: 'dogwifhat',
      bg: '#D97706',
      bgEnd: '#B45309',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'path', d: 'M9 19c0-5 3.1-9 7-9s7 4 7 9H9Z', fill: '#F472B6' },
        { tag: 'rect', x: 8, y: 18.5, width: 16, height: 3.8, rx: 1.9, fill: 'currentColor' },
      ],
    },
    aliases: ['wif', 'dogwifhat', 'dogwifcoin'],
  },
  {
    visual: {
      symbol: 'KAITO',
      name: 'Kaito',
      bg: '#10B981',
      bgEnd: '#047857',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'polygon', points: '16,7 24,16 16,25 8,16', stroke: 'currentColor', strokeWidth: 2.1, fill: 'none' },
        { tag: 'path', d: 'M13.5 12v8M19 12l-5.5 4 5.5 4', stroke: 'currentColor', strokeWidth: 2.1, strokeLinecap: 'round', strokeLinejoin: 'round' },
      ],
    },
    aliases: ['kaito'],
  },
  {
    visual: {
      symbol: 'FIGR_HELOC',
      name: 'Figure Heloc',
      bg: '#4338CA',
      bgEnd: '#312E81',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'path', d: 'M11 22.5v-13h10M11 16h7.5', stroke: 'currentColor', strokeWidth: 2.6, strokeLinecap: 'round', strokeLinejoin: 'round' },
      ],
    },
    aliases: ['figr_heloc', 'figure-heloc', 'figure heloc'],
  },
  {
    visual: {
      symbol: 'RAIN',
      name: 'Rain',
      bg: '#0284C7',
      bgEnd: '#0369A1',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'path', d: 'M16 7.5C13 11.5 11 14 11 17a5 5 0 0 0 10 0c0-3-2-5.5-5-9.5Z', fill: 'currentColor' },
        { tag: 'circle', cx: 11.5, cy: 23, r: 1.4, fill: '#BAE6FD' },
        { tag: 'circle', cx: 20.5, cy: 23, r: 1.4, fill: '#BAE6FD' },
      ],
    },
    aliases: ['rain'],
  },
  {
    visual: {
      symbol: 'EURSAFO',
      name: 'Spiko Amundi EUR',
      bg: '#1E3A8A',
      bgEnd: '#1D4ED8',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'path', d: 'M20 11a6.5 6.5 0 1 0 0 10M9.5 14.2h8M9.5 17.8h7', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round' },
      ],
    },
    aliases: ['eursafo', 'spiko-amundi-overnight-swap-fund-eur'],
  },
  {
    visual: {
      symbol: 'M',
      name: 'MemeCore',
      bg: '#7C3AED',
      bgEnd: '#EC4899',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'path', d: 'M9 22V10l7 7.5L23 10v12', stroke: 'currentColor', strokeWidth: 2.6, strokeLinecap: 'round', strokeLinejoin: 'round' },
      ],
    },
    aliases: ['m', 'memecore'],
  },
  {
    visual: {
      symbol: 'U',
      name: 'United Stables',
      bg: '#047857',
      bgEnd: '#065F46',
      fg: '#FFFFFF',
      shapes: [
        { tag: 'path', d: 'M10.5 10v7.5a5.5 5.5 0 0 0 11 0V10', stroke: 'currentColor', strokeWidth: 2.7, strokeLinecap: 'round' },
      ],
    },
    aliases: ['u', 'united-stables', 'united stables'],
  },
];

const CRYPTO_LOOKUP = new Map<string, CryptoVisual>();
for (const spec of CRYPTO_SPECS) {
  CRYPTO_LOOKUP.set(spec.visual.symbol.toLowerCase(), spec.visual);
  CRYPTO_LOOKUP.set(spec.visual.name.toLowerCase(), spec.visual);
  for (const alias of spec.aliases) {
    CRYPTO_LOOKUP.set(alias.toLowerCase(), spec.visual);
  }
}

// 24x24 Chain vector glyphs
const CHAIN_SPECS: readonly ChainSpec[] = [
  {
    visual: {
      id: 'ethereum',
      label: 'Ethereum',
      shortLabel: 'ETH',
      color: '#627EEA',
      bgTint: 'rgba(98, 126, 234, 0.14)',
      shapes: [
        { tag: 'polygon', points: '12,2.5 6.2,12.2 12,15.5 17.8,12.2', fill: 'currentColor' },
        { tag: 'polygon', points: '12,17 6.2,13.8 12,21.5 17.8,13.8', fill: 'currentColor', opacity: 0.78 },
      ],
    },
    aliases: ['ethereum', 'eth', 'mainnet', 'ethereum mainnet'],
  },
  {
    visual: {
      id: 'solana',
      label: 'Solana',
      shortLabel: 'SOL',
      color: '#9945FF',
      bgTint: 'rgba(153, 69, 255, 0.14)',
      shapes: [
        { tag: 'polygon', points: '5.5,8.2 17,8.2 19,5.5 7.5,5.5', fill: 'currentColor' },
        { tag: 'polygon', points: '18.5,13.4 7,13.4 5,10.7 16.5,10.7', fill: 'currentColor' },
        { tag: 'polygon', points: '5.5,18.5 17,18.5 19,15.8 7.5,15.8', fill: 'currentColor' },
      ],
    },
    aliases: ['solana', 'sol'],
  },
  {
    visual: {
      id: 'base',
      label: 'Base',
      shortLabel: 'Base',
      color: '#0052FF',
      bgTint: 'rgba(0, 82, 255, 0.13)',
      shapes: [
        { tag: 'path', d: 'M12 3a9 9 0 1 1-8.95 8.1H15v1.8H3.05A9 9 0 0 1 12 3Z', fill: 'currentColor' },
      ],
    },
    aliases: ['base', 'base mainnet'],
  },
  {
    visual: {
      id: 'arbitrum',
      label: 'Arbitrum',
      shortLabel: 'ARB',
      color: '#28A0F0',
      bgTint: 'rgba(40, 160, 240, 0.14)',
      shapes: [
        { tag: 'polygon', points: '12,2.5 20.2,7.2 20.2,16.8 12,21.5 3.8,16.8 3.8,7.2', stroke: 'currentColor', strokeWidth: 2, fill: 'none' },
        { tag: 'path', d: 'M8.5 16.5 12 7.5l3.5 9', stroke: 'currentColor', strokeWidth: 2.1, strokeLinecap: 'round', strokeLinejoin: 'round' },
      ],
    },
    aliases: ['arbitrum', 'arb', 'arbitrum one', 'arbitrum nova'],
  },
  {
    visual: {
      id: 'optimism',
      label: 'Optimism',
      shortLabel: 'OP',
      color: '#FF0420',
      bgTint: 'rgba(255, 4, 32, 0.12)',
      shapes: [
        { tag: 'circle', cx: 8.5, cy: 12, r: 3.6, stroke: 'currentColor', strokeWidth: 2.3 },
        { tag: 'path', d: 'M14.8 16v-8h2.6a2.3 2.3 0 0 1 0 4.6h-2.6', stroke: 'currentColor', strokeWidth: 2.3, strokeLinecap: 'round', strokeLinejoin: 'round' },
      ],
    },
    aliases: ['optimism', 'op', 'op mainnet'],
  },
  {
    visual: {
      id: 'bnb',
      label: 'BNB Chain',
      shortLabel: 'BNB',
      color: '#D99B10',
      bgTint: 'rgba(243, 186, 47, 0.16)',
      shapes: [
        { tag: 'polygon', points: '12,3.5 16,7.5 14.4,9.1 12,6.7 9.6,9.1 8,7.5', fill: 'currentColor' },
        { tag: 'polygon', points: '12,20.5 16,16.5 14.4,14.9 12,17.3 9.6,14.9 8,16.5', fill: 'currentColor' },
        { tag: 'polygon', points: '12,9.8 14.2,12 12,14.2 9.8,12', fill: 'currentColor' },
        { tag: 'polygon', points: '5.8,9.8 8,12 5.8,14.2 3.6,12', fill: 'currentColor' },
        { tag: 'polygon', points: '18.2,9.8 20.4,12 18.2,14.2 16,12', fill: 'currentColor' },
      ],
    },
    aliases: ['bnb', 'bsc', 'bnb chain', 'bnb smart chain', 'binance', 'binance smart chain', 'opbnb'],
  },
  {
    visual: {
      id: 'polygon',
      label: 'Polygon',
      shortLabel: 'POL',
      color: '#8247E5',
      bgTint: 'rgba(130, 71, 229, 0.14)',
      shapes: [
        { tag: 'path', d: 'M8.5 7 4.5 9.3v4.6l4 2.3 7-4 4 2.3V9.9l-4-2.3-7 4Z', stroke: 'currentColor', strokeWidth: 2, strokeLinejoin: 'round' },
      ],
    },
    aliases: ['polygon', 'pol', 'matic', 'polygon pos', 'polygon zkevm'],
  },
  {
    visual: {
      id: 'avalanche',
      label: 'Avalanche',
      shortLabel: 'AVAX',
      color: '#E84142',
      bgTint: 'rgba(232, 65, 66, 0.14)',
      shapes: [
        { tag: 'polygon', points: '11.2,4.5 4.5,18.5 8.8,18.5 13.4,8.8', fill: 'currentColor' },
        { tag: 'polygon', points: '15.6,11.8 12.2,18.5 19.5,18.5', fill: 'currentColor' },
      ],
    },
    aliases: ['avalanche', 'avax', 'avalanche c-chain'],
  },
  {
    visual: {
      id: 'sui',
      label: 'Sui',
      shortLabel: 'SUI',
      color: '#4DA2FF',
      bgTint: 'rgba(77, 162, 255, 0.14)',
      shapes: [
        { tag: 'path', d: 'M12 3.5C8.5 8 6.5 10.8 6.5 14a5.5 5.5 0 0 0 11 0c0-3.2-2-6-5.5-10.5Z', stroke: 'currentColor', strokeWidth: 2.2, strokeLinejoin: 'round' },
      ],
    },
    aliases: ['sui'],
  },
  {
    visual: {
      id: 'aptos',
      label: 'Aptos',
      shortLabel: 'APT',
      color: '#0891B2',
      bgTint: 'rgba(8, 145, 178, 0.14)',
      shapes: [
        { tag: 'path', d: 'M4.5 8h15M4.5 12h15M4.5 16h15', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round' },
      ],
    },
    aliases: ['aptos', 'apt'],
  },
  {
    visual: {
      id: 'ton',
      label: 'TON',
      shortLabel: 'TON',
      color: '#0098EA',
      bgTint: 'rgba(0, 152, 234, 0.14)',
      shapes: [
        { tag: 'path', d: 'M6 7h12c1 0 1.6 1 1 1.9L12 20 5 8.9C4.4 8 5 7 6 7Z', stroke: 'currentColor', strokeWidth: 2, strokeLinejoin: 'round' },
        { tag: 'line', x1: 12, y1: 7, x2: 12, y2: 19.8, stroke: 'currentColor', strokeWidth: 1.8 },
      ],
    },
    aliases: ['ton', 'the open network', 'toncoin'],
  },
  {
    visual: {
      id: 'monad',
      label: 'Monad',
      shortLabel: 'MON',
      color: '#836EF9',
      bgTint: 'rgba(131, 110, 249, 0.14)',
      shapes: [
        { tag: 'rect', x: 6.5, y: 6.5, width: 11, height: 11, rx: 3.5, stroke: 'currentColor', strokeWidth: 2.5, transform: 'rotate(45 12 12)' },
      ],
    },
    aliases: ['monad', 'mon', 'monad testnet'],
  },
  {
    visual: {
      id: 'berachain',
      label: 'Berachain',
      shortLabel: 'BERA',
      color: '#D97706',
      bgTint: 'rgba(217, 119, 6, 0.14)',
      shapes: [
        { tag: 'circle', cx: 7.5, cy: 7.5, r: 2.2, fill: 'currentColor' },
        { tag: 'circle', cx: 16.5, cy: 7.5, r: 2.2, fill: 'currentColor' },
        { tag: 'circle', cx: 12, cy: 13.5, r: 5.5, fill: 'currentColor' },
      ],
    },
    aliases: ['berachain', 'bera'],
  },
  {
    visual: {
      id: 'hyperevm',
      label: 'HyperEVM',
      shortLabel: 'HYPE',
      color: '#10B981',
      bgTint: 'rgba(16, 185, 129, 0.14)',
      shapes: [
        { tag: 'path', d: 'M4.5 12c0-2.6 2-4.2 3.8-3.4 1.3.6 2 2.1 3.7 2.1s2.4-1.5 3.7-2.1c1.8-.8 3.8.8 3.8 3.4s-2 4.2-3.8 3.4c-1.3-.6-2-2.1-3.7-2.1s-2.4 1.5-3.7 2.1c-1.8.8-3.8-.8-3.8-3.4Z', fill: 'currentColor' },
      ],
    },
    aliases: ['hyperevm', 'hyperliquid', 'hyperliquid l1', 'hype'],
  },
  {
    visual: {
      id: 'starknet',
      label: 'Starknet',
      shortLabel: 'STRK',
      color: '#6366F1',
      bgTint: 'rgba(99, 102, 241, 0.14)',
      shapes: [
        { tag: 'path', d: 'M5 18c3-7.5 7.5-11 14-10.5', stroke: 'currentColor', strokeWidth: 2.4, strokeLinecap: 'round' },
        { tag: 'polygon', points: '16.5,11 17.6,13.4 20,14.5 17.6,15.6 16.5,18 15.4,15.6 13,14.5 15.4,13.4', fill: 'currentColor' },
      ],
    },
    aliases: ['starknet', 'strk'],
  },
  {
    visual: {
      id: 'zksync',
      label: 'zkSync',
      shortLabel: 'ZK',
      color: '#2563EB',
      bgTint: 'rgba(37, 99, 235, 0.14)',
      shapes: [
        { tag: 'polygon', points: '13,6 19.5,12 13,18 13,14.2 8.5,14.2 13,10', fill: 'currentColor' },
        { tag: 'polygon', points: '11,18 4.5,12 11,6 11,9.8 15.5,9.8 11,14', fill: 'currentColor', opacity: 0.72 },
      ],
    },
    aliases: ['zksync', 'zksync era', 'zk'],
  },
  {
    visual: {
      id: 'linea',
      label: 'Linea',
      shortLabel: 'Linea',
      color: '#0EA5E9',
      bgTint: 'rgba(14, 165, 233, 0.14)',
      shapes: [
        { tag: 'path', d: 'M7 6v12h11', stroke: 'currentColor', strokeWidth: 2.6, strokeLinecap: 'round', strokeLinejoin: 'round' },
        { tag: 'circle', cx: 17.5, cy: 6.5, r: 2.3, fill: 'currentColor' },
      ],
    },
    aliases: ['linea'],
  },
  {
    visual: {
      id: 'scroll',
      label: 'Scroll',
      shortLabel: 'Scroll',
      color: '#C9973E',
      bgTint: 'rgba(201, 151, 62, 0.16)',
      shapes: [
        { tag: 'path', d: 'M7.5 6.5h9a2.5 2.5 0 0 1 0 5h-9a2.5 2.5 0 0 0 0 5h9', stroke: 'currentColor', strokeWidth: 2.4, strokeLinecap: 'round' },
      ],
    },
    aliases: ['scroll'],
  },
  {
    visual: {
      id: 'mantle',
      label: 'Mantle',
      shortLabel: 'MNT',
      color: '#0D9488',
      bgTint: 'rgba(13, 148, 136, 0.14)',
      shapes: [
        { tag: 'circle', cx: 12, cy: 12, r: 8.5, stroke: 'currentColor', strokeWidth: 1.9 },
        { tag: 'path', d: 'M7.5 16V8.8L12 13l4.5-4.2V16', stroke: 'currentColor', strokeWidth: 2.1, strokeLinecap: 'round', strokeLinejoin: 'round' },
      ],
    },
    aliases: ['mantle', 'mnt'],
  },
  {
    visual: {
      id: 'blast',
      label: 'Blast',
      shortLabel: 'Blast',
      color: '#CA8A04',
      bgTint: 'rgba(202, 138, 4, 0.16)',
      shapes: [
        { tag: 'path', d: 'M6.5 6h8.5a3 3 0 0 1 0 6H6.5m0 0h9.5a3 3 0 0 1 0 6H6.5', stroke: 'currentColor', strokeWidth: 2.4, strokeLinecap: 'round', strokeLinejoin: 'round' },
      ],
    },
    aliases: ['blast'],
  },
  {
    visual: {
      id: 'abstract',
      label: 'Abstract',
      shortLabel: 'ABS',
      color: '#16A34A',
      bgTint: 'rgba(22, 163, 74, 0.14)',
      shapes: [
        { tag: 'path', d: 'M12 4v16M5.1 8l13.8 8M18.9 8 5.1 16', stroke: 'currentColor', strokeWidth: 2.4, strokeLinecap: 'round' },
      ],
    },
    aliases: ['abstract', 'abs'],
  },
  {
    visual: {
      id: 'sonic',
      label: 'Sonic',
      shortLabel: 'Sonic',
      color: '#F97316',
      bgTint: 'rgba(249, 115, 22, 0.14)',
      shapes: [
        { tag: 'path', d: 'M5 10 15 6l-3 5h7L9 18l3-5H5Z', fill: 'currentColor' },
      ],
    },
    aliases: ['sonic', 'sonic labs', 'fantom'],
  },
  {
    visual: {
      id: 'megaeth',
      label: 'MegaETH',
      shortLabel: 'Mega',
      color: '#7C3AED',
      bgTint: 'rgba(124, 58, 237, 0.14)',
      shapes: [
        { tag: 'path', d: 'M5 17.5V6.5L12 13l7-6.5v11', stroke: 'currentColor', strokeWidth: 2.4, strokeLinecap: 'round', strokeLinejoin: 'round' },
      ],
    },
    aliases: ['megaeth', 'mega'],
  },
  {
    visual: {
      id: 'initia',
      label: 'Initia',
      shortLabel: 'Initia',
      color: '#6366F1',
      bgTint: 'rgba(99, 102, 241, 0.14)',
      shapes: [
        { tag: 'circle', cx: 12, cy: 12, r: 7.5, stroke: 'currentColor', strokeWidth: 2.2 },
        { tag: 'circle', cx: 12, cy: 12, r: 2.6, fill: 'currentColor' },
      ],
    },
    aliases: ['initia', 'init'],
  },
  {
    visual: {
      id: 'movement',
      label: 'Movement',
      shortLabel: 'MOVE',
      color: '#D97706',
      bgTint: 'rgba(217, 119, 6, 0.15)',
      shapes: [
        { tag: 'path', d: 'M4.5 17V7l4.5 5 3-3.5L15 12l4.5-5v10', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round' },
      ],
    },
    aliases: ['movement', 'move'],
  },
  {
    visual: {
      id: 'sei',
      label: 'Sei',
      shortLabel: 'SEI',
      color: '#DC2626',
      bgTint: 'rgba(220, 38, 38, 0.14)',
      shapes: [
        { tag: 'path', d: 'M5 9.5c2.2-2.2 4.8-2.2 7 0s4.8 2.2 7 0M5 14.5c2.2-2.2 4.8-2.2 7 0s4.8 2.2 7 0', stroke: 'currentColor', strokeWidth: 2.3, strokeLinecap: 'round' },
      ],
    },
    aliases: ['sei', 'sei network'],
  },
  {
    visual: {
      id: 'injective',
      label: 'Injective',
      shortLabel: 'INJ',
      color: '#00A2FF',
      bgTint: 'rgba(0, 162, 255, 0.14)',
      shapes: [
        { tag: 'path', d: 'M6 10c1.8-4 6.5-5.2 9.5-3M18 14c-1.8 4-6.5 5.2-9.5 3', stroke: 'currentColor', strokeWidth: 2.3, strokeLinecap: 'round' },
        { tag: 'circle', cx: 12, cy: 12, r: 2.2, fill: 'currentColor' },
      ],
    },
    aliases: ['injective', 'inj'],
  },
  {
    visual: {
      id: 'celestia',
      label: 'Celestia',
      shortLabel: 'TIA',
      color: '#7B2BF9',
      bgTint: 'rgba(123, 43, 249, 0.14)',
      shapes: [
        { tag: 'path', d: 'M16.5 7.2a6.5 6.5 0 1 0 0 9.6 4.8 4.8 0 1 1 0-9.6Z', fill: 'currentColor' },
        { tag: 'circle', cx: 16.8, cy: 12, r: 1.6, fill: 'currentColor' },
      ],
    },
    aliases: ['celestia', 'tia'],
  },
  {
    visual: {
      id: 'bitcoin',
      label: 'Bitcoin',
      shortLabel: 'BTC',
      color: '#F7931A',
      bgTint: 'rgba(247, 147, 26, 0.15)',
      shapes: [
        { tag: 'path', d: 'M9.5 5v14M13.2 5v14', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' },
        { tag: 'path', d: 'M7.8 7.5h6.2a2.4 2.4 0 0 1 0 4.5H7.8m0 0h6.8a2.5 2.5 0 0 1 0 4.8H7.8', stroke: 'currentColor', strokeWidth: 2.1, strokeLinecap: 'round', strokeLinejoin: 'round' },
      ],
    },
    aliases: ['bitcoin', 'btc'],
  },
  {
    visual: {
      id: 'multi-chain',
      label: 'Multi-Chain',
      shortLabel: 'Multi',
      color: '#64748B',
      bgTint: 'rgba(100, 116, 139, 0.14)',
      shapes: [
        { tag: 'circle', cx: 8.5, cy: 9, r: 3.2, stroke: 'currentColor', strokeWidth: 2 },
        { tag: 'circle', cx: 15.5, cy: 9, r: 3.2, stroke: 'currentColor', strokeWidth: 2 },
        { tag: 'circle', cx: 12, cy: 15.5, r: 3.2, stroke: 'currentColor', strokeWidth: 2 },
      ],
    },
    aliases: ['multi-chain', 'multichain', 'multi chain', 'omnichain', 'cross-chain', 'all chains'],
  },
  // Additional live-snapshot Web3 networks
  {
    visual: {
      id: 'tron',
      label: 'Tron',
      shortLabel: 'TRX',
      color: '#EF0027',
      bgTint: 'rgba(239, 0, 39, 0.13)',
      shapes: [
        { tag: 'polygon', points: '5,5 19.5,8 10.8,19.5', stroke: 'currentColor', strokeWidth: 2, fill: 'none' },
      ],
    },
    aliases: ['tron', 'trx'],
  },
  {
    visual: {
      id: 'stellar',
      label: 'Stellar',
      shortLabel: 'XLM',
      color: '#0284C7',
      bgTint: 'rgba(2, 132, 199, 0.14)',
      shapes: [
        { tag: 'circle', cx: 12, cy: 12, r: 5.5, stroke: 'currentColor', strokeWidth: 2 },
        { tag: 'line', x1: 4.5, y1: 16, x2: 19.5, y2: 8, stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' },
      ],
    },
    aliases: ['stellar', 'xlm'],
  },
  {
    visual: {
      id: 'ink',
      label: 'Ink',
      shortLabel: 'Ink',
      color: '#7C3AED',
      bgTint: 'rgba(124, 58, 237, 0.14)',
      shapes: [
        { tag: 'path', d: 'M12 4c-3.5 4.2-5.5 7-5.5 10a5.5 5.5 0 0 0 11 0c0-3-2-5.8-5.5-10Z', fill: 'currentColor' },
      ],
    },
    aliases: ['ink'],
  },
  {
    visual: {
      id: 'unichain',
      label: 'Unichain',
      shortLabel: 'Uni',
      color: '#FF007A',
      bgTint: 'rgba(255, 0, 122, 0.13)',
      shapes: [
        { tag: 'path', d: 'M7.5 6.5v7a4.5 4.5 0 0 0 9 0v-7', stroke: 'currentColor', strokeWidth: 2.5, strokeLinecap: 'round' },
      ],
    },
    aliases: ['unichain'],
  },
  {
    visual: {
      id: 'soneium',
      label: 'Soneium',
      shortLabel: 'Soneium',
      color: '#4F46E5',
      bgTint: 'rgba(79, 70, 229, 0.14)',
      shapes: [
        { tag: 'circle', cx: 12, cy: 12, r: 7.5, stroke: 'currentColor', strokeWidth: 2.2 },
        { tag: 'path', d: 'M9 12a3 3 0 0 1 6 0', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round' },
      ],
    },
    aliases: ['soneium'],
  },
  {
    visual: {
      id: 'apechain',
      label: 'ApeChain',
      shortLabel: 'APE',
      color: '#0054FA',
      bgTint: 'rgba(0, 84, 250, 0.14)',
      shapes: [
        { tag: 'polygon', points: '12,4 20,18.5 4,18.5', stroke: 'currentColor', strokeWidth: 2.2, fill: 'none' },
      ],
    },
    aliases: ['apechain', 'ape'],
  },
  {
    visual: {
      id: 'eclipse',
      label: 'Eclipse',
      shortLabel: 'Eclipse',
      color: '#10B981',
      bgTint: 'rgba(16, 185, 129, 0.14)',
      shapes: [
        { tag: 'circle', cx: 12, cy: 12, r: 7.5, stroke: 'currentColor', strokeWidth: 2.1 },
        { tag: 'path', d: 'M12 4.5a7.5 7.5 0 0 1 0 15Z', fill: 'currentColor' },
      ],
    },
    aliases: ['eclipse'],
  },
  {
    visual: {
      id: 'mode',
      label: 'Mode',
      shortLabel: 'Mode',
      color: '#65A30D',
      bgTint: 'rgba(101, 163, 13, 0.15)',
      shapes: [
        { tag: 'path', d: 'M5.5 17.5v-11L12 13l6.5-6.5v11', stroke: 'currentColor', strokeWidth: 2.4, strokeLinecap: 'round', strokeLinejoin: 'round' },
      ],
    },
    aliases: ['mode'],
  },
  {
    visual: {
      id: 'fraxtal',
      label: 'Fraxtal',
      shortLabel: 'Frax',
      color: '#475569',
      bgTint: 'rgba(71, 85, 105, 0.15)',
      shapes: [
        { tag: 'path', d: 'M6 6l12 12M18 6 6 18', stroke: 'currentColor', strokeWidth: 2.4, strokeLinecap: 'round' },
        { tag: 'circle', cx: 12, cy: 12, r: 3, fill: 'currentColor' },
      ],
    },
    aliases: ['fraxtal'],
  },
  {
    visual: {
      id: 'fuel',
      label: 'Fuel Network',
      shortLabel: 'Fuel',
      color: '#00B87C',
      bgTint: 'rgba(0, 184, 124, 0.14)',
      shapes: [
        { tag: 'polygon', points: '6,5.5 18,5.5 15,11 10.5,11 9,18.5 6,18.5', fill: 'currentColor' },
      ],
    },
    aliases: ['fuel', 'fuel network'],
  },
  {
    visual: {
      id: 'core',
      label: 'CORE',
      shortLabel: 'CORE',
      color: '#F59E0B',
      bgTint: 'rgba(245, 158, 11, 0.15)',
      shapes: [
        { tag: 'polygon', points: '12,3.5 19.5,7.8 19.5,16.2 12,20.5 4.5,16.2 4.5,7.8', stroke: 'currentColor', strokeWidth: 2.2, fill: 'none' },
        { tag: 'circle', cx: 12, cy: 12, r: 2.4, fill: 'currentColor' },
      ],
    },
    aliases: ['core', 'core dao'],
  },
  {
    visual: {
      id: 'gnosis',
      label: 'Gnosis',
      shortLabel: 'GNO',
      color: '#04795B',
      bgTint: 'rgba(4, 121, 91, 0.14)',
      shapes: [
        { tag: 'circle', cx: 12, cy: 12, r: 8, stroke: 'currentColor', strokeWidth: 2.1 },
        { tag: 'path', d: 'M8 10.5c1.5 1.5 2.5 1.5 4 0 1.5 1.5 2.5 1.5 4 0', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' },
      ],
    },
    aliases: ['gnosis', 'gno', 'xdai'],
  },
  {
    visual: {
      id: 'near',
      label: 'NEAR',
      shortLabel: 'NEAR',
      color: '#00C08B',
      bgTint: 'rgba(0, 192, 139, 0.14)',
      shapes: [
        { tag: 'path', d: 'M6.5 17.5v-11l11 11v-11', stroke: 'currentColor', strokeWidth: 2.4, strokeLinecap: 'round', strokeLinejoin: 'round' },
      ],
    },
    aliases: ['near', 'near protocol'],
  },
  {
    visual: {
      id: 'cosmos',
      label: 'Cosmos',
      shortLabel: 'ATOM',
      color: '#5064FB',
      bgTint: 'rgba(80, 100, 251, 0.14)',
      shapes: [
        { tag: 'circle', cx: 12, cy: 12, r: 2.1, fill: 'currentColor' },
        { tag: 'ellipse', cx: 12, cy: 12, rx: 8.2, ry: 3.4, stroke: 'currentColor', strokeWidth: 1.7 },
        { tag: 'ellipse', cx: 12, cy: 12, rx: 8.2, ry: 3.4, stroke: 'currentColor', strokeWidth: 1.7, transform: 'rotate(60 12 12)' },
      ],
    },
    aliases: ['cosmos', 'cosmos hub', 'atom'],
  },
  {
    visual: {
      id: 'cardano',
      label: 'Cardano',
      shortLabel: 'ADA',
      color: '#0033AD',
      bgTint: 'rgba(0, 51, 173, 0.14)',
      shapes: [
        { tag: 'circle', cx: 12, cy: 12, r: 2.2, fill: 'currentColor' },
        { tag: 'circle', cx: 12, cy: 6.2, r: 1.4, fill: 'currentColor' },
        { tag: 'circle', cx: 12, cy: 17.8, r: 1.4, fill: 'currentColor' },
        { tag: 'circle', cx: 7, cy: 9.1, r: 1.4, fill: 'currentColor' },
        { tag: 'circle', cx: 17, cy: 9.1, r: 1.4, fill: 'currentColor' },
        { tag: 'circle', cx: 7, cy: 14.9, r: 1.4, fill: 'currentColor' },
        { tag: 'circle', cx: 17, cy: 14.9, r: 1.4, fill: 'currentColor' },
      ],
    },
    aliases: ['cardano', 'ada'],
  },
  {
    visual: {
      id: 'cronos',
      label: 'Cronos',
      shortLabel: 'CRO',
      color: '#1D4ED8',
      bgTint: 'rgba(29, 78, 216, 0.14)',
      shapes: [
        { tag: 'polygon', points: '12,3.5 19.5,7.8 19.5,16.2 12,20.5 4.5,16.2 4.5,7.8', stroke: 'currentColor', strokeWidth: 2.1, fill: 'none' },
      ],
    },
    aliases: ['cronos', 'cro'],
  },
  {
    visual: {
      id: 'canton',
      label: 'Canton Network',
      shortLabel: 'Canton',
      color: '#4F46E5',
      bgTint: 'rgba(79, 70, 229, 0.14)',
      shapes: [
        { tag: 'path', d: 'M16.5 7.5a6.5 6.5 0 1 0 0 9', stroke: 'currentColor', strokeWidth: 2.4, strokeLinecap: 'round' },
      ],
    },
    aliases: ['canton', 'canton network'],
  },
  {
    visual: {
      id: 'neon',
      label: 'Neon EVM',
      shortLabel: 'Neon',
      color: '#EC4899',
      bgTint: 'rgba(236, 72, 153, 0.14)',
      shapes: [
        { tag: 'path', d: 'M7 17.5v-11l10 11v-11', stroke: 'currentColor', strokeWidth: 2.4, strokeLinecap: 'round', strokeLinejoin: 'round' },
      ],
    },
    aliases: ['neon', 'neon evm'],
  },
  {
    visual: {
      id: 'shibarium',
      label: 'Shibarium',
      shortLabel: 'SHIB',
      color: '#EA580C',
      bgTint: 'rgba(234, 88, 12, 0.14)',
      shapes: [
        { tag: 'circle', cx: 12, cy: 12, r: 7.5, stroke: 'currentColor', strokeWidth: 2.2 },
        { tag: 'polygon', points: '12,7 16,15 8,15', fill: 'currentColor' },
      ],
    },
    aliases: ['shibarium'],
  },
  {
    visual: {
      id: 'viction',
      label: 'Viction',
      shortLabel: 'VIC',
      color: '#10B981',
      bgTint: 'rgba(16, 185, 129, 0.14)',
      shapes: [
        { tag: 'path', d: 'M6 7.5 12 18l6-10.5', stroke: 'currentColor', strokeWidth: 2.5, strokeLinecap: 'round', strokeLinejoin: 'round' },
      ],
    },
    aliases: ['viction', 'viction (tomochain)', 'tomochain'],
  },
  {
    visual: {
      id: 'robinhood',
      label: 'Robinhood Chain',
      shortLabel: 'HOOD',
      color: '#00C805',
      bgTint: 'rgba(0, 200, 5, 0.14)',
      shapes: [
        { tag: 'path', d: 'M18.5 5.5C12.5 6 8 10 6.5 18.5c3.5-1.5 6.5-3.2 8.8-6.2', stroke: 'currentColor', strokeWidth: 2.3, strokeLinecap: 'round', strokeLinejoin: 'round' },
      ],
    },
    aliases: ['robinhood', 'robinhood chain'],
  },
  {
    visual: {
      id: 'arc',
      label: 'Arc',
      shortLabel: 'Arc',
      color: '#0EA5E9',
      bgTint: 'rgba(14, 165, 233, 0.14)',
      shapes: [
        { tag: 'path', d: 'M5 17a7 7 0 0 1 14 0', stroke: 'currentColor', strokeWidth: 2.5, strokeLinecap: 'round' },
      ],
    },
    aliases: ['arc'],
  },
];

const CHAIN_LOOKUP = new Map<string, ChainVisual>();
for (const spec of CHAIN_SPECS) {
  CHAIN_LOOKUP.set(spec.visual.id, spec.visual);
  CHAIN_LOOKUP.set(spec.visual.label.toLowerCase(), spec.visual);
  for (const alias of spec.aliases) {
    CHAIN_LOOKUP.set(alias.toLowerCase(), spec.visual);
  }
}

const SOURCE_REGISTRY: ReadonlyArray<{ visual: SourceVisual; aliases: readonly string[] }> = [
  { visual: { id: 'telegram', label: 'Telegram', iconKind: 'telegram', color: '#229ED9' }, aliases: ['telegram', 'tg'] },
  { visual: { id: 'x', label: 'X', iconKind: 'x', color: '#52525B' }, aliases: ['x', 'twitter'] },
  { visual: { id: 'feed', label: 'Feed', iconKind: 'rss', color: '#EA580C' }, aliases: ['feed', 'rss', 'atom'] },
  { visual: { id: 'sheet', label: 'Sheet', iconKind: 'sheet', color: '#16A34A' }, aliases: ['sheet', 'sheets', 'google sheets'] },
  { visual: { id: 'surf', label: 'Surf', iconKind: 'compass', color: '#0064E0' }, aliases: ['surf', 'asksurf', 'surf.ai', 'surf curated'] },
  { visual: { id: 'coingecko', label: 'CoinGecko', iconKind: 'coins', color: '#65A30D' }, aliases: ['coingecko', 'coin gecko'] },
  { visual: { id: 'coinpaprika', label: 'CoinPaprika', iconKind: 'coins', color: '#E11D48' }, aliases: ['coinpaprika', 'coin paprika'] },
  { visual: { id: 'binance-vision', label: 'Binance Vision', iconKind: 'flame', color: '#D97706' }, aliases: ['binance vision', 'binance'] },
  { visual: { id: 'defillama', label: 'DefiLlama', iconKind: 'layers', color: '#2563EB' }, aliases: ['defillama', 'defi llama'] },
  { visual: { id: 'defillama-yields', label: 'DefiLlama Yields', iconKind: 'percent', color: '#0D9488' }, aliases: ['defillama yields', 'defi llama yields'] },
  { visual: { id: 'polymarket', label: 'Polymarket', iconKind: 'target', color: '#1D4ED8' }, aliases: ['polymarket'] },
  { visual: { id: 'dexscreener', label: 'DexScreener', iconKind: 'trending', color: '#16A34A' }, aliases: ['dexscreener', 'dex screener'] },
  { visual: { id: 'github-search', label: 'GitHub Search', iconKind: 'github', color: '#6366F1' }, aliases: ['github search', 'github'] },
  { visual: { id: 'merkl', label: 'Merkl', iconKind: 'sparkles', color: '#7C3AED' }, aliases: ['merkl'] },
  { visual: { id: 'pendle', label: 'Pendle', iconKind: 'percent', color: '#0891B2' }, aliases: ['pendle'] },
  { visual: { id: 'airdropalert', label: 'AirdropAlert', iconKind: 'radar', color: '#0284C7' }, aliases: ['airdropalert', 'airdrop alert'] },
  { visual: { id: 'asso7878', label: 'ASSO7878', iconKind: 'sheet', color: '#059669' }, aliases: ['asso7878', '@asso7878'] },
  { visual: { id: 'arndxt', label: 'arndxt', iconKind: 'sheet', color: '#9333EA' }, aliases: ['arndxt', '@arndxt'] },
];

const SOURCE_LOOKUP = new Map<string, SourceVisual>();
for (const entry of SOURCE_REGISTRY) {
  SOURCE_LOOKUP.set(entry.visual.id, entry.visual);
  SOURCE_LOOKUP.set(entry.visual.label.toLowerCase(), entry.visual);
  for (const alias of entry.aliases) {
    SOURCE_LOOKUP.set(alias.toLowerCase(), entry.visual);
  }
}

const BRAND_PALETTES: readonly BrandPalette[] = [
  { bgStart: '#0064E0', bgEnd: '#1D4ED8', accent: '#93C5FD', fg: '#FFFFFF' },
  { bgStart: '#0D9488', bgEnd: '#047857', accent: '#99F6E4', fg: '#FFFFFF' },
  { bgStart: '#4F46E5', bgEnd: '#3730A3', accent: '#C7D2FE', fg: '#FFFFFF' },
  { bgStart: '#7C3AED', bgEnd: '#5B21B6', accent: '#DDD6FE', fg: '#FFFFFF' },
  { bgStart: '#0284C7', bgEnd: '#0369A1', accent: '#BAE6FD', fg: '#FFFFFF' },
  { bgStart: '#D97706', bgEnd: '#B45309', accent: '#FDE68A', fg: '#FFFFFF' },
  { bgStart: '#E11D48', bgEnd: '#9F1239', accent: '#FECDD3', fg: '#FFFFFF' },
  { bgStart: '#059669', bgEnd: '#065F46', accent: '#A7F3D0', fg: '#FFFFFF' },
  { bgStart: '#9333EA', bgEnd: '#6B21A8', accent: '#E9D5FF', fg: '#FFFFFF' },
  { bgStart: '#EA580C', bgEnd: '#C2410C', accent: '#FED7AA', fg: '#FFFFFF' },
  { bgStart: '#2563EB', bgEnd: '#1E3A8A', accent: '#BFDBFE', fg: '#FFFFFF' },
  { bgStart: '#334155', bgEnd: '#0F172A', accent: '#CBD5E1', fg: '#FFFFFF' },
];

const GEOMETRIC_KINDS: readonly GeometricKind[] = [
  'hex',
  'diamond',
  'orbit',
  'prism',
  'shield',
  'cube',
  'wave',
  'spark',
];

const GENERIC_HOSTS = new Set([
  't.me',
  'telegram.me',
  'telegram.org',
  'x.com',
  'twitter.com',
  'discord.gg',
  'discord.com',
  'github.com',
  'medium.com',
  'mirror.xyz',
  'galxe.com',
  'zealy.io',
  'layer3.xyz',
  'intract.io',
  'coingecko.com',
  'coinpaprika.com',
  'defillama.com',
  'dexscreener.com',
  'polymarket.com',
  'youtube.com',
  'youtu.be',
  'docs.google.com',
  'forms.gle',
  'notion.so',
  'substack.com',
  'airdropalert.com',
  'asksurf.ai',
  'cryptorank.io',
  'merkl.xyz',
  'guild.xyz',
  'questn.com',
]);

const TWO_PART_SUFFIXES = new Set([
  'co.uk',
  'org.uk',
  'ac.uk',
  'com.au',
  'com.br',
  'co.jp',
  'com.sg',
  'co.kr',
  'com.tr',
  'com.mx',
]);

const PLACEHOLDER_TICKERS = new Set([
  '-',
  '--',
  '\u2014',
  'N/A',
  'NA',
  'NONE',
  'NULL',
  'TBA',
  'TBD',
  'FREE',
  'LIVE',
  'PRE',
  'BETA',
  'ALPHA',
  'TESTNET',
  'MAINNET',
  'AIRDROP',
  'TGE',
  'NEW',
  'OLD',
  'DEPRECATED',
  'V1',
  'V2',
  'V3',
  'V4',
]);

const NON_TICKER_PARENS = new Set([
  'EUR',
  'USD',
  'GBP',
  'JPY',
  'V1',
  'V2',
  'V3',
  'V4',
  'BETA',
  'ALPHA',
  'TESTNET',
  'MAINNET',
  'LIVE',
  'NEW',
  'OLD',
  'DEPRECATED',
  'AIRDROP',
  'TGE',
  'TBA',
  'TBD',
  'OFFICIAL',
  'LEGACY',
  'PREV',
  'PERP',
  'SPOT',
]);

const MEGA_CAP_TICKERS = new Set(['BTC', 'ETH', 'SOL', 'USDT', 'USDC', 'BNB', 'XRP', 'HYPE']);

const DOLLAR_TICKER_RE = /(?:^|[\s([{-])\$([A-Za-z][A-Za-z0-9._-]{0,11})(?=$|[\s)\]},.:;!?])/;
const PAREN_ALL_RE = /\(([^()]{1,24})\)/g;
const STRICT_TICKER_RE = /^[A-Z][A-Z0-9._-]{0,11}$/;

function fnv1aHash(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function advanceAvatarImageIndex(currentIndex: number, totalUrls: number): number {
  if (totalUrls <= 0) return 0;
  return Math.min(currentIndex + 1, totalUrls);
}

export function sanitizeImageUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password) return null;
    if (!parsed.hostname.includes('.')) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

export function extractTickerFallback(
  name?: string | null,
  explicitTicker?: string | null,
): string | null {
  if (explicitTicker) {
    const cleaned = explicitTicker.trim().replace(/^\$+/, '').toUpperCase();
    if (cleaned && !PLACEHOLDER_TICKERS.has(cleaned) && STRICT_TICKER_RE.test(cleaned)) {
      return cleaned;
    }
  }

  if (!name) return null;
  const trimmed = name.trim();
  if (!trimmed) return null;

  const dollarMatch = trimmed.match(DOLLAR_TICKER_RE);
  if (dollarMatch) {
    const candidate = dollarMatch[1].toUpperCase();
    if (!PLACEHOLDER_TICKERS.has(candidate) && STRICT_TICKER_RE.test(candidate)) {
      return candidate;
    }
  }

  // Scan parentheticals from right to left so "Fund (EUR) (EURSAFO)" extracts EURSAFO.
  const parenMatches = [...trimmed.matchAll(PAREN_ALL_RE)];
  for (let i = parenMatches.length - 1; i >= 0; i -= 1) {
    const rawInside = parenMatches[i][1].trim().replace(/^\$+/, '');
    if (!rawInside || rawInside !== rawInside.toUpperCase()) continue;
    if (NON_TICKER_PARENS.has(rawInside) || PLACEHOLDER_TICKERS.has(rawInside)) continue;
    if (STRICT_TICKER_RE.test(rawInside)) {
      return rawInside;
    }
  }

  return null;
}

export function getCryptoVisual(symbolOrIdOrName: string | null | undefined): CryptoVisual | null {
  if (!symbolOrIdOrName) return null;
  const trimmed = symbolOrIdOrName.trim();
  if (!trimmed) return null;

  const direct = trimmed.replace(/^\$+/, '').toLowerCase();
  const exact = CRYPTO_LOOKUP.get(direct);
  if (exact) return exact;

  // Handle CoinPaprika ids like "btc-bitcoin" or "sol-solana"
  const dashIdx = direct.indexOf('-');
  if (dashIdx > 0) {
    const prefix = direct.slice(0, dashIdx);
    const suffix = direct.slice(dashIdx + 1);
    const bySuffix = CRYPTO_LOOKUP.get(suffix);
    if (bySuffix) return bySuffix;
    if (prefix.length >= 2) {
      const byPrefix = CRYPTO_LOOKUP.get(prefix);
      if (byPrefix && (suffix.includes(byPrefix.name.toLowerCase().split(' ')[0]) || suffix === prefix)) {
        return byPrefix;
      }
    }
  }

  // Handle display labels like "Bitcoin (BTC)" or "Gram (prev. Toncoin) (GRAM)"
  const extractedTicker = extractTickerFallback(trimmed);
  if (extractedTicker) {
    const byExtracted = CRYPTO_LOOKUP.get(extractedTicker.toLowerCase());
    if (byExtracted) return byExtracted;
  }

  // Strip parenthetical suffix and retry base name (e.g. "Tether (USDT)" -> "tether")
  const baseName = trimmed.replace(/\s*\([^)]*\)\s*/g, ' ').trim().toLowerCase();
  if (baseName && baseName !== direct) {
    const byBase = CRYPTO_LOOKUP.get(baseName);
    if (byBase) return byBase;
  }

  return null;
}

export function getChainVisual(chainName: string | null | undefined): ChainVisual | null {
  if (!chainName) return null;
  const normalized = chainName
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  if (!normalized) return null;

  const direct = CHAIN_LOOKUP.get(normalized);
  if (direct) return direct;

  const stripped = normalized
    .replace(/\s+(mainnet|testnet|network|chain|l1|l2)$/i, '')
    .trim();
  if (stripped && stripped !== normalized) {
    return CHAIN_LOOKUP.get(stripped) ?? null;
  }

  return null;
}

export function getSourceVisual(sourceOrPlatform: string | null | undefined): SourceVisual {
  const raw = sourceOrPlatform?.trim() ?? '';
  if (!raw) {
    return { id: 'unknown', label: 'Source', iconKind: 'globe', color: '#64748B' };
  }

  const lower = raw.toLowerCase();
  const exact = SOURCE_LOOKUP.get(lower);
  if (exact) return exact;

  const withoutAt = lower.replace(/^@+/, '');
  const byHandle = SOURCE_LOOKUP.get(withoutAt);
  if (byHandle) return byHandle;

  return {
    id: 'unknown',
    label: raw,
    iconKind: 'globe',
    color: '#64748B',
  };
}

function normalizeProjectKey(name: string): string {
  return name
    .trim()
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/\$[A-Za-z][A-Za-z0-9._-]*/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function normalizeBaseProjectKey(name: string): string {
  const cleaned = name
    .trim()
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/\$[A-Za-z][A-Za-z0-9._-]*/g, '')
    .replace(/\b(v\d+|protocol|network|finance|labs|dao|app|chain|exchange|swap|pro)\b/gi, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
  return cleaned.length >= 3 ? cleaned : '';
}

function extractRegistrableDomain(urlOrDomain: string | null | undefined): string | null {
  if (!urlOrDomain) return null;
  const trimmed = urlOrDomain.trim();
  if (!trimmed) return null;

  let host: string;
  try {
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    host = new URL(withScheme).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }

  if (!host.includes('.')) return null;
  const parts = host.split('.').filter(Boolean);
  if (parts.length < 2) return null;

  const tail2 = parts.slice(-2).join('.');
  const domain =
    parts.length >= 3 && TWO_PART_SUFFIXES.has(tail2)
      ? parts.slice(-3).join('.')
      : tail2;

  if (GENERIC_HOSTS.has(domain) || GENERIC_HOSTS.has(host)) return null;
  return domain;
}

function upsertEntry(
  map: Map<string, ProjectLogoEntry>,
  key: string | null | undefined,
  patch: ProjectLogoEntry,
  overwrite = false,
): void {
  if (!key) return;
  const existing = map.get(key);
  if (!existing) {
    map.set(key, { ...patch });
    return;
  }
  map.set(key, {
    logoUrl: overwrite ? (patch.logoUrl ?? existing.logoUrl) : (existing.logoUrl ?? patch.logoUrl),
    ticker: overwrite ? (patch.ticker ?? existing.ticker) : (existing.ticker ?? patch.ticker),
    name: existing.name ?? patch.name,
  });
}

function indexProjectRecord(
  index: ProjectLogoIndex,
  name: string | null | undefined,
  ticker: string | null | undefined,
  rawLogo: string | null | undefined,
  urlOrDomain: string | null | undefined,
): void {
  const logoUrl = sanitizeImageUrl(rawLogo) ?? undefined;
  const resolvedTicker = extractTickerFallback(name, ticker) ?? undefined;
  if (!logoUrl && !resolvedTicker) return;

  const entry: ProjectLogoEntry = {
    logoUrl,
    ticker: resolvedTicker,
    name: name?.trim() || undefined,
  };

  if (name) {
    const exactKey = normalizeProjectKey(name);
    if (exactKey.length >= 2) {
      upsertEntry(index.byName, exactKey, entry);
    }
    const baseKey = normalizeBaseProjectKey(name);
    if (baseKey && baseKey !== exactKey) {
      upsertEntry(index.byName, baseKey, entry);
    }
  }

  const domain = extractRegistrableDomain(urlOrDomain);
  if (domain) {
    upsertEntry(index.byDomain, domain, entry);
  }

  if (resolvedTicker && resolvedTicker.length >= 2) {
    upsertEntry(index.byTicker, resolvedTicker, entry);
  }
}

export function buildProjectLogoIndex(
  cards?: readonly LogoIndexCardInput[] | null,
  marketSections?: readonly LogoIndexMarketSectionInput[] | null,
  options?: {
    tge?: readonly LogoIndexTgeInput[] | null;
    feedItems?: readonly LogoIndexFeedItemInput[] | null;
  },
): ProjectLogoIndex {
  const index: ProjectLogoIndex = {
    byName: new Map(),
    byDomain: new Map(),
    byTicker: new Map(),
  };

  if (cards) {
    for (const card of cards) {
      indexProjectRecord(index, card.n, card.t, card.img, card.url);
    }
  }

  if (options?.tge) {
    for (const tge of options.tge) {
      indexProjectRecord(index, tge.n, tge.t, tge.logo, tge.url);
    }
  }

  if (marketSections) {
    for (const section of marketSections) {
      for (const row of section.rows) {
        const name = row.cells[0] ?? row.id ?? '';
        const logo = row.icon ?? row.logo ?? row.img ?? null;
        indexProjectRecord(index, name, null, logo, row.href);
        if (row.id && logo) {
          const safeLogo = sanitizeImageUrl(logo);
          if (safeLogo) {
            const rawSlug = row.id.trim().toLowerCase();
            upsertEntry(index.byName, rawSlug, { logoUrl: safeLogo, name });
            const normSlug = normalizeProjectKey(row.id);
            if (normSlug.length >= 2) {
              upsertEntry(index.byName, normSlug, { logoUrl: safeLogo, name });
            }
          }
        }
      }
    }
  }

  if (options?.feedItems) {
    for (const item of options.feedItems) {
      const domainOrUrl = item.domain ?? item.links?.[0]?.url ?? null;
      indexProjectRecord(index, item.project, item.ticker, item.logo, domainOrUrl);
    }
  }

  return index;
}

export function extractMonogram(name: string | null | undefined, fallbackTicker?: string | null): string {
  const raw = (name ?? fallbackTicker ?? '').trim().replace(/^\$+/, '');
  if (!raw) return '?';

  // For GitHub owner/repo strings, prefer repo initials when present
  const slashParts = raw.split('/').filter(Boolean);
  const target = slashParts.length === 2 ? slashParts[1] : raw;

  const cleaned = target.replace(/\([^)]*\)/g, ' ').trim();
  const words = cleaned.split(/[\s._-]+/).filter(Boolean);
  if (words.length >= 2) {
    return `${words[0][0]}${words[1][0]}`.toUpperCase();
  }

  const single = words[0] ?? raw;
  const camelCap = single.slice(1).match(/[A-Z]/);
  if (camelCap && single.length >= 2) {
    return `${single[0]}${camelCap[0]}`.toUpperCase();
  }

  return single.slice(0, 2).toUpperCase() || '?';
}

function lookupIndexEntry(
  index: ProjectLogoIndex | null | undefined,
  name: string | null | undefined,
  protocolSlug: string | null | undefined,
  domainOrUrl: string | null | undefined,
  ticker: string | null | undefined,
  sectionId: string | null | undefined,
): ProjectLogoEntry | null {
  if (!index) return null;

  if (protocolSlug) {
    const rawSlug = protocolSlug.trim().toLowerCase();
    const bySlug = rawSlug ? index.byName.get(rawSlug) : undefined;
    if (bySlug?.logoUrl) return bySlug;
    const normSlug = normalizeProjectKey(protocolSlug);
    const byNormSlug = normSlug ? index.byName.get(normSlug) : undefined;
    if (byNormSlug?.logoUrl) return byNormSlug;
    const baseSlug = normalizeBaseProjectKey(protocolSlug);
    const byBaseSlug = baseSlug ? index.byName.get(baseSlug) : undefined;
    if (byBaseSlug?.logoUrl) return byBaseSlug;
  }

  if (name) {
    const exactKey = normalizeProjectKey(name);
    const byExact = exactKey ? index.byName.get(exactKey) : undefined;
    if (byExact?.logoUrl) return byExact;

    const baseKey = normalizeBaseProjectKey(name);
    const byBase = baseKey ? index.byName.get(baseKey) : undefined;
    if (byBase?.logoUrl) return byBase;
  }

  const domain = extractRegistrableDomain(domainOrUrl);
  if (domain) {
    const byDomain = index.byDomain.get(domain);
    if (byDomain?.logoUrl) return byDomain;
  }

  if (ticker && sectionId !== 'drops') {
    const byTicker = index.byTicker.get(ticker.toUpperCase());
    if (byTicker?.logoUrl) return byTicker;
  }

  return null;
}

const GITHUB_OWNER_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;
const GITHUB_RESERVED_OWNERS = new Set([
  'topics',
  'search',
  'explore',
  'orgs',
  'marketplace',
  'sponsors',
  'features',
  'about',
  'settings',
  'trending',
]);

const COINPAPRIKA_COMPOUND_ID_RE = /^[a-z0-9]{1,12}-[a-z0-9-]{2,}$/;

// Strictly limited to DefiLlama protocol slugs confirmed HTTP 200 in live CDN verification.
const VERIFIED_LLAMA_PROTOCOL_SLUGS = new Set([
  'lido',
  'aave',
  'aave-v3',
  'layerzero',
  'layerzero-v2',
  'pendle',
  'ether.fi',
  'ether.fi-stake',
  'ethena-usde',
  'sparklend',
  'blackrock-buidl',
  'ondo-yield-assets',
  'eigencloud',
  'polymarket',
]);

function extractGithubOwner(input: ResolveEntityVisualInput): string | null {
  const fromRepo = (value: string | null | undefined): string | null => {
    if (!value) return null;
    const parts = value.trim().split('/');
    if (parts.length !== 2) return null;
    const owner = parts[0].trim();
    if (!GITHUB_OWNER_RE.test(owner) || GITHUB_RESERVED_OWNERS.has(owner.toLowerCase())) return null;
    return owner;
  };

  if (input.sectionId === 'github') {
    const fromId = fromRepo(input.id);
    if (fromId) return fromId;
    const fromName = fromRepo(input.name);
    if (fromName) return fromName;
  }

  if (input.url) {
    try {
      const parsed = new URL(input.url.trim());
      if (parsed.hostname.toLowerCase() === 'github.com') {
        const segments = parsed.pathname.split('/').filter(Boolean);
        if (segments.length >= 2) {
          const owner = segments[0];
          if (GITHUB_OWNER_RE.test(owner) && !GITHUB_RESERVED_OWNERS.has(owner.toLowerCase())) {
            return owner;
          }
        }
      }
    } catch {
      return null;
    }
  }

  return null;
}

// Populated ONLY for CDN patterns confirmed HTTP 200 in live browser CDN verification.
function buildVerifiedCdnUrls(input: ResolveEntityVisualInput): readonly string[] {
  const out: string[] = [];

  const ghOwner = extractGithubOwner(input);
  if (ghOwner) {
    out.push(`https://github.com/${ghOwner}.png?size=64`);
  }

  const sourceLower = input.source?.trim().toLowerCase() ?? '';
  if (sourceLower === 'coinpaprika' && input.id) {
    const idLower = input.id.trim().toLowerCase();
    if (COINPAPRIKA_COMPOUND_ID_RE.test(idLower)) {
      out.push(`https://static.coinpaprika.com/coin/${idLower}/logo.png`);
    }
  }

  if (input.sectionId === 'defi' || input.sectionId === 'yields') {
    const candidateSlug = (input.protocolSlug ?? input.id ?? '').trim().toLowerCase();
    if (candidateSlug && VERIFIED_LLAMA_PROTOCOL_SLUGS.has(candidateSlug)) {
      out.push(`https://icons.llamao.fi/icons/protocols/${candidateSlug}?w=48&h=48`);
    }
  }

  return out;
}

function pushUniqueSafeUrl(target: string[], candidate: string | null | undefined): void {
  const safe = sanitizeImageUrl(candidate);
  if (!safe || target.includes(safe)) return;
  target.push(safe);
}

export function resolveEntityVisual(input: ResolveEntityVisualInput): ResolvedEntityVisual {
  const resolvedTicker = extractTickerFallback(input.name, input.ticker ?? input.symbol);
  const imageUrls: string[] = [];

  // 1. Authoritative upstream URLs first
  pushUniqueSafeUrl(imageUrls, input.img);
  pushUniqueSafeUrl(imageUrls, input.logo);
  pushUniqueSafeUrl(imageUrls, input.icon);

  // 2. Cross-feed logoIndex match
  const indexed = lookupIndexEntry(
    input.logoIndex,
    input.name,
    input.protocolSlug,
    input.domain ?? input.url,
    resolvedTicker,
    input.sectionId,
  );
  pushUniqueSafeUrl(imageUrls, indexed?.logoUrl);

  // 3. Verified CDN fallbacks (strictly gated on live HTTP 200 verification)
  for (const verifiedUrl of buildVerifiedCdnUrls(input)) {
    pushUniqueSafeUrl(imageUrls, verifiedUrl);
  }

  // Inline crypto visual resolution
  const isDrops = input.sectionId === 'drops';
  let cryptoVisual =
    getCryptoVisual(input.name) ??
    getCryptoVisual(input.id) ??
    getCryptoVisual(input.symbol);

  if (!cryptoVisual && resolvedTicker) {
    const tickerMatch = getCryptoVisual(resolvedTicker);
    const skipUnrelatedDropsMention =
      isDrops && Boolean(input.name?.trim()) && MEGA_CAP_TICKERS.has(resolvedTicker);
    if (tickerMatch && !skipUnrelatedDropsMention) {
      cryptoVisual = tickerMatch;
    }
  }

  const chainFromName = getChainVisual(input.name);
  const chainVisual = getChainVisual(input.chain) ?? chainFromName;
  const isChainEntity = Boolean(chainFromName && !cryptoVisual);

  const hashSeed = (
    normalizeProjectKey(input.name ?? '') ||
    resolvedTicker ||
    input.id ||
    input.domain ||
    'web3-radar'
  ).toLowerCase();
  const hash = fnv1aHash(hashSeed);

  return {
    imageUrls,
    cryptoVisual,
    chainVisual,
    isChainEntity,
    monogram: extractMonogram(input.name, resolvedTicker),
    palette: BRAND_PALETTES[hash % BRAND_PALETTES.length],
    geometricKind: GEOMETRIC_KINDS[(hash >>> 4) % GEOMETRIC_KINDS.length],
    resolvedTicker,
  };
}
