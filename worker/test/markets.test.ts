import { describe, expect, test } from 'bun:test';
import { fmtIsoDate, fmtPct, fmtPrice, fmtUsd } from '../src/lib/format';
import { HAN_RE } from '../src/normalize/i18n';
import { normalizeDefiProtocols, normalizeDefiYields, normalizePredictionRows, normalizeTrendingRows } from '../src/sources/markets';

describe('market formatters and normalizers', () => {
  test('formats numbers strictly in English without CJK or arrows', () => {
    expect(fmtUsd(1_234_000_000)).toBe('$1.23B');
    expect(fmtUsd(45_200_000)).toBe('$45.20M');
    expect(fmtUsd(12_400)).toBe('$12K');
    expect(fmtPrice(0.0042)).toBe('$0.0042');
    expect(fmtPct(4.216)).toBe('+4.22%');
    expect(fmtPct(-1.8)).toBe('-1.80%');
    expect(fmtIsoDate('2026-11-21T00:00:00Z')).toBe('2026-11-21');
  });

  test('normalizes DefiLlama protocols excluding CEX and sorting by TVL', () => {
    const raw = [
      { name: 'Binance CEX', category: 'CEX', tvl: 1e11, chains: ['Ethereum'] },
      { name: 'Lido', category: 'Liquid Staking', tvl: 20_000_000_000, chains: ['Ethereum'], change_1d: 1.5, change_7d: -2.1, url: 'https://lido.fi' },
      // Han-character name exercises stripOrTranslateCjk (Latin remainder kept).
      { name: 'Aave 借贷', category: 'Lending', tvl: 25_000_000_000, chains: ['Ethereum', 'Arbitrum', 'Base'], change_1d: 2.3, change_7d: 5.0, url: 'https://aave.com' },
    ];
    const sec = normalizeDefiProtocols(raw, 1_700_000_000_000);
    expect(sec.id).toBe('defi');
    expect(sec.rows.length).toBe(2);
    expect(sec.rows[0].cells[0]).toBe('Aave'); // Han stripped, Latin remainder kept
    expect(sec.rows[0].cells[3]).toBe('$25.00B');
    expect(sec.rows[1].cells[0]).toBe('Lido');
    expect(HAN_RE.test(JSON.stringify(sec))).toBe(false);
  });

  test('normalizes DefiLlama yields filtering TVL > $1M', () => {
    const raw = {
      data: [
        { symbol: 'TINY', project: 'tiny', chain: 'Base', tvlUsd: 500_000, apy: 99, ilRisk: 'yes' },
        { symbol: 'USDC', project: 'aave-v3', chain: 'Arbitrum', tvlUsd: 120_000_000, apy: 6.5, ilRisk: 'no' },
      ],
    };
    const sec = normalizeDefiYields(raw, 1_700_000_000_000);
    expect(sec.rows.length).toBe(1);
    expect(sec.rows[0].cells).toEqual(['USDC', 'aave-v3', 'Arbitrum', '$120.00M', '6.50%', 'No']);
  });
});

describe('market row sort contract', () => {
  test('yields rows carry raw anchors and stable ids including IL-risk transition', () => {
    const sec = normalizeDefiYields(
      {
        data: [
          { pool: 'uuid-c', symbol: 'USDC', project: 'aave-v3', chain: 'Arbitrum', tvlUsd: 120_000_000, apy: 6.5, ilRisk: 'no' },
          { pool: 'uuid-s', symbol: 'STETH', project: 'lido', chain: 'Ethereum', tvlUsd: 15_240_000_000, apy: null, ilRisk: 'yes' },
        ],
      },
      1_700_000_000_000,
    );
    const steth = sec.rows[0];
    expect(steth.id).toBe('uuid-s');
    expect(steth.cells[4]).toBe('—');
    expect(steth.cells[5]).toBe('Yes');
    expect(steth.sortValues).toEqual(['STETH', 'lido', 'Ethereum', 15_240_000_000, null, 1]);
    const usdc = sec.rows[1];
    expect(usdc.id).toBe('uuid-c');
    expect(usdc.sortValues).toEqual(['USDC', 'aave-v3', 'Arbitrum', 120_000_000, 6.5, 0]);
  });

  test('DeFi rows carry exact signed 1d/7d percentages and raw TVL', () => {
    const sec = normalizeDefiProtocols(
      [{ id: 42, slug: 'lido', name: 'Lido', category: 'Liquid Staking', tvl: 15_260_000_000, chains: ['Ethereum'], change_1d: -9.03125, change_7d: -17.75, url: 'https://lido.fi/' }],
      1_700_000_000_000,
    );
    expect(sec.rows[0].id).toBe('lido');
    expect(sec.rows[0].cells[4]).toBe('-9.03%');
    expect(sec.rows[0].sortValues).toEqual(['Lido', 'Liquid Staking', 'Ethereum', 15_260_000_000, -9.03125, -17.75]);
  });

  test('predictions rows carry stable native ids; null anchors mirror absent display values', () => {
    const rows = normalizePredictionRows([
      {
        slug: 'fed-december-cut',
        conditionId: '0xcond1',
        id: 987,
        question: 'Fed cut?',
        outcomePrices: '["0.75","0.25"]',
        volume24hr: 1_234_567,
        liquidity: 0, // absent: null anchor mirrors fmtUsd's em dash
        endDate: '2026-12-17T00:00:00Z',
      },
      {
        // No slug/conditionId/id/endDate: undefined id, null date anchor.
        question: 'Open-ended market',
        outcomePrices: 'not-json',
      },
    ]);
    expect(rows).toHaveLength(2);
    const fed = rows[0]!; // length asserted above
    const openEnded = rows[1]!;
    expect(fed.cells).toEqual(['Fed cut?', '75%', '$1.23M', '—', '2026-12-17']);
    expect(fed.sortValues).toEqual(['Fed cut?', 0.75, 1_234_567, null, Date.parse('2026-12-17T00:00:00Z')]);
    expect(openEnded.id).toBeUndefined();
    expect(openEnded.cells[1]).toBe('—'); // unparseable outcomePrices renders an em dash
    const openAnchors = openEnded.sortValues ?? [];
    expect(openAnchors[1]).toBeNull();
    expect(openAnchors[4]).toBeNull();
  });

  test('trending rows key on chain:address and null out absent boosts/links', () => {
    const rows = normalizeTrendingRows([
      { chainId: 'ethereum', tokenAddress: '0xABC', totalAmount: 42, url: 'https://dexscreener.com/x' },
      { chainId: 'solana', tokenAddress: 'So1', description: '超 tokens', links: [] },
    ]);
    expect(rows).toHaveLength(2);
    const boosted = rows[0]!;
    const bare = rows[1]!;
    // 9-char address stays un-ellipsized (slice threshold is >10).
    expect(boosted.cells).toEqual(['0xABC', 'Ethereum', '42', 'https://dexscreener.com/x']);
    expect(boosted.sortValues).toEqual(['0xABC', 'Ethereum', 42, 'https://dexscreener.com/x']);
    expect(bare.cells[0]).toBe('So1 · tokens'); // Han stripped from description
    const bareAnchors = bare.sortValues ?? [];
    expect(bareAnchors[2]).toBeNull(); // no boosts
    expect(bareAnchors[3]).toBeNull(); // no link
  });
});

