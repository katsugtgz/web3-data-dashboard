import { describe, expect, test } from 'bun:test';
import sourcesJson from '../sources.json';
import { getSeedSourceById, SEED_SOURCE_BY_ID, validateSources } from '../src/sources/registry';

describe('worker/sources.json registry', () => {
  test('contains valid deduplicated curated airdrop channels with news/bot sources disabled', () => {
    const validated = validateSources(sourcesJson);
    expect(validated.length).toBeGreaterThanOrEqual(100);

    const enabledTg = validated.filter(s => s.platform === 'telegram' && s.enabled);
    const disabledTg = validated.filter(s => s.platform === 'telegram' && !s.enabled);
    const enabledX = validated.filter(s => s.platform === 'x' && s.enabled);
    const enabledSheet = validated.filter(s => s.platform === 'sheet' && s.enabled);
    const enabledFeed = validated.filter(s => s.platform === 'feed' && s.enabled);

    expect(enabledTg.length).toBe(37);
    expect(enabledX.length).toBe(30);
    expect(enabledSheet.length).toBe(2);
    expect(enabledFeed.length).toBe(8);

    // Pure news/wire/whale-bot/newsletter/blog channels must stay disabled.
    const disabledHandles = new Set(disabledTg.map(d => d.handle));
    for (const noise of [
      'cointelegraph',
      'WatcherGuru',
      'whale_alert_io',
      'CoinMarketCapAnnouncements',
      'AstronomicaNews',
      'shoalresearch',
      'diaryhabibi',
      'threadingontheedge',
      'muur_posts',
      'ahboyashreads',
      'chungdailynote',
      'drops_analytics',
      'ranked_plus',
      'layergg',
      'sarjanacryptoairdrop',
      'cubiexesports',
    ]) {
      expect(disabledHandles.has(noise)).toBe(true);
    }

    // New live-verified Telegram channels, X handles, sheets, and feeds exist
    const ids = new Set(validated.map(s => `${s.platform}:${s.handle}`));
    for (const expectedId of [
      'telegram:airdrops_io',
      'telegram:binance_wallet_announcements',
      'telegram:testnet_guide',
      'telegram:Alpha_Insiders',
      'telegram:knto_alpha',
      'telegram:airdropsultanindonesia',
      'telegram:Zealy_Announcement',
      'telegram:airdropblogspot',
      'x:ASSO7878',
      'x:Airdropalertcom',
      'x:AlphaInsiders',
      'x:TheDeFinvestor',
      'x:RootDataCrypto',
      'x:DefiLlama',
      'x:jiao_newlife',
      'sheet:asso7878_sheet',
      'sheet:arndxt_sheet',
      'feed:airdroptracker_rss',
      'feed:airdrops_io_rss',
      'feed:airdropalert_calendar',
      'feed:definvestor_substack',
      'feed:threading_substack',
      'feed:galxe_trending',
      'feed:pendle_points',
      'feed:merkl_opportunities',
    ]) {
      expect(ids.has(expectedId)).toBe(true);
    }

    // PegazusEcosystem posts heavy Indonesian and must carry lang="id".
    const pegazus = validated.find(s => s.handle === 'PegazusEcosystem');
    expect(pegazus?.lang).toBe('id');
  });

  test('rejects invalid handles, duplicate entries, out-of-range trust, and missing/non-https urls on sheet/feed', () => {
    expect(() =>
      validateSources([
        { platform: 'telegram', handle: 'ab', lang: 'en', trust: 0.5, tags: [], enabled: true },
      ]),
    ).toThrow();
    expect(() =>
      validateSources([
        { platform: 'telegram', handle: 'valid_one', lang: 'en', trust: 1.5, tags: [], enabled: true },
      ]),
    ).toThrow();
    expect(() =>
      validateSources([
        { platform: 'telegram', handle: 'SameChannel', lang: 'en', trust: 0.5, tags: [], enabled: true },
        { platform: 'telegram', handle: 'samechannel', lang: 'en', trust: 0.6, tags: [], enabled: true },
      ]),
    ).toThrow();
    expect(() =>
      validateSources([
        { platform: 'sheet', handle: 'missing_url', lang: 'en', trust: 0.8, tags: [], enabled: true },
      ]),
    ).toThrow();
    expect(() =>
      validateSources([
        { platform: 'feed', handle: 'http_only_feed', lang: 'en', trust: 0.8, tags: [], enabled: true, url: 'http://example.com/rss', parser: 'rss' },
      ]),
    ).toThrow();
    expect(() =>
      validateSources([
        { platform: 'feed', handle: 'missing_parser', lang: 'en', trust: 0.8, tags: [], enabled: true, url: 'https://example.com/rss' },
      ]),
    ).toThrow();
    expect(() =>
      validateSources([
        { platform: 'sheet', handle: 'missing_sheet_parser', lang: 'en', trust: 0.8, tags: [], enabled: true, url: 'https://docs.google.com/spreadsheets/d/abc/gviz/tq?tqx=out:csv' },
      ]),
    ).toThrow();
    expect(() =>
      validateSources([
        { platform: 'feed', handle: 'bad_parser_feed', lang: 'en', trust: 0.8, tags: [], enabled: true, url: 'https://example.com/rss', parser: 'invalid_parser' },
      ]),
    ).toThrow();
    expect(() =>
      validateSources([
        { platform: 'telegram', handle: 'bad_tg_parser', lang: 'en', trust: 0.8, tags: [], enabled: true, parser: 'bogus' },
      ]),
    ).toThrow();
    // Role/platform parser compatibility checks
    expect(() =>
      validateSources([
        { platform: 'feed', handle: 'pendle_as_drops', lang: 'en', trust: 0.85, tags: ['drops'], enabled: true, url: 'https://api-v2.pendle.finance/core/v1/markets/all', parser: 'pendle' },
      ]),
    ).toThrow();
    expect(() =>
      validateSources([
        { platform: 'feed', handle: 'merkl_as_drops', lang: 'en', trust: 0.85, tags: ['drops'], enabled: true, url: 'https://api.merkl.xyz/v4/opportunities', parser: 'merkl' },
      ]),
    ).toThrow();
    expect(() =>
      validateSources([
        { platform: 'feed', handle: 'rss_as_curated', lang: 'en', trust: 0.8, tags: ['curated'], enabled: true, url: 'https://example.com/rss', parser: 'rss' },
      ]),
    ).toThrow();
    expect(() =>
      validateSources([
        { platform: 'sheet', handle: 'sheet_with_rss', lang: 'en', trust: 0.8, tags: ['curated'], enabled: true, url: 'https://docs.google.com/spreadsheets/d/abc/gviz/tq?tqx=out:csv', parser: 'rss' },
      ]),
    ).toThrow();
    expect(() =>
      validateSources([
        { platform: 'sheet', handle: 'sheet_as_drops', lang: 'en', trust: 0.8, tags: ['drops'], enabled: true, url: 'https://docs.google.com/spreadsheets/d/abc/gviz/tq?tqx=out:csv', parser: 'arndxt' },
      ]),
    ).toThrow();
    expect(() =>
      validateSources([
        { platform: 'telegram', handle: 'tg_with_rss', lang: 'en', trust: 0.8, tags: [], enabled: true, parser: 'rss' },
      ]),
    ).toThrow();
    // Curated-only pendle and dual-role wp_calendar remain valid
    expect(
      validateSources([
        { platform: 'feed', handle: 'pendle_curated', lang: 'en', trust: 0.85, tags: ['curated'], enabled: true, url: 'https://api-v2.pendle.finance/core/v1/markets/all', parser: 'pendle' },
        { platform: 'feed', handle: 'calendar_dual', lang: 'en', trust: 0.85, tags: ['drops', 'curated'], enabled: true, url: 'https://airdropalert.com/wp-json/wp/v2/aa_calendar_event', parser: 'wp_calendar' },
      ]).length,
    ).toBe(2);
  });

  test('keys SEED_SOURCE_BY_ID by lowercase id and exposes case-insensitive getSeedSourceById', () => {
    for (const key of SEED_SOURCE_BY_ID.keys()) {
      expect(key).toBe(key.toLowerCase());
    }
    expect(SEED_SOURCE_BY_ID.get('telegram:airdropanalyst')?.handle).toBe('AirdropAnalyst');
    expect(getSeedSourceById('telegram:AirdropAnalyst')?.handle).toBe('AirdropAnalyst');
    expect(getSeedSourceById('TELEGRAM:AIRDROPANALYST')?.handle).toBe('AirdropAnalyst');
    expect(getSeedSourceById('feed:DEFInvestor_Substack')?.parser).toBe('substack');
    expect(getSeedSourceById('feed:nonexistent_source')).toBeUndefined();
  });
});
