import { describe, expect, test } from 'bun:test';
import { bodyEtag } from '../src/index';
import { sha1Hex } from '../src/lib/hash';
import { validateSources } from '../src/sources/registry';

describe('cache-miss ETag stability across worker restarts', () => {
  test('bodyEtag is the strong SHA-1 of the exact response body', async () => {
    const body = JSON.stringify({ generatedAt: 123, sections: [{ id: 'crypto', rows: [] }] });
    expect(await bodyEtag(body)).toBe(`"${await sha1Hex(body)}"`);
    expect(await bodyEtag(body)).toBe(await bodyEtag(body));
    expect(await bodyEtag(body)).not.toBe(await bodyEtag(`${body} `));
  });

  test('validateSources rejects unknown platforms', () => {
    expect(() =>
      validateSources([{ platform: 'rss', handle: 'nope', lang: 'en', trust: 0.5, tags: [], enabled: true }]),
    ).toThrow();
  });
});
