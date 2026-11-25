import { describe, expect, test } from 'bun:test';
import type { MarketRow } from '../../shared/types';
import {
  classifyDeltaCell,
  detectNumericColumns,
  extractYieldPoolTicker,
  formatDeltaCell,
  formatProtocolSlugLabel,
  getLanguageVisual,
  parseChainCell,
  parseTrendingEntityCell,
  resolveColumnKind,
  resolveEntityCellMeta,
  splitEntityLabel,
  splitGithubRepo,
} from './marketTable';

function row(cells: string[], sortValues?: (string | number | null)[]): MarketRow {
  return sortValues ? { cells, sortValues } : { cells };
}

describe('detectNumericColumns', () => {
  test('always marks column 0 as non-numeric even when values are numbers', () => {
    const cols = ['#', 'Price', '24h'];
    const rows: MarketRow[] = [
      row(['1', '$100.00', '+2.4%'], [1, 100, 2.4]),
      row(['2', '$50.00', '-1.2%'], [2, 50, -1.2]),
    ];
    expect(detectNumericColumns(cols, rows)).toEqual([false, true, true]);
  });

  test('uses sortValues anchors first for CoinGecko and Binance crypto tables', () => {
    const cgCols = ['Coin', 'Price', '24h', '24h volume', 'Market cap'];
    const cgRows: MarketRow[] = [
      row(['Bitcoin (BTC)', '$65,432.10', '+2.45%', '$28.40B', '$1.28T'], ['Bitcoin (BTC)', 65432.1, 2.45, 2.84e10, 1.28e12]),
      row(['Ethereum (ETH)', '$3,410.00', '-0.85%', '$14.20B', '$410.00B'], ['Ethereum (ETH)', 3410, -0.85, 1.42e10, 4.1e11]),
    ];
    expect(detectNumericColumns(cgCols, cgRows)).toEqual([false, true, true, true, true]);

    const binanceCols = ['Coin', 'Price', '24h', '24h volume', 'Pair'];
    const binanceRows: MarketRow[] = [
      row(['BTC', '$65,432.10', '+2.45%', '$28.40B', 'BTC/USDT'], ['BTC', 65432.1, 2.45, 2.84e10, 'BTC/USDT']),
    ];
    expect(detectNumericColumns(binanceCols, binanceRows)).toEqual([false, true, true, true, false]);
  });

  test('detects numeric columns when some rows have null sortValues', () => {
    const cols = ['Token', 'Chain', 'Boosts', 'Links'];
    const rows: MarketRow[] = [
      row(['0x1234...abcd', 'Solana', 'Profile', 'https://dexscreener.com'], ['0x1234...abcd', 'Solana', null, 'https://dexscreener.com']),
      row(['0x5678...efgh', 'Base', '1,250', 'https://example.com'], ['0x5678...efgh', 'Base', 1250, 'https://example.com']),
      row(['0x9999...1111', 'Solana', 'Profile', '—'], ['0x9999...1111', 'Solana', null, null]),
    ];
    expect(detectNumericColumns(cols, rows)).toEqual([false, false, true, false]);
  });

  test('falls back to display cell heuristics when sortValues are absent (legacy payloads)', () => {
    const cols = ['Protocol', 'Category', 'Rank', 'TVL', '1d', 'Website'];
    const rows: MarketRow[] = [
      row(['Lido', 'Liquid Staking', '#1', '$24.5B', '+1.4%', 'https://lido.fi']),
      row(['Aave', 'Lending', '#2', '$18.2B', '-0.6%', 'https://aave.com']),
      row(['EigenLayer', 'Restaking', '#3', '—', '0.00%', 'https://eigenlayer.xyz']),
    ];
    expect(detectNumericColumns(cols, rows)).toEqual([false, false, true, true, true, false]);
  });

  test('falls back to cell heuristics when all sortValues in a column are null', () => {
    const cols = ['Market', 'Yes %', 'Notes'];
    const rows: MarketRow[] = [
      row(['Will ETH reach $5k?', '64%', 'Active'], ['Will ETH reach $5k?', null, null]),
      row(['Will BTC reach $150k?', '41%', 'Open'], ['Will BTC reach $150k?', null, null]),
    ];
    expect(detectNumericColumns(cols, rows)).toEqual([false, true, false]);
  });

  test('returns all false for empty rows and empty array for empty cols', () => {
    expect(detectNumericColumns(['Coin', 'Price', '24h'], [])).toEqual([false, false, false]);
    expect(detectNumericColumns([], [])).toEqual([]);
  });

  test('ignores placeholder dashes and TBA cells during fallback', () => {
    const cols = ['Pool', 'TVL', 'Status'];
    const rows: MarketRow[] = [
      row(['USDC-ETH', '—', '—']),
      row(['WBTC-ETH', 'TBA', 'N/A']),
      row(['SOL-USDC', '$12.4M', 'Active']),
    ];
    expect(detectNumericColumns(cols, rows)).toEqual([false, true, false]);
  });
});

