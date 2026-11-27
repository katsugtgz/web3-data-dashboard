import { describe, expect, test } from 'bun:test';
import {
  buildProjectLogoIndex,
  extractTickerFallback,
  getChainVisual,
  getCryptoVisual,
  getSourceVisual,
  resolveEntityVisual,
  resolveOgPreview,
  sanitizeImageUrl,
} from './visualAssets';

const REQUIRED_CRYPTO_SYMBOLS = [
  'BTC', 'ETH', 'USDT', 'BNB', 'SOL', 'USDC', 'XRP', 'DOGE', 'TRX', 'ADA',
  'STETH', 'WSTETH', 'WBTC', 'AVAX', 'LINK', 'SUI', 'HYPE', 'TON', 'SHIB', 'XLM',
  'HBAR', 'DOT', 'BCH', 'LTC', 'UNI', 'NEAR', 'APT', 'ARB', 'OP', 'POL',
  'MATIC', 'AAVE', 'PEPE', 'ENA', 'USDE', 'DAI', 'TAO', 'ICP', 'ETC', 'XMR',
  'FIL', 'ATOM', 'INJ', 'TIA', 'SEI', 'MNT', 'BERA', 'PENDLE', 'LDO', 'EIGEN',
  'MKR', 'SKY', 'CRV', 'ONDO', 'JUP', 'PYTH', 'WLD', 'RENDER', 'FET', 'ZRO',
  'STRK', 'ZK', 'PAXG', 'XAUT', 'USDS', 'FDUSD', 'PYUSD', 'WBT', 'LEO', 'OKB',
  'BGB', 'CRO', 'KCS', 'PENGU', 'TRUMP',
] as const;

const REQUIRED_CHAINS = [
  'Ethereum', 'Solana', 'Base', 'Arbitrum', 'Optimism', 'BNB', 'Polygon',
  'Avalanche', 'Sui', 'Aptos', 'TON', 'Monad', 'Berachain', 'HyperEVM',
  'Starknet', 'zkSync', 'Linea', 'Scroll', 'Mantle', 'Blast', 'Abstract',
  'Sonic', 'MegaETH', 'Initia', 'Movement', 'Sei', 'Injective', 'Celestia',
  'Bitcoin', 'Multi-Chain',
] as const;

const REQUIRED_SOURCES = [
  'telegram', 'x', 'feed', 'sheet', 'surf', 'CoinGecko', 'CoinPaprika',
  'Binance Vision', 'DefiLlama', 'DefiLlama Yields', 'Polymarket',
  'DexScreener', 'GitHub Search', 'Merkl', 'Pendle', 'AirdropAlert',
  'ASSO7878', 'arndxt',
] as const;

describe('sanitizeImageUrl', () => {
  test('accepts valid https URLs and rejects http, javascript, data, and credentials', () => {
    expect(sanitizeImageUrl('https://images.asksurf.ai/logo.png')).toBe('https://images.asksurf.ai/logo.png');
    expect(sanitizeImageUrl('  https://cdn.example.com/a.webp?w=64  ')).toBe('https://cdn.example.com/a.webp?w=64');
    expect(sanitizeImageUrl('http://insecure.example.com/a.png')).toBeNull();
    expect(sanitizeImageUrl('javascript:alert(1)')).toBeNull();
    expect(sanitizeImageUrl('data:image/svg+xml,<svg/>')).toBeNull();
    expect(sanitizeImageUrl('https://user:pass@example.com/a.png')).toBeNull();
    expect(sanitizeImageUrl('')).toBeNull();
    expect(sanitizeImageUrl(null)).toBeNull();
  });
});

