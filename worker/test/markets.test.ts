import { describe, expect, test } from 'bun:test';
import { fmtIsoDate, fmtPct, fmtPrice, fmtUsd } from '../src/lib/format';
import { HAN_RE } from '../src/normalize/i18n';
import {
  fetchCryptoSection,
  fetchGithubSection,
  normalizeDefiProtocols,
  normalizeDefiYields,
  normalizePredictionRows,
  normalizeTrendingRows,
} from '../src/sources/markets';
import { FORBIDDEN_CJK_RE } from './helpers';

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

  test('defi protocols expose deduplicated chains[], yields expose pool hrefs, and unsafe URLs/CJK are sanitized', async () => {
    const defi = normalizeDefiProtocols(
      [
        {
          id: '协议1',
          name: 'ProtoX',
          category: 'DEX',
          tvl: 50_000_000,
          chains: ['Ethereum', 'Base 链', 'Ethereum', 'Arbitrum'],
          url: 'https://good.com@evil.com/phish',
        },
        {
          slug: 'safe-proto',
          name: 'SafeProto',
          category: 'Lending',
          tvl: 10_000_000,
          chain: 'Solana 链',
          url: 'https://safe.example.com/app',
        },
      ],
      1_700_000_000_000,
    );
    expect(defi.rows[0].chains).toEqual(['Ethereum', 'Base', 'Arbitrum']);
    expect(defi.rows[0].chain).toBe('Ethereum');
    expect(defi.rows[0].href).toBeUndefined();
    expect(defi.rows[1].chains).toEqual(['Solana']);
    expect(defi.rows[1].href).toBe('https://safe.example.com/app');
    expect(FORBIDDEN_CJK_RE.test(JSON.stringify(defi))).toBe(false);

    const yields = normalizeDefiYields(
      {
        data: [
          { pool: 'pool/123 abc', symbol: 'ETH', project: 'lido', chain: 'Arbitrum 链', tvlUsd: 5_000_000, apy: 4.1, ilRisk: 'no' },
          { symbol: 'DAI', project: 'maker', chain: 'Base', tvlUsd: 2_000_000, apy: 3.0, ilRisk: 'no' },
        ],
      },
      1_700_000_000_000,
    );
    expect(yields.rows[0].href).toBe('https://defillama.com/yields/pool/pool%2F123%20abc');
    expect(yields.rows[0].chain).toBe('Arbitrum');
    expect(yields.rows[1].href).toBeUndefined();
    expect(FORBIDDEN_CJK_RE.test(JSON.stringify(yields))).toBe(false);

    const trending = normalizeTrendingRows([
      {
        chainId: 'solana 链',
        tokenAddress: '0x1234567890abcdef',
        totalAmount: 10,
        description: 'Line1\n\tLine2   extra   spaces   that   push   past   42 chars',
        url: 'javascript:alert(1)',
        links: [
          { url: 'https://good.com@evil.com/x' },
          { url: 'https://valid.example.com /badspace' },
          { url: 'https://project.example.com/info' },
        ],
      },
    ]);
    expect(trending[0].cells[0]).not.toMatch(/[\n\t]/);
    expect(trending[0].cells[0]).toBe('0x1234…cdef · Line1 Line2 extra spaces that push past 42');
    expect(trending[0].href).toBeUndefined();
    expect(trending[0].cells[3]).toBe('https://project.example.com/info');
    expect(FORBIDDEN_CJK_RE.test(JSON.stringify(trending))).toBe(false);

    const pred = normalizePredictionRows([
      { slug: 'low', question: 'Low?', outcomePrices: '["0.002","0.998"]' },
      { slug: 'high', question: 'High?', outcomePrices: '["0.998","0.002"]' },
      { slug: 'zero', question: 'Zero?', outcomePrices: '["0","1"]' },
      { slug: 'one', question: 'One?', outcomePrices: '["1","0"]' },
      { slug: 'edge', question: 'Edge?', outcomePrices: '["0.005","0.995"]' },
    ]);
    expect(pred.map(r => r.cells[1])).toEqual(['<1%', '>99%', '0%', '100%', '1%']);
  });

  test('fetchCryptoSection uses CoinGecko -> CoinPaprika -> Binance fallback chain, usdSort anchors, CJK strip, and body cancel', async () => {
    const prevFetch = globalThis.fetch;
    const prevWarn = console.warn;
    const warns: unknown[][] = [];
    console.warn = (...args: unknown[]) => warns.push(args);

    const makeCancelledResp = (status: number) => {
      let cancelled = false;
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('err'));
          c.close();
        },
        cancel() {
          cancelled = true;
        },
      });
      return { res: new Response(stream, { status }), wasCancelled: () => cancelled };
    };

    try {
      // 1. Primary CoinGecko: zero volume/price/mcap becomes null sort anchor (mirroring em dash) & CJK stripped.
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const u = String(input);
        if (u.includes('cg-markets')) {
          return new Response(
            JSON.stringify([
              {
                id: 'btc-币',
                symbol: 'btc币',
                name: 'Bitcoin 比特',
                current_price: 0,
                market_cap: 1_000_000_000,
                total_volume: 0,
                price_change_percentage_24h: 2.5,
              },
            ]),
            { status: 200 },
          );
        }
        if (u.includes('cg-cats')) {
          return new Response(
            JSON.stringify([{ id: 'cat-分类', name: '分类', market_cap: 50_000_000, market_cap_change_24h: 1.2 }]),
            { status: 200 },
          );
        }
        return new Response('[]', { status: 404 });
      }) as unknown as typeof fetch;

      const cgRes = await fetchCryptoSection(1_700_000_000_000, {
        coingeckoMarkets: 'https://mock.test/cg-markets',
        coingeckoCategories: 'https://mock.test/cg-cats',
      });
      expect(cgRes.section.source).toBe('CoinGecko');
      expect(cgRes.section.rows[0].sortValues).toEqual(['Bitcoin (BTC)', null, 2.5, null, 1_000_000_000]);
      expect(FORBIDDEN_CJK_RE.test(JSON.stringify(cgRes))).toBe(false);

      // 2. CoinGecko fails -> logs warning and falls back to CoinPaprika sorted by market cap DESC.
      const cgFail = makeCancelledResp(429);
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const u = String(input);
        if (u.includes('cg-markets')) return cgFail.res;
        if (u.includes('paprika')) {
          return new Response(
            JSON.stringify([
              {
                id: 'eth-ethereum',
                name: 'Ethereum',
                symbol: 'ETH',
                rank: 2,
                quotes: { USD: { price: 3000, volume_24h: 0, market_cap: 360_000_000_000, percent_change_24h: -1.5 } },
              },
              {
                id: 'btc-bitcoin',
                name: 'Bitcoin 币',
                symbol: 'BTC',
                rank: 1,
                quotes: { USD: { price: 90000, volume_24h: 25_000_000_000, market_cap: 1_800_000_000_000, percent_change_24h: 3.2 } },
              },
            ]),
            { status: 200 },
          );
        }
        return new Response('nope', { status: 500 });
      }) as unknown as typeof fetch;

      const cpRes = await fetchCryptoSection(1_700_000_000_000, {
        coingeckoMarkets: 'https://mock.test/cg-markets',
        coinpaprikaTickers: 'https://mock.test/paprika',
        binanceTickers: 'https://mock.test/binance',
      });
      expect(cgFail.wasCancelled()).toBe(true);
      expect(warns.some(w => String(w[0]).includes('markets:crypto primary failed'))).toBe(true);
      expect(cpRes.section.source).toBe('CoinPaprika');
      expect(cpRes.section.rows.map(r => r.id)).toEqual(['btc-bitcoin', 'eth-ethereum']);
      expect(cpRes.section.rows[1].sortValues).toEqual(['Ethereum (ETH)', 3000, -1.5, null, 360_000_000_000]);
      expect(FORBIDDEN_CJK_RE.test(JSON.stringify(cpRes))).toBe(false);

      // 3. CoinGecko + CoinPaprika fail -> falls back to Binance Vision.
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const u = String(input);
        if (u.includes('binance')) {
          return new Response(
            JSON.stringify([
              { symbol: 'SOLUSDT', lastPrice: '0', priceChangePercent: '4.2', quoteVolume: '500000000' },
            ]),
            { status: 200 },
          );
        }
        return new Response('down', { status: 503 });
      }) as unknown as typeof fetch;

      const binRes = await fetchCryptoSection(1_700_000_000_000, {
        coingeckoMarkets: 'https://mock.test/cg-markets',
        coinpaprikaTickers: 'https://mock.test/paprika',
        binanceTickers: 'https://mock.test/binance',
      });
      expect(binRes.section.source).toBe('Binance Vision');
      expect(binRes.section.rows[0].sortValues).toEqual(['SOL', null, 4.2, 500_000_000, 'SOL/USDT']);

      // 4. All 3 fail -> error summarizes all providers.
      globalThis.fetch = (async () => new Response('blocked', { status: 403 })) as unknown as typeof fetch;
      await expect(
        fetchCryptoSection(1_700_000_000_000, {
          coingeckoMarkets: 'https://mock.test/cg-markets',
          coinpaprikaTickers: 'https://mock.test/paprika',
          binanceTickers: 'https://mock.test/binance',
        }),
      ).rejects.toThrow(/CoinGecko.*CoinPaprika.*Binance/);

      // 5. GitHub section strips CJK from id/full_name and rejects unsafe html_url.
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            items: [
              {
                full_name: 'user/空投-tool',
                language: 'TypeScript',
                stargazers_count: 15,
                pushed_at: '2026-11-20T00:00:00Z',
                html_url: 'https://good.com@evil.com/repo',
              },
            ],
          }),
          { status: 200 },
        )) as unknown as typeof fetch;
      const gh = await fetchGithubSection(1_700_000_000_000, { github: 'https://mock.test/gh' });
      expect(gh.rows[0].href).toBeUndefined();
      expect(FORBIDDEN_CJK_RE.test(JSON.stringify(gh))).toBe(false);
    } finally {
      globalThis.fetch = prevFetch;
      console.warn = prevWarn;
    }
  });
});

