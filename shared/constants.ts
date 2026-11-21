import type { Badge, FitKey, MarketSectionId, Tab } from './types';

export const FIT: Record<FitKey, string> = {
  zero: 'Zero-cost',
  multi: 'Multi-account',
  small: 'Small budget',
  climber: 'Leaderboard climber',
  community: 'Community contributor',
  technical: 'Technical',
};

export const BADGES: Record<Badge, string> = {
  live: 'Live · announced',
  token: 'Token live',
  early: 'Early upside',
  zero: 'Zero-cost path',
  rerun: 'Re-run',
  risk: 'Risk flag',
};

export const TYPES: string[] = [
  'Trading',
  'Token airdrop',
  'Points',
  'Whitelist',
  'NFT',
  'Testnet',
  'Mainnet',
  'Social',
  'Staking',
  'DePIN / Node',
  'Stock tokens',
  'Betting',
];

export const CATEGORIES: string[] = [
  'OKX Boost',
  'Binance Alpha',
  'Gate Airdrops',
  'Token Presales',
];

export const TASK_TYPES = [
  'testnet',
  'faucet',
  'quest',
  'waitlist',
  'bridge',
  'stake',
  'mint',
  'points',
  'trade',
  'social',
  'node',
  'other',
] as const;

export const TYPE_MAP: Record<string, string[]> = {
  Trading: ['trading', 'liquidity', 'check-wallet'],
  'Token airdrop': ['mint', 'ambassador', 'game', 'bounty', 'social', 'role'],
  Points: ['trading', 'liquidity', 'staking', 'mainnet', 'testnet', 'depin'],
  Whitelist: ['form'],
  NFT: ['mint'],
  Testnet: ['testnet'],
  Mainnet: ['mainnet'],
  Social: ['social', 'ambassador', 'role'],
  Staking: ['staking'],
  'DePIN / Node': ['depin'],
  'Stock tokens': [],
  Betting: ['predictions'],
};

export const TABS: Tab[] = [
  { id: 'drops', label: 'Drops' },
  { id: 'airdrops', label: 'Airdrops' },
  { id: 'crypto', label: 'Crypto' },
  { id: 'defi', label: 'DeFi' },
  { id: 'yields', label: 'Yields' },
  { id: 'predictions', label: 'Predictions' },
  { id: 'trending', label: 'Trending' },
  { id: 'github', label: 'GitHub' },
];

export const MARKET_SECTIONS_ORDER: MarketSectionId[] = [
  'crypto',
  'defi',
  'yields',
  'predictions',
  'trending',
  'github',
];