describe('classifyDeltaCell', () => {
  test('classifies positive signed percentages and signed dollar/number deltas as up', () => {
    expect(classifyDeltaCell('+2.4%')).toEqual({ tone: 'up', isPercentOrSigned: true });
    expect(classifyDeltaCell(' +12.50% ')).toEqual({ tone: 'up', isPercentOrSigned: true });
    expect(classifyDeltaCell('+$1.2M')).toEqual({ tone: 'up', isPercentOrSigned: true });
    expect(classifyDeltaCell('+$400')).toEqual({ tone: 'up', isPercentOrSigned: true });
    expect(classifyDeltaCell('+1,250')).toEqual({ tone: 'up', isPercentOrSigned: true });
    expect(classifyDeltaCell('▲ 3.5%')).toEqual({ tone: 'up', isPercentOrSigned: true });
  });

  test('classifies negative signed percentages and signed dollar/number deltas as down', () => {
    expect(classifyDeltaCell('-1.5%')).toEqual({ tone: 'down', isPercentOrSigned: true });
    expect(classifyDeltaCell('-$400')).toEqual({ tone: 'down', isPercentOrSigned: true });
    expect(classifyDeltaCell('-$1.2M')).toEqual({ tone: 'down', isPercentOrSigned: true });
    expect(classifyDeltaCell('-42')).toEqual({ tone: 'down', isPercentOrSigned: true });
    expect(classifyDeltaCell('\u22123.25%')).toEqual({ tone: 'down', isPercentOrSigned: true });
    expect(classifyDeltaCell('▼ 2.1%')).toEqual({ tone: 'down', isPercentOrSigned: true });
  });

  test('classifies zero signed deltas and unsigned percentages as neutral with isPercentOrSigned true', () => {
    expect(classifyDeltaCell('+0.00%')).toEqual({ tone: 'neutral', isPercentOrSigned: true });
    expect(classifyDeltaCell('-0.00%')).toEqual({ tone: 'neutral', isPercentOrSigned: true });
    expect(classifyDeltaCell('0.00%')).toEqual({ tone: 'neutral', isPercentOrSigned: true });
    expect(classifyDeltaCell('64%')).toEqual({ tone: 'neutral', isPercentOrSigned: true });
    expect(classifyDeltaCell('12.45%')).toEqual({ tone: 'neutral', isPercentOrSigned: true });
    expect(classifyDeltaCell('+$0')).toEqual({ tone: 'neutral', isPercentOrSigned: true });
    expect(classifyDeltaCell('-$0')).toEqual({ tone: 'neutral', isPercentOrSigned: true });
  });

  test('keeps plain currency prices, volumes, integers, dates, and labels neutral and non-delta', () => {
    expect(classifyDeltaCell('$65,432.10')).toEqual({ tone: 'neutral', isPercentOrSigned: false });
    expect(classifyDeltaCell('$1.28T')).toEqual({ tone: 'neutral', isPercentOrSigned: false });
    expect(classifyDeltaCell('$0.0042')).toEqual({ tone: 'neutral', isPercentOrSigned: false });
    expect(classifyDeltaCell('1,420')).toEqual({ tone: 'neutral', isPercentOrSigned: false });
    expect(classifyDeltaCell('2026-12-31')).toEqual({ tone: 'neutral', isPercentOrSigned: false });
    expect(classifyDeltaCell('Ethereum')).toEqual({ tone: 'neutral', isPercentOrSigned: false });
    expect(classifyDeltaCell('Multi-Chain')).toEqual({ tone: 'neutral', isPercentOrSigned: false });
    expect(classifyDeltaCell('—')).toEqual({ tone: 'neutral', isPercentOrSigned: false });
    expect(classifyDeltaCell('-')).toEqual({ tone: 'neutral', isPercentOrSigned: false });
    expect(classifyDeltaCell('')).toEqual({ tone: 'neutral', isPercentOrSigned: false });
  });

  test('rejects non-numeric text starting with signs or containing percent', () => {
    expect(classifyDeltaCell('-foo')).toEqual({ tone: 'neutral', isPercentOrSigned: false });
    expect(classifyDeltaCell('+10% bonus')).toEqual({ tone: 'neutral', isPercentOrSigned: false });
    expect(classifyDeltaCell('-2026-01-01')).toEqual({ tone: 'neutral', isPercentOrSigned: false });
    expect(classifyDeltaCell('100% legit')).toEqual({ tone: 'neutral', isPercentOrSigned: false });
  });
});