describe('getCryptoVisual', () => {
  test('provides inline vector visuals for all 75+ top crypto symbols', () => {
    for (const sym of REQUIRED_CRYPTO_SYMBOLS) {
      const visual = getCryptoVisual(sym);
      expect(visual, `expected crypto visual for ${sym}`).not.toBeNull();
      expect(visual!.symbol.length).toBeGreaterThan(0);
      expect(visual!.bg).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(visual!.fg).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(visual!.shapes.length).toBeGreaterThan(0);
    }
  });

  test('resolves symbols with $, lowercase, CoinGecko IDs, CoinPaprika IDs, and display labels', () => {
    expect(getCryptoVisual('$btc')?.symbol).toBe('BTC');
    expect(getCryptoVisual('bitcoin')?.symbol).toBe('BTC');
    expect(getCryptoVisual('btc-bitcoin')?.symbol).toBe('BTC');
    expect(getCryptoVisual('Bitcoin (BTC)')?.symbol).toBe('BTC');
    expect(getCryptoVisual('avalanche-2')?.symbol).toBe('AVAX');
    expect(getCryptoVisual('the-open-network')?.symbol).toBe('TON');
    expect(getCryptoVisual('Gram (prev. Toncoin) (GRAM)')?.symbol).toBe('TON');
    expect(getCryptoVisual('ethena-usde')?.symbol).toBe('USDE');
    expect(getCryptoVisual('hedera-hashgraph')?.symbol).toBe('HBAR');
    expect(getCryptoVisual('crypto-com-chain')?.symbol).toBe('CRO');
    expect(getCryptoVisual('sol-solana')?.symbol).toBe('SOL');
    expect(getCryptoVisual('MATIC')?.symbol).toBe('POL');
    expect(getCryptoVisual('zcash')?.symbol).toBe('ZEC');
    expect(getCryptoVisual('WEETH')?.symbol).toBe('WEETH');
    expect(getCryptoVisual('CBBTC')?.symbol).toBe('CBBTC');
    expect(getCryptoVisual('figure-heloc')?.symbol).toBe('FIGR_HELOC');
    expect(getCryptoVisual('rain')?.symbol).toBe('RAIN');
    expect(getCryptoVisual('memecore')?.symbol).toBe('M');
    expect(getCryptoVisual('united-stables')?.symbol).toBe('U');
    expect(getCryptoVisual('spiko-amundi-overnight-swap-fund-eur')?.symbol).toBe('EURSAFO');
  });

  test('returns null for unknown assets without false substring matches', () => {
    expect(getCryptoVisual('')).toBeNull();
    expect(getCryptoVisual(null)).toBeNull();
    expect(getCryptoVisual('Random Unknown Protocol')).toBeNull();
    expect(getCryptoVisual('Operations Center')).toBeNull();
  });
});

describe('getChainVisual', () => {
  test('provides inline vector glyphs and brand colors for all 30+ Web3 chains', () => {
    for (const chain of REQUIRED_CHAINS) {
      const visual = getChainVisual(chain);
      expect(visual, `expected chain visual for ${chain}`).not.toBeNull();
      expect(visual!.label.length).toBeGreaterThan(0);
      expect(visual!.shortLabel.length).toBeGreaterThan(0);
      expect(visual!.color).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(visual!.shapes.length).toBeGreaterThan(0);
    }
  });

  test('normalizes live-snapshot chain aliases cleanly', () => {
    expect(getChainVisual('BSC')?.id).toBe('bnb');
    expect(getChainVisual('Binance')?.id).toBe('bnb');
    expect(getChainVisual('BNB Smart Chain')?.id).toBe('bnb');
    expect(getChainVisual('Avalanche C-Chain')?.id).toBe('avalanche');
    expect(getChainVisual('Hyperliquid L1')?.id).toBe('hyperevm');
    expect(getChainVisual('Hyperliquid')?.id).toBe('hyperevm');
    expect(getChainVisual('zkSync Era')?.id).toBe('zksync');
    expect(getChainVisual('Arbitrum One')?.id).toBe('arbitrum');
    expect(getChainVisual('Tron')?.id).toBe('tron');
    expect(getChainVisual('Stellar')?.id).toBe('stellar');
    expect(getChainVisual('Unichain')?.id).toBe('unichain');
    expect(getChainVisual('Fuel Network')?.id).toBe('fuel');
    expect(getChainVisual('Unknown Imaginary L9')).toBeNull();
  });
});

