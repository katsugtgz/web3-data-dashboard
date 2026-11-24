import { describe, expect, test } from 'bun:test';
import sourcesJson from '../sources.json';
import { validateSources } from '../src/sources/registry';

describe('worker/sources.json registry', () => {
  test('contains valid deduplicated curated airdrop channels with news/bot sources disabled', () => {
    const validated = validateSources(sourcesJson);
    expect(validated.length).toBeGreaterThanOrEqual(63);

    const enabledTg = validated.filter(s => s.platform === 'telegram' && s.enabled);
    const disabledTg = validated.filter(s => s.platform === 'telegram' && !s.enabled);
    const enabledX = validated.filter(s => s.platform === 'x' && s.enabled);

    expect(enabledTg.length).toBe(29);
    expect(enabledX.length).toBe(10);

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

    // PegazusEcosystem posts heavy Indonesian and must carry lang="id".
    const pegazus = validated.find(s => s.handle === 'PegazusEcosystem');
    expect(pegazus?.lang).toBe('id');
  });

  test('rejects invalid handles, duplicate entries, and out-of-range trust', () => {
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
  });
});