describe('formatDeltaCell', () => {
  test('normalizes signed zero percentages from live worker payloads', () => {
    expect(formatDeltaCell('-0.00%')).toBe('0.00%');
    expect(formatDeltaCell('+0.00%')).toBe('0.00%');
    expect(formatDeltaCell('\u22120.00%')).toBe('0.00%');
    expect(formatDeltaCell('-0%')).toBe('0%');
    expect(formatDeltaCell(' -0.0% ')).toBe('0.0%');
  });

  test('preserves non-zero deltas and plain values unchanged', () => {
    expect(formatDeltaCell('+4.61%')).toBe('+4.61%');
    expect(formatDeltaCell('-0.02%')).toBe('-0.02%');
    expect(formatDeltaCell('0.00%')).toBe('0.00%');
    expect(formatDeltaCell('$59,183')).toBe('$59,183');
    expect(formatDeltaCell('—')).toBe('—');
  });
});

describe('splitEntityLabel', () => {
  test('extracts CoinGecko and CoinPaprika names and tickers including 1-letter and nested parens', () => {
    expect(splitEntityLabel('Bitcoin (BTC)', 'crypto')).toEqual({ name: 'Bitcoin', ticker: 'BTC' });
    expect(splitEntityLabel('MemeCore (M)', 'crypto')).toEqual({ name: 'MemeCore', ticker: 'M' });
    expect(splitEntityLabel('United Stables (U)', 'crypto')).toEqual({ name: 'United Stables', ticker: 'U' });
    expect(splitEntityLabel('Spiko Amundi Overnight Swap Fund (EUR) (EURSAFO)', 'crypto')).toEqual({
      name: 'Spiko Amundi Overnight Swap Fund (EUR)',
      ticker: 'EURSAFO',
    });
    expect(splitEntityLabel('BNB (BNB)', 'crypto')).toEqual({ name: 'BNB', ticker: 'BNB' });
  });

  test('handles Binance Vision bare ticker format on crypto section', () => {
    expect(splitEntityLabel('BTC', 'crypto')).toEqual({ name: 'Bitcoin', ticker: 'BTC' });
    expect(splitEntityLabel('ETH', 'crypto')).toEqual({ name: 'Ethereum', ticker: 'ETH' });
    expect(splitEntityLabel('CUSTOMTOKEN', 'crypto')).toEqual({ name: 'CUSTOMTOKEN', ticker: 'CUSTOMTOKEN' });
  });

  test('does not treat version or currency qualifiers as tickers', () => {
    expect(splitEntityLabel('Uniswap (V3)', 'defi')).toEqual({ name: 'Uniswap (V3)', ticker: null });
    expect(splitEntityLabel('Fund (EUR)', 'defi')).toEqual({ name: 'Fund (EUR)', ticker: null });
    expect(splitEntityLabel('LayerZero V2', 'defi')).toEqual({ name: 'LayerZero V2', ticker: null });
  });
});