describe('getSourceVisual', () => {
  test('maps every known source and platform to an icon kind, color, and label', () => {
    for (const src of REQUIRED_SOURCES) {
      const visual = getSourceVisual(src);
      expect(visual.label.length, `label for ${src}`).toBeGreaterThan(0);
      expect(visual.iconKind.length, `iconKind for ${src}`).toBeGreaterThan(0);
      expect(visual.color).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(visual.id).not.toBe('unknown');
    }
  });

  test('handles case-insensitivity, @ handles, and clean unknown fallback', () => {
    expect(getSourceVisual('@ASSO7878').id).toBe('asso7878');
    expect(getSourceVisual('@arndxt').id).toBe('arndxt');
    expect(getSourceVisual('TELEGRAM').iconKind).toBe('telegram');
    expect(getSourceVisual('twitter').iconKind).toBe('x');
    const fallback = getSourceVisual('Custom Aggregator');
    expect(fallback.iconKind).toBe('globe');
    expect(fallback.label).toBe('Custom Aggregator');
  });
});

describe('extractTickerFallback', () => {
  test('prefers cleaned explicit ticker and ignores placeholder values', () => {
    expect(extractTickerFallback('Arbitrum', '$arb')).toBe('ARB');
    expect(extractTickerFallback('Ethereum', 'ETH')).toBe('ETH');
    expect(extractTickerFallback('Predict.fun $PREDICT', '')).toBe('PREDICT');
    expect(extractTickerFallback('Predict.fun $PREDICT', '—')).toBe('PREDICT');
    expect(extractTickerFallback('Predict.fun $PREDICT', 'TBA')).toBe('PREDICT');
  });

  test('extracts $TICKER and (TICKER) patterns while rejecting funding amounts and non-tickers', () => {
    expect(extractTickerFallback('predict.fun $PREDICT')).toBe('PREDICT');
    expect(extractTickerFallback('$MONAD Testnet Campaign')).toBe('MONAD');
    expect(extractTickerFallback('Bitcoin (BTC)')).toBe('BTC');
    expect(extractTickerFallback('Spiko Amundi Overnight Swap Fund (EUR) (EURSAFO)')).toBe('EURSAFO');
    expect(extractTickerFallback('Gram (prev. Toncoin) (GRAM)')).toBe('GRAM');
    expect(extractTickerFallback('Raised $25M Series A')).toBeNull();
    expect(extractTickerFallback('Pool $100K Rewards')).toBeNull();
    expect(extractTickerFallback('Uniswap (V3)')).toBeNull();
    expect(extractTickerFallback('New Protocol (Testnet)')).toBeNull();
    expect(extractTickerFallback('Plain Project Name')).toBeNull();
  });
});

