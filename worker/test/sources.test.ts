import { describe, expect, test } from 'bun:test';
import sourcesJson from '../sources.json';
import { validateSources } from '../src/sources/registry';

describe('worker/sources.json registry', () => {
  test('contains valid deduplicated user channels with proper flags', () => {
    const validated = validateSources(sourcesJson);
    expect(validated.length).toBeGreaterThanOrEqual(53);

    const enabled = validated.filter(s => s.enabled);
    const disabled = validated.filter(s => !s.enabled);
    expect(enabled.length).toBeGreaterThanOrEqual(51);
    expect(disabled.map(d => d.handle).sort()).toEqual(['cubiexesports', 'sarjanacryptoairdrop']);
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