describe('extractYieldPoolTicker', () => {
  test('extracts primary token ticker from single-asset and multi-asset pool symbols', () => {
    expect(extractYieldPoolTicker('STETH')).toBe('STETH');
    expect(extractYieldPoolTicker('WBETH')).toBe('WBETH');
    expect(extractYieldPoolTicker('USDC-ETH')).toBe('USDC');
    expect(extractYieldPoolTicker('WETH/USDT')).toBe('WETH');
    expect(extractYieldPoolTicker('GROVE-STEAKUSDC')).toBe('GROVE');
    expect(extractYieldPoolTicker('   ')).toBeNull();
  });
});

describe('formatProtocolSlugLabel', () => {
  test('formats DefiLlama raw lowercase protocol slugs into readable brand names', () => {
    expect(formatProtocolSlugLabel('lido')).toBe('Lido');
    expect(formatProtocolSlugLabel('binance-staked-eth')).toBe('Binance Staked ETH');
    expect(formatProtocolSlugLabel('ether.fi-stake')).toBe('Ether.fi Stake');
    expect(formatProtocolSlugLabel('aave-v3')).toBe('Aave V3');
    expect(formatProtocolSlugLabel('morpho-blue')).toBe('Morpho Blue');
    expect(formatProtocolSlugLabel('sparklend')).toBe('SparkLend');
    expect(formatProtocolSlugLabel('ethena-usde')).toBe('Ethena USDe');
    expect(formatProtocolSlugLabel('blackrock-buidl')).toBe('BlackRock BUIDL');
    expect(formatProtocolSlugLabel('ondo-yield-assets')).toBe('Ondo Yield Assets');
    expect(formatProtocolSlugLabel('justlend-v1')).toBe('JustLend V1');
    expect(formatProtocolSlugLabel('kinetiq-khype')).toBe('Kinetiq kHYPE');
    expect(formatProtocolSlugLabel('meth-protocol')).toBe('mETH Protocol');
    expect(formatProtocolSlugLabel('usual-usd0')).toBe('Usual USD0');
    expect(formatProtocolSlugLabel('circle-usyc')).toBe('Circle USYC');
    expect(formatProtocolSlugLabel('invesco-ustb')).toBe('Invesco USTB');
    expect(formatProtocolSlugLabel('binance-staked-sol')).toBe('Binance Staked SOL');
    expect(formatProtocolSlugLabel('usd-ai')).toBe('USD AI');
  });

  test('preserves already formatted names and handles empty/placeholders', () => {
    expect(formatProtocolSlugLabel('Aave V3')).toBe('Aave V3');
    expect(formatProtocolSlugLabel('LayerZero V2')).toBe('LayerZero V2');
    expect(formatProtocolSlugLabel('—')).toBe('—');
    expect(formatProtocolSlugLabel('')).toBe('—');
  });
});