describe('buildProjectLogoIndex & resolveEntityVisual', () => {
  const sampleCards = [
    {
      n: 'OpenSea',
      t: 'SEA',
      img: 'https://images.asksurf.ai/opensea.png',
      url: 'https://opensea.io/rewards',
    },
    {
      n: 'Pendle Finance',
      t: 'PENDLE',
      img: 'https://images.asksurf.ai/pendle.png',
      url: 'https://app.pendle.finance/trade',
    },
    {
      n: 'Telegram Drop',
      t: null,
      img: 'https://images.asksurf.ai/tg-drop.png',
      url: 'https://t.me/some_channel',
    },
  ];

  const sampleSections = [
    {
      id: 'defi',
      rows: [
        {
          id: 'aave-v3',
          cells: ['Aave V3', 'Lending', 'Ethereum', '$18B'],
          icon: 'https://icons.example.com/aave.png',
          href: 'https://app.aave.com/',
        },
      ],
    },
    {
      id: 'crypto',
      rows: [
        {
          id: 'bitcoin',
          cells: ['Bitcoin (BTC)', '$100,000'],
          icon: 'https://assets.coingecko.com/coins/images/1/small/bitcoin.png',
          href: 'https://www.coingecko.com/en/coins/bitcoin',
        },
      ],
    },
  ];

  test('indexes logos and tickers by normalized name, registrable domain, and ticker without colliding on generic hosts', () => {
    const index = buildProjectLogoIndex(sampleCards, sampleSections);
    expect(index.byName.get('opensea')?.logoUrl).toBe('https://images.asksurf.ai/opensea.png');
    expect(index.byDomain.get('opensea.io')?.logoUrl).toBe('https://images.asksurf.ai/opensea.png');
    expect(index.byDomain.get('pendle.finance')?.ticker).toBe('PENDLE');
    expect(index.byName.get('aave')?.logoUrl).toBe('https://icons.example.com/aave.png');
    expect(index.byDomain.get('aave.com')?.logoUrl).toBe('https://icons.example.com/aave.png');
    expect(index.byTicker.get('BTC')?.logoUrl).toBe(
      'https://assets.coingecko.com/coins/images/1/small/bitcoin.png',
    );
    // Generic social/aggregator hosts must never be indexed as project domains
    expect(index.byDomain.has('t.me')).toBe(false);
    expect(index.byDomain.has('coingecko.com')).toBe(false);
  });

  test('prioritizes authoritative upstream URLs before cross-feed index and deduplicates cleanly', () => {
    const index = buildProjectLogoIndex(sampleCards, sampleSections);
    const resolved = resolveEntityVisual({
      name: 'OpenSea',
      img: 'https://cdn.opensea.io/official.png',
      logo: 'https://images.asksurf.ai/opensea.png',
      domain: 'opensea.io',
      logoIndex: index,
    });

    expect(resolved.imageUrls).toEqual([
      'https://cdn.opensea.io/official.png',
      'https://images.asksurf.ai/opensea.png',
    ]);
    expect(resolved.monogram).toBe('OS');
  });

  test('derives clean camelCase, multi-word, and owner/repo monograms and chain entity flags', () => {
    expect(resolveEntityVisual({ name: 'swcstudiospace/PumpGrok' }).monogram).toBe('PG');
    expect(resolveEntityVisual({ name: 'Hyperliquid' }).monogram).toBe('HY');
    const monad = resolveEntityVisual({ name: 'Monad' });
    expect(monad.cryptoVisual?.symbol).toBe('MON');
    const abstract = resolveEntityVisual({ name: 'Abstract' });
    expect(abstract.isChainEntity).toBe(true);
    expect(abstract.chainVisual?.id).toBe('abstract');
  });

  test('falls back to cross-feed index match by domain when direct image is absent', () => {
    const index = buildProjectLogoIndex(sampleCards, sampleSections);
    const resolved = resolveEntityVisual({
      name: 'OpenSea Pro',
      domain: 'pro.opensea.io',
      logoIndex: index,
    });

    expect(resolved.imageUrls).toEqual(['https://images.asksurf.ai/opensea.png']);
  });

  test('returns deterministic branded geometric emblem spec with zero unverified CDN URLs for unknown projects', () => {
    const a = resolveEntityVisual({ name: 'Nebula Quest Protocol', chain: 'Monad' });
    const b = resolveEntityVisual({ name: 'Nebula Quest Protocol', chain: 'Monad' });

    expect(a.imageUrls).toEqual([]);
    expect(a.cryptoVisual).toBeNull();
    expect(a.chainVisual?.id).toBe('monad');
    expect(a.monogram).toBe('NQ');
    expect(a.palette).toEqual(b.palette);
    expect(a.geometricKind).toBe(b.geometricKind);
    expect(a.palette.bgStart).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(a.palette.bgEnd).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  test('does not hijack Live Drops project avatar with unrelated mega-cap ticker mention', () => {
    const resolved = resolveEntityVisual({
      name: 'Russia',
      ticker: 'BTC',
      sectionId: 'drops',
    });
    expect(resolved.cryptoVisual).toBeNull();
    expect(resolved.resolvedTicker).toBe('BTC');

    const coinRow = resolveEntityVisual({
      name: 'Bitcoin (BTC)',
      id: 'bitcoin',
      sectionId: 'crypto',
    });
    expect(coinRow.cryptoVisual?.symbol).toBe('BTC');
  });

  test('applies only live-verified CDN fallbacks (GitHub owners, CoinPaprika compound IDs, verified DefiLlama slugs)', () => {
    const ghRow = resolveEntityVisual({
      name: 'swcstudiospace/PumpGrok',
      id: 'swcstudiospace/PumpGrok',
      url: 'https://github.com/swcstudiospace/PumpGrok',
      sectionId: 'github',
    });
    expect(ghRow.imageUrls).toEqual(['https://github.com/swcstudiospace.png?size=64']);

    const paprikaRow = resolveEntityVisual({
      name: 'Bitcoin (BTC)',
      id: 'btc-bitcoin',
      source: 'CoinPaprika',
      sectionId: 'crypto',
    });
    expect(paprikaRow.imageUrls).toEqual(['https://static.coinpaprika.com/coin/btc-bitcoin/logo.png']);

    // CoinGecko slugs (even hyphenated ones like usd-coin) must NEVER guess CoinPaprika URLs
    const cgRow = resolveEntityVisual({
      name: 'USDC (USDC)',
      id: 'usd-coin',
      source: 'CoinGecko',
      sectionId: 'crypto',
    });
    expect(cgRow.imageUrls).toEqual([]);

    // Verified DefiLlama protocol slugs pass, while known 404 slugs (eigenlayer, base) are never guessed
    const verifiedDefi = resolveEntityVisual({
      name: 'Aave V3',
      id: 'aave-v3',
      sectionId: 'defi',
    });
    expect(verifiedDefi.imageUrls).toEqual(['https://icons.llamao.fi/icons/protocols/aave-v3?w=48&h=48']);

    const verifiedYield = resolveEntityVisual({
      name: 'WEETH',
      protocolSlug: 'ether.fi-stake',
      sectionId: 'yields',
    });
    expect(verifiedYield.imageUrls).toEqual(['https://icons.llamao.fi/icons/protocols/ether.fi-stake?w=48&h=48']);

    const unverifiedEigen = resolveEntityVisual({
      name: 'EigenLayer',
      id: 'eigenlayer',
      sectionId: 'defi',
    });
    expect(unverifiedEigen.imageUrls).toEqual([]);

    const unverifiedBase = resolveEntityVisual({
      name: 'Base',
      id: 'base',
      sectionId: 'defi',
    });
    expect(unverifiedBase.imageUrls).toEqual([]);
  });

  test('cross-matches yields protocolSlug against indexed defi market rows by id', () => {
    const index = buildProjectLogoIndex([], sampleSections);
    const yieldResolved = resolveEntityVisual({
      name: 'USDC',
      protocolSlug: 'aave-v3',
      sectionId: 'yields',
      logoIndex: index,
    });
    expect(yieldResolved.imageUrls[0]).toBe('https://icons.example.com/aave.png');
  });
});

describe('resolveOgPreview', () => {
  test('keeps only https images and clamps title and description text', () => {
    expect(
      resolveOgPreview({
        ogImage: 'https://cdn.example.com/og.png?v=1',
        ogTitle: '  Acme\u0000  airdrop\n guide  ',
        ogDescription: 'x'.repeat(400),
      }),
    ).toEqual({ image: 'https://cdn.example.com/og.png?v=1', title: 'Acme airdrop guide', description: `${'x'.repeat(280)}\u2026` });

    expect(resolveOgPreview({ ogImage: 'http://cdn.example.com/og.png', ogTitle: 'T' })).toEqual({
      image: null,
      title: 'T',
      description: null,
    });
  });

  test('returns null when nothing usable exists', () => {
    expect(resolveOgPreview({})).toBeNull();
    expect(resolveOgPreview({ ogImage: 'javascript:alert(1)', ogTitle: ' ', ogDescription: '' })).toBeNull();
  });

  test('falls back to the project name for a missing OG title', () => {
    expect(resolveOgPreview({ ogImage: 'https://cdn.example.com/og.png', fallbackTitle: 'Acme' })).toMatchObject({
      title: 'Acme',
    });
  });
});
