import { describe, expect, test } from 'bun:test';
import type { MarketRow } from '../../shared/types';
import { classifyDeltaCell, detectNumericColumns } from './marketTable';

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