describe('parseTrendingEntityCell', () => {
  test('splits short address and strips live-worker 42-char mid-word stubs and dangling connectors', () => {
    expect(parseTrendingEntityCell('npz2Fh…pump · The meme comes from Block’s Dessa announce')).toEqual({
      shortAddr: 'npz2Fh…pump',
      description: 'The meme comes from Block’s Dessa…',
      ticker: null,
    });
    expect(parseTrendingEntityCell('3N6Mp8…pump · A frog, a stone ₿, and a mountain with no ')).toEqual({
      shortAddr: '3N6Mp8…pump',
      description: 'A frog, a stone ₿, and a mountain…',
      ticker: null,
    });
    expect(parseTrendingEntityCell('DtcicP…pump · Someone asked AI to build a game the entir')).toEqual({
      shortAddr: 'DtcicP…pump',
      description: 'Someone asked AI to build a game…',
      ticker: null,
    });
    expect(parseTrendingEntityCell('FVzqGq…pump · Horse doge on Solana, paired to USDC becau')).toEqual({
      shortAddr: 'FVzqGq…pump',
      description: 'Horse doge on Solana, paired to USDC…',
      ticker: null,
    });
    expect(parseTrendingEntityCell('6NPRWp…pump · $LALA is the meme token of Tequi-la-la, an')).toEqual({
      shortAddr: '6NPRWp…pump',
      description: '$LALA is the meme token of Tequi-la-la…',
      ticker: 'LALA',
    });
    expect(parseTrendingEntityCell('DTvEhH…Q4fy · Grand Theft Lotto ($GTL) is a lottery prot')).toEqual({
      shortAddr: 'DTvEhH…Q4fy',
      description: 'Grand Theft Lotto ($GTL) is a lottery…',
      ticker: 'GTL',
    });
    expect(parseTrendingEntityCell('FJKt1L…pump · Maya The Samoyed - $MAYA Born in Germany. ')).toEqual({
      shortAddr: 'FJKt1L…pump',
      description: 'Maya The Samoyed - $MAYA Born in Germany.',
      ticker: 'MAYA',
    });
    expect(parseTrendingEntityCell('0x493D…bBA1 · I am my penguin and my penguin is me. · *R')).toEqual({
      shortAddr: '0x493D…bBA1',
      description: 'I am my penguin and my penguin is me.',
      ticker: null,
    });
    expect(parseTrendingEntityCell('0x493D…bBA1 · I am my penguin and my penguin is me. ·…')).toEqual({
      shortAddr: '0x493D…bBA1',
      description: 'I am my penguin and my penguin is me.',
      ticker: null,
    });
    expect(parseTrendingEntityCell('5yK1F7…pump · The goat variant of Doge on Solana. CTO by')).toEqual({
      shortAddr: '5yK1F7…pump',
      description: 'The goat variant of Doge on Solana.',
      ticker: null,
    });
    expect(parseTrendingEntityCell('HsprHx…pump · The most anticipated game in history. One ')).toEqual({
      shortAddr: 'HsprHx…pump',
      description: 'The most anticipated game in history.',
      ticker: null,
    });
    expect(parseTrendingEntityCell('0x1234…abcd · Build fast swaps on Base • | *…')).toEqual({
      shortAddr: '0x1234…abcd',
      description: 'Build fast swaps on Base…',
      ticker: null,
    });
  });

  test('handles address-only rows, clean short descriptions, newlines, and new-worker 96-char descriptions', () => {
    expect(parseTrendingEntityCell('GteMEC…pump')).toEqual({
      shortAddr: 'GteMEC…pump',
      description: null,
      ticker: null,
    });
    expect(parseTrendingEntityCell('EwUVBp…pump · The official Christmas coin for @Pumpfun')).toEqual({
      shortAddr: 'EwUVBp…pump',
      description: 'The official Christmas coin for @Pumpfun',
      ticker: null,
    });
    expect(parseTrendingEntityCell('TiMSdJ…JXNw · return to tradition\n\nOG Raydium launch.')).toEqual({
      shortAddr: 'TiMSdJ…JXNw',
      description: 'return to tradition OG Raydium launch.',
      ticker: null,
    });
    expect(
      parseTrendingEntityCell(
        '0xAA1f…CdB1 · Corbel is the all-in-one liquidity routing app built for fast swaps across chains…',
      ),
    ).toEqual({
      shortAddr: '0xAA1f…CdB1',
      description: 'Corbel is the all-in-one liquidity routing app built for fast swaps across chains…',
      ticker: null,
    });
  });
});

