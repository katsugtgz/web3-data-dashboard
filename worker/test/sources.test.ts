import { describe, expect, test } from 'bun:test';
import sourcesJson from '../sources.json';
import { validateSources } from '../src/sources/registry';

describe('worker/sources.json registry', () => {
  test('contains valid deduplicated user channels with proper flags', () => {
    const validated = validateSources(sourcesJson);
    expect(validated.length).toBeGreaterThanOrEqual(63);

    const enabledTg = validated.filter(s => s.platform === 'telegram' && s.enabled);
    const disabledTg = validated.filter(s => s.platform === 'telegram' && !s.enabled);
    const enabledX = validated.filter(s => s.platform === 'x' && s.enabled);
    expect(enabledTg.length).toBeGreaterThanOrEqual(51);
    expect(disabledTg.map(d => d.handle).sort()).toEqual(['cubiexesports', 'sarjanacryptoairdrop']);
    expect(enabledX.length).toBe(10);
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
