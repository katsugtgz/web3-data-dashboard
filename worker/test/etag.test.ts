import { describe, expect, test } from 'bun:test';
import { bodyEtag, buildCacheKey } from '../src/index';
import { sha1Hex } from '../src/lib/hash';
import { validateSources } from '../src/sources/registry';

describe('cache-miss ETag stability across worker restarts', () => {
  test('bodyEtag is the strong SHA-1 of the exact response body', async () => {
    const body = JSON.stringify({ generatedAt: 123, sections: [{ id: 'crypto', rows: [] }] });
    expect(await bodyEtag(body)).toBe(`"${await sha1Hex(body)}"`);
    expect(await bodyEtag(body)).toBe(await bodyEtag(body));
    expect(await bodyEtag(body)).not.toBe(await bodyEtag(`${body} `));
  });

  test('buildCacheKey strips arbitrary query params on static routes and canonicalizes /feed.json params deterministically', () => {
    for (const path of ['/airdrops.json', '/markets.json', '/sources.json', '/sources/candidates.json']) {
      expect(buildCacheKey(`https://radar.test${path}?cb=123&utm=abc`).url).toBe(`https://radar.test${path}`);
    }
    expect(buildCacheKey('https://radar.test/feed.json?sort=score&risk=include&limit=100&since=0&cb=1').url).toBe(
      'https://radar.test/feed.json',
    );
    expect(
      buildCacheKey('https://radar.test/feed.json?sort=new&since=500&risk=exclude&limit=25&cursor=new|1|2|x&foo=bar').url,
    ).toBe('https://radar.test/feed.json?cursor=new%7C1%7C2%7Cx&limit=25&risk=exclude&since=500&sort=new');
    expect(buildCacheKey('https://radar.test/feed.json?limit=-5').url).toBe('https://radar.test/feed.json?limit=1');
  });

  test('validateSources rejects unknown platforms', () => {
    expect(() =>
      validateSources([{ platform: 'rss', handle: 'nope', lang: 'en', trust: 0.5, tags: [], enabled: true }]),
    ).toThrow();
  });
});