describe('parseChainCell', () => {
  test('parses single chains, multi-chain cells with overflow count, and multi-word chain names', () => {
    expect(parseChainCell('Ethereum')).toEqual({ chains: ['Ethereum'], overflow: null });
    expect(parseChainCell('Polygon, Ethereum +89')).toEqual({
      chains: ['Polygon', 'Ethereum'],
      overflow: '+89',
    });
    expect(parseChainCell('Ethereum, Robinhood Chain +21')).toEqual({
      chains: ['Ethereum', 'Robinhood Chain'],
      overflow: '+21',
    });
    expect(parseChainCell('Hyperliquid L1, Arbitrum')).toEqual({
      chains: ['Hyperliquid L1', 'Arbitrum'],
      overflow: null,
    });
    expect(parseChainCell('—')).toEqual({ chains: [], overflow: null });
    expect(parseChainCell('')).toEqual({ chains: [], overflow: null });
  });
});

describe('splitGithubRepo', () => {
  test('splits valid owner/repo strings and rejects non-repo strings', () => {
    expect(splitGithubRepo('swcstudiospace/PumpGrok')).toEqual({
      owner: 'swcstudiospace',
      repo: 'PumpGrok',
    });
    expect(splitGithubRepo('plain-label')).toBeNull();
    expect(splitGithubRepo('a/b/c')).toBeNull();
  });
});

describe('getLanguageVisual', () => {
  test('returns canonical linguist colors for known languages and neutral fallback for unknown', () => {
    expect(getLanguageVisual('TypeScript')).toEqual({ label: 'TypeScript', color: '#3178C6', isUnknown: false });
    expect(getLanguageVisual('Solidity')).toEqual({ label: 'Solidity', color: '#AA6746', isUnknown: false });
    expect(getLanguageVisual('Python')).toEqual({ label: 'Python', color: '#3572A5', isUnknown: false });
    expect(getLanguageVisual('Unknown').isUnknown).toBe(true);
    expect(getLanguageVisual('').isUnknown).toBe(true);
  });
});

describe('resolveColumnKind', () => {
  test('maps section columns to semantic rendering kinds', () => {
    expect(resolveColumnKind('crypto', 'Coin', 0)).toBe('entity');
    expect(resolveColumnKind('defi', 'Chains', 2)).toBe('chain');
    expect(resolveColumnKind('yields', 'Project', 1)).toBe('project');
    expect(resolveColumnKind('yields', 'Chain', 2)).toBe('chain');
    expect(resolveColumnKind('yields', 'IL risk', 5)).toBe('ilRisk');
    expect(resolveColumnKind('trending', 'Chain', 1)).toBe('chain');
    expect(resolveColumnKind('github', 'Language', 1)).toBe('language');
    expect(resolveColumnKind('crypto', 'Price', 1)).toBe('data');
  });
});

describe('resolveEntityCellMeta', () => {
  test('resolves avatar shape, ticker, protocolSlug, and github owner/repo per section', () => {
    expect(resolveEntityCellMeta(row(['Bitcoin (BTC)']), 'crypto')).toEqual({
      rawCell: 'Bitcoin (BTC)',
      displayName: 'Bitcoin',
      displayTicker: 'BTC',
      avatarTicker: 'BTC',
      protocolSlug: null,
      repoParts: null,
      avatarShape: 'circle',
    });
    expect(resolveEntityCellMeta(row(['WEETH', 'aave-v3']), 'yields')).toEqual({
      rawCell: 'WEETH',
      displayName: 'WEETH',
      displayTicker: null,
      avatarTicker: 'WEETH',
      protocolSlug: 'aave-v3',
      repoParts: null,
      avatarShape: 'rounded',
    });
    expect(resolveEntityCellMeta({ id: 'aave-v3', cells: ['Aave V3'] }, 'defi')).toEqual({
      rawCell: 'Aave V3',
      displayName: 'Aave V3',
      displayTicker: null,
      avatarTicker: null,
      protocolSlug: 'aave-v3',
      repoParts: null,
      avatarShape: 'rounded',
    });
    expect(resolveEntityCellMeta(row(['swcstudiospace/PumpGrok']), 'github')).toEqual({
      rawCell: 'swcstudiospace/PumpGrok',
      displayName: 'swcstudiospace/PumpGrok',
      displayTicker: null,
      avatarTicker: null,
      protocolSlug: null,
      repoParts: { owner: 'swcstudiospace', repo: 'PumpGrok' },
      avatarShape: 'circle',
    });
  });
});
