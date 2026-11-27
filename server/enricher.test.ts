import { describe, expect, test } from 'bun:test';
import type { AirdropFeed } from '../shared/types';
import { markSnapshotError, readSnapshot, upsertSnapshot } from '../worker/src/lib/db';
import { openDb, type RadarDb } from './db';
import {
  ENRICH_CONCURRENCY,
  enrichActiveClusters,
  enrichAirdropsSnapshot,
  enrichDomainsBatch,
  englishText,
  ERROR_TTL_MS,
  fetchHead,
  hostBlockReason,
  isPublicIp,
  MAX_HEAD_BYTES,
  OK_TTL_MS,
  parseHeadMeta,
  parseHeadResponse,
  resolveAssetUrl,
  seedDefiLlamaDomains,
  type HeadDeps,
  type HeadResponse,
} from './enricher';

/** Non-English samples built from code points so this file stays free of CJK literals. */
const CJK = (...codes: number[]) => String.fromCodePoint(...codes);
const E_ACUTE = String.fromCodePoint(0xe9);
const ARABIC = String.fromCodePoint(0x645, 0x631, 0x62d, 0x628, 0x627);

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;
const PUBLIC_IP = '93.184.216.34';
const ZAP_LOGO = 'https://icons.llama.fi/zap.png';

const PROTOCOLS = [
  { name: 'Zap', slug: 'zap', url: 'https://app.zap.example', logo: ZAP_LOGO, tvl: 500_000_000, category: 'Dexes' },
  {
    name: 'No Logo',
    slug: 'no-logo',
    url: 'nologo.example',
    tvl: 20_000_000,
    category: CJK(0x501f, 0x8d37),
  },
  {
    name: 'Zap Mirror',
    slug: 'zap-mirror',
    url: 'https://www.zap.example/other',
    logo: 'https://icons.llama.fi/old.png',
    tvl: 1_000_000,
    category: 'Bridge',
  },
  { name: 'Platform', slug: 'platform', url: 'https://t.co/abc', logo: 'https://icons.llama.fi/t.png', tvl: 9_000_000_000 },
  { name: 'Raw Ip', slug: 'raw-ip', url: 'https://93.184.216.34/app', tvl: 9_000_000_000 },
  { name: 'Punycode', slug: 'puny', url: 'https://xn--uniswap-2e8h.com/', tvl: 9_000_000_000 },
  { name: 'No Url', slug: 'no-url', tvl: 9_000_000_000 },
  { name: 'Junk', slug: 'junk', url: 'not a url', tvl: 9_000_000_000 },
];

const ZAP_HTML = `<!doctype html><html><head>
<title>Ignored</title>
<meta content="/img/og.png" property="og:image">
<meta property="og:title" content="Zap Protocol &amp; Earn">
<META NAME='og:description' CONTENT="Earn points ${CJK(0x4eca, 0x65e5)} on Zap.">
<link rel="shortcut icon" href="/favicon.ico">
<link rel="icon" href="/favicon-16.png" sizes="16x16">
<link rel="icon" type="image/png" sizes="32x32 16x16" href="/favicon-32.png">
<link rel="apple-touch-icon" href="apple-touch-icon.png">
<meta name="description" content="not used">
</head><body><meta property="og:image" content="/body.png"><link rel="icon" href="/body.ico"></body></html>`;

/** Network boundary fake: canned responses per exact URL; DNS answers per host (public by default, null = unknown host). */
function fakeNet(
  pages: Record<string, Partial<HeadResponse>> = {},
  hosts: Record<string, string[] | null> = {},
) {
  const lookups: string[] = [];
  const calls: { host: string; ip: string; url: string }[] = [];
  let active = 0;
  let maxActive = 0;
  const deps: HeadDeps & { lookups: typeof lookups; calls: typeof calls; maxActive: () => number } = {
    lookup: async host => {
      lookups.push(host);
      const answers = Object.hasOwn(hosts, host) ? hosts[host] : [PUBLIC_IP];
      if (!answers) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
      return answers;
    },
    request: async (url, ip) => {
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        await new Promise(resolve => setTimeout(resolve, 5));
        calls.push({ host: url.hostname, ip, url: url.toString() });
        const page = pages[url.toString()];
        if (!page) throw new Error('connection refused');
        return { status: page.status ?? 200, location: page.location ?? null, html: page.html ?? null };
      } finally {
        active--;
      }
    },
    lookups,
    calls,
    maxActive: () => maxActive,
  };
  return deps;
}

function metaRows(db: RadarDb, domain: string) {
  return db.sqlite
    .query('SELECT source, fetched_at, expires_at, error FROM domain_meta WHERE domain = ?1')
    .all(domain) as { source: string; fetched_at: number; expires_at: number; error: string | null }[];
}

describe('isPublicIp', () => {
  test.each([
    '0.0.0.0',
    '0.1.2.3',
    '10.0.0.1',
    '10.255.255.255',
    '127.0.0.1',
    '127.8.8.8',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.1.1',
    '192.0.0.1',
    '192.0.2.1',
    '100.64.0.1',
    '100.127.255.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '239.1.1.1',
    '240.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fc00::1',
    'fd12:3456:789a::1',
    'fe80::1',
    'febf::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '::ffff:8.8.8.8',
    '64:ff9b::7f00:1',
    '2001:db8::1',
    '2001::1',
    '2002:7f00:1::',
    '3fff::1',
    '',
    'not-an-ip',
    '1.2.3',
    '999.1.1.1',
    'gggg::1',
    ':::',
    '1::2::3',
  ])('%s is not a public address', ip => {
    expect(isPublicIp(ip)).toBe(false);
  });

  test.each([
    '8.8.8.8',
    '1.1.1.1',
    '172.15.255.255',
    '172.32.0.1',
    '192.169.1.1',
    '100.63.255.255',
    '100.128.0.1',
    '198.20.0.1',
    '203.1.113.1',
    '2606:4700::6810:85e5',
    '2606:4700:10::ac42:93f3',
    '2001:4860:4860::8888',
  ])('%s is a public address', ip => {
    expect(isPublicIp(ip)).toBe(true);
  });
});

describe('hostBlockReason', () => {
  test.each([
    'localhost',
    'LOCALHOST.',
    '127.0.0.1',
    '[::1]',
    '0.0.0.0',
    '169.254.169.254',
    '2130706433',
    'rsshub',
    'redis',
    'metadata.google.internal',
    'foo.local',
    'db.home.arpa',
    'xn--uniswap-2e8h.com',
    't.co',
    'bit.ly',
    'x.com',
    'app.galxe.com',
    'foo.vercel.app',
    'docs.google.com',
    'github.com',
    'www.binance.com',
    '',
    '.',
  ])('%s is never fetched', host => {
    expect(hostBlockReason(host)).toBeString();
  });

  test.each(['uniswap.org', 'app.uniswap.org', 'example.co.uk', 'my-project.io', 'sub.example.com.br'])(
    '%s is fetchable',
    host => {
      expect(hostBlockReason(host)).toBeNull();
    },
  );
});

describe('resolveAssetUrl', () => {
  const base = new URL('https://app.example.com/path/page?x=1');

  test.each([
    ['/og.png', 'https://app.example.com/og.png'],
    ['og.png', 'https://app.example.com/path/og.png'],
    ['//cdn.example.com/a.png?x=1#frag', 'https://cdn.example.com/a.png?x=1'],
    ['http://cdn.example.com/a.png', 'https://cdn.example.com/a.png'],
    ['https://cdn.example.com/a?b=1&amp;c=2', 'https://cdn.example.com/a?b=1&c=2'],
    ['https://cdn.example.com/a.png#top', 'https://cdn.example.com/a.png'],
  ])('%s resolves to %s', (raw, expected) => {
    expect(resolveAssetUrl(raw, base)).toBe(expected);
  });

  test.each([
    'data:image/png;base64,AAAA',
    'javascript:alert(1)',
    'blob:https://app.example.com/1',
    'https://user:pw@cdn.example.com/a.png',
    'https://127.0.0.1/a.png',
    '//localhost/a.png',

    `https://${'a'.repeat(2100)}.example.com/a.png`,
    '',
    '   ',
  ])('%j is rejected', raw => {
    expect(resolveAssetUrl(raw, base)).toBeNull();
  });
});

describe('englishText', () => {
  test.each([
    ['Hello ' + CJK(0x4f60, 0x597d) + ' world', 'Hello world'],
    [CJK(0x4f60, 0x597d, 0x4e16, 0x754c), null],
    ['Airdrop ' + CJK(0x5927, 0x5956), 'Airdrop'],
    [ARABIC + ' earn', 'earn'],
    ['Claim \u{1f680} now', 'Claim now'],
    ['Caf' + E_ACUTE + ' DeFi', 'Caf' + E_ACUTE + ' DeFi'],
    ['  Earn   points\n now  ', 'Earn points now'],
    ['It&#39;s live &amp; fresh', "It's live & fresh"],
    ['', null],
  ])('%j becomes %j', (raw, expected) => {
    expect(englishText(raw, 200)).toBe(expected);
  });

  test('long text is cut to the limit', () => {
    expect(englishText('x'.repeat(50), 10)).toBe('x'.repeat(10));
  });
});

describe('parseHeadMeta', () => {
  const base = new URL('https://app.zap.example/');

  test('reads og tags and prefers the apple touch icon, ignoring the body', () => {
    expect(parseHeadMeta(ZAP_HTML, base)).toEqual({
      ogImage: 'https://app.zap.example/img/og.png',
      ogTitle: 'Zap Protocol & Earn',
      ogDescription: 'Earn points on Zap.',
      icon: 'https://app.zap.example/apple-touch-icon.png',
    });
  });

  test('falls back to the largest declared icon, then the shortcut icon', () => {
    const links =
      '<link rel="icon" href="/favicon-16.png" sizes="16x16">' +
      '<link rel="icon" sizes="32x32 16x16" href="/favicon-32.png">';
    expect(parseHeadMeta(`<html><head>${links}</head></html>`, base).icon).toBe(
      'https://app.zap.example/favicon-32.png',
    );
    expect(parseHeadMeta('<link rel="shortcut icon" href="/favicon.ico">', base).icon).toBe(
      'https://app.zap.example/favicon.ico',
    );
  });

  test('upgrades an absolute http image and rejects unsafe ones', () => {
    const metas =
      '<meta property="og:image" content="http://cdn.zap.example/og.jpg">' +
      '<meta property="og:image:secure_url" content="ignored">';
    expect(parseHeadMeta(metas, base).ogImage).toBe('https://cdn.zap.example/og.jpg');
    expect(parseHeadMeta('<meta property="og:image" content="data:image/png;base64,AAAA">', base)).toEqual({
      ogImage: null,
      ogTitle: null,
      ogDescription: null,
      icon: null,
    });
  });

  test('falls back to the highest-ranked valid icon when apple-touch-icon has an unsupported URL', () => {
    const html =
      '<link rel="apple-touch-icon" href="data:image/png;base64,AAAA">' +
      '<link rel="icon" href="/favicon.png" sizes="32x32">';
    expect(parseHeadMeta(html, base).icon).toBe('https://app.zap.example/favicon.png');
  });
});

describe('fetchHead', () => {
  const hosts = { 'zap.example': [PUBLIC_IP, '2606:4700::6810:85e5'], 'app.zap.example': ['1.1.1.1'] };

  test('fetches over https pinned to a public DNS answer', async () => {
    const net = fakeNet({ 'https://zap.example/': { html: '<html><head></head></html>' } }, hosts);
    const page = await fetchHead('https://zap.example/', net);
    expect(page).toEqual({ url: 'https://zap.example/', html: '<html><head></head></html>' });
    expect(net.calls).toEqual([{ host: 'zap.example', ip: PUBLIC_IP, url: 'https://zap.example/' }]);
  });

  test.each([
    '10.0.0.5',
    '192.168.1.1',
    '172.20.0.9',
    '169.254.169.254',
    '127.0.0.1',
    '0.0.0.0',
    'fd00::1',
    'fe80::1',
    '::1',
  ])('refuses a host resolving to %s', async ip => {
    const net = fakeNet({}, { 'evil.example': [ip] });
    await expect(fetchHead('https://evil.example/', net)).rejects.toThrow('non-public');
    expect(net.calls).toEqual([]);
  });

  test('refuses a host with both public and private answers', async () => {
    const net = fakeNet({}, { 'evil.example': [PUBLIC_IP, '10.0.0.1'] });
    await expect(fetchHead('https://evil.example/', net)).rejects.toThrow('non-public');
    expect(net.calls).toEqual([]);
  });

  test.each([
    'https://localhost/',
    'https://127.0.0.1/',
    'https://[::1]/',
    'https://169.254.169.254/latest/meta-data/',
    'https://rsshub:1200/twitter/user',
    'https://t.co/abc',
    'https://xn--uniswap-2e8h.com/',
    'https://user:pw@zap.example/',
    'https://zap.example:8443/',
  ])('%s is refused before any DNS lookup', async url => {
    const net = fakeNet({}, hosts);
    await expect(fetchHead(url, net)).rejects.toThrow();
    expect(net.lookups).toEqual([]);
    expect(net.calls).toEqual([]);
  });

  test('follows https redirects and resolves every hop again', async () => {
    const net = fakeNet(
      {
        'https://zap.example/': { status: 302, location: 'https://app.zap.example/' },
        'https://app.zap.example/': { status: 301, location: '/home' },
        'https://app.zap.example/home': { html: '<html></html>' },
      },
      hosts,
    );
    const page = await fetchHead('https://zap.example/', net);
    expect(page).toEqual({ url: 'https://app.zap.example/home', html: '<html></html>' });
    expect(net.calls.map(c => `${c.host} via ${c.ip}`)).toEqual([
      'zap.example via 93.184.216.34',
      'app.zap.example via 1.1.1.1',
      'app.zap.example via 1.1.1.1',
    ]);
  });

  test.each([
    'http://169.254.169.254/latest/meta-data/',
    'https://localhost/admin',
    'https://app.zap.example:8443/',
    'file:///etc/passwd',
    'https://10.0.0.1/',
  ])('refuses a redirect to %s', async location => {
    const net = fakeNet({ 'https://zap.example/': { status: 302, location } }, hosts);
    await expect(fetchHead('https://zap.example/', net)).rejects.toThrow();
    expect(net.calls).toHaveLength(1);
    expect(net.lookups).toEqual(['zap.example']);
  });

  test('stops redirect loops', async () => {
    const net = fakeNet(
      { 'https://zap.example/': { status: 302, location: '/a' }, 'https://zap.example/a': { status: 302, location: '/' } },
      hosts,
    );
    await expect(fetchHead('https://zap.example/', net)).rejects.toThrow('too many redirects');
    expect(net.calls).toHaveLength(4);
  });

  test('fails on non-200 responses, unknown hosts and timeouts', async () => {
    await expect(fetchHead('https://zap.example/', fakeNet({ 'https://zap.example/': { status: 404 } }, hosts))).rejects.toThrow(
      'HTTP 404',
    );
    await expect(fetchHead('https://nope.example/', fakeNet({}, { 'nope.example': null }))).rejects.toThrow('ENOTFOUND');
    const hanging = fakeNet({}, hosts);
    hanging.request = () => new Promise<HeadResponse>(() => {});
    await expect(fetchHead('https://zap.example/', { ...hanging, timeoutMs: 20 })).rejects.toThrow('timed out');
  });
});

describe('parseHeadResponse', () => {
  const CRLF = String.fromCharCode(13, 10);
  const response = (lines: string[], body = '') => Buffer.from(lines.join(CRLF) + CRLF + CRLF + body);

  test('decodes an HTML body behind content-length headers', () => {
    const html = '<head><meta property="og:title" content="Hello"></head>';
    const buf = response(['HTTP/1.1 200 OK', 'Content-Type: text/html; charset=utf-8', 'Content-Length: 999'], html);
    expect(parseHeadResponse(buf)).toEqual({ status: 200, location: null, html });
  });

  test('joins chunked bodies so a tag split across chunks still parses', () => {
    const first = '<meta property="og:image" ';
    const second = 'content="/og.png">';
    const body = `${first.length.toString(16)}${CRLF}${first}${CRLF}${second.length.toString(16)}${CRLF}${second}${CRLF}0${CRLF}${CRLF}`;
    const res = parseHeadResponse(
      response(['HTTP/1.1 200 OK', 'transfer-encoding: chunked', 'CONTENT-TYPE: text/html'], body),
    );
    expect(res.html).toBe(first + second);
    expect(parseHeadMeta(res.html!, new URL('https://x.example/')).ogImage).toBe('https://x.example/og.png');
  });

  test('returns no HTML for redirects and non-HTML content', () => {
    expect(parseHeadResponse(response(['HTTP/1.1 302 Found', 'Location: /home', 'Content-Type: text/html'], 'x'))).toEqual({
      status: 302,
      location: '/home',
      html: null,
    });
    expect(parseHeadResponse(response(['HTTP/1.1 200 OK', 'Content-Type: application/pdf'], '%PDF'))).toEqual({
      status: 200,
      location: null,
      html: null,
    });
  });

  test('caps the body at MAX_HEAD_BYTES and rejects truncated responses', () => {
    const big = parseHeadResponse(response(['HTTP/1.1 200 OK', 'Content-Type: text/html'], 'a'.repeat(300_000)));
    expect(big.html).toHaveLength(MAX_HEAD_BYTES);
    expect(() => parseHeadResponse(Buffer.from('HTTP/1.1 200 OK'))).toThrow('truncated');
  });

  test('skips interim 1xx responses such as 103 Early Hints before reading the final 200 response', () => {
    const html = '<head><meta property="og:title" content="Hinted"></head>';
    const raw = Buffer.from(
      ['HTTP/1.1 103 Early Hints', 'Link: </app.css>; rel=preload; as=style'].join(CRLF) +
        CRLF +
        CRLF +
        ['HTTP/1.1 200 OK', 'Content-Type: text/html; charset=utf-8'].join(CRLF) +
        CRLF +
        CRLF +
        html,
    );
    expect(parseHeadResponse(raw)).toEqual({ status: 200, location: null, html });
  });
});

describe('enrichDomainsBatch', () => {
  function freshDb() {
    return openDb(':memory:');
  }

  test('DefiLlama seed keeps one row per domain, highest TVL first', async () => {
    const db = freshDb();
    expect(await seedDefiLlamaDomains(db.d1, PROTOCOLS, NOW)).toBe(2);
    const rows = db.sqlite
      .query('SELECT domain, logo_url, tvl_usd, category, source, expires_at FROM domain_meta ORDER BY domain')
      .all();
    expect(rows).toEqual([
      { domain: 'nologo.example', logo_url: 'https://icons.llamao.fi/icons/protocols/no-logo?w=48&h=48', tvl_usd: 20_000_000, category: null, source: 'defillama', expires_at: NOW + OK_TTL_MS },
      { domain: 'zap.example', logo_url: ZAP_LOGO, tvl_usd: 500_000_000, category: 'Dexes', source: 'defillama', expires_at: NOW + OK_TTL_MS },
    ]);
    expect(await seedDefiLlamaDomains(db.d1, 'nope', NOW)).toBe(0);
    db.close();
  });

  test('Layer 1 matches by exact and normalized domain and merges the page head', async () => {
    const db = freshDb();
    await seedDefiLlamaDomains(db.d1, PROTOCOLS, NOW);
    const net = fakeNet({ 'https://zap.example/': { html: ZAP_HTML }, 'https://nologo.example/': {} });

    const metas = await enrichDomainsBatch(db.d1, ['Zap.Example.', 'www.nologo.example'], {
      ...net,
      nowMs: NOW,
    });
    expect(metas).toEqual([
      {
        domain: 'zap.example',
        logoUrl: ZAP_LOGO,
        ogImage: 'https://zap.example/img/og.png',
        ogTitle: 'Zap Protocol & Earn',
        ogDescription: 'Earn points on Zap.',
        tvlUsd: 500_000_000,
        category: 'Dexes',
        source: 'html',
        fetchedAt: NOW,
        expiresAt: NOW + OK_TTL_MS,
        error: null,
      },
      {
        domain: 'nologo.example',
        logoUrl: 'https://icons.llamao.fi/icons/protocols/no-logo?w=48&h=48',
        ogImage: null,
        ogTitle: null,
        ogDescription: null,
        tvlUsd: 20_000_000,
        category: null,
        source: 'html',
        fetchedAt: NOW,
        expiresAt: NOW + OK_TTL_MS,
        error: null,
      },
    ]);
    expect(metaRows(db, 'zap.example')).toEqual([
      { source: 'html', fetched_at: NOW, expires_at: NOW + OK_TTL_MS, error: null },
    ]);
    db.close();
  });

  test('ok results are reused for 7 days without touching the network', async () => {
    const db = freshDb();
    const first = await enrichDomainsBatch(db.d1, ['fresh.example'], {
      ...fakeNet({ 'https://fresh.example/': { html: ZAP_HTML } }),
      nowMs: NOW,
    });
    expect(first[0]).toMatchObject({ ogImage: 'https://fresh.example/img/og.png', expiresAt: NOW + OK_TTL_MS });

    const idle = fakeNet();
    const second = await enrichDomainsBatch(db.d1, ['fresh.example'], { ...idle, nowMs: NOW + OK_TTL_MS - 1 });
    expect(second).toEqual(first);
    expect(idle.lookups).toEqual([]);
    db.close();
  });

  test('errors back off for 6 hours, then retry', async () => {
    const db = freshDb();
    const down = fakeNet();
    const failed = await enrichDomainsBatch(db.d1, ['down.example'], { ...down, nowMs: NOW });
    expect(failed[0]).toMatchObject({ domain: 'down.example', logoUrl: null, source: 'html', error: 'connection refused', expiresAt: NOW + ERROR_TTL_MS });
    expect(metaRows(db, 'down.example')).toEqual([
      { source: 'html', fetched_at: NOW, expires_at: NOW + ERROR_TTL_MS, error: 'connection refused' },
    ]);

    const idle = fakeNet();
    await enrichDomainsBatch(db.d1, ['down.example'], { ...idle, nowMs: NOW + ERROR_TTL_MS - 1 });
    expect(idle.lookups).toEqual([]);

    const up = fakeNet({ 'https://down.example/': { html: ZAP_HTML } });
    const recovered = await enrichDomainsBatch(db.d1, ['down.example'], { ...up, nowMs: NOW + ERROR_TTL_MS });
    expect(recovered[0]).toMatchObject({ error: null, ogTitle: 'Zap Protocol & Earn', expiresAt: NOW + ERROR_TTL_MS + OK_TTL_MS });
    db.close();
  });

  test('a Layer 1 hit whose page fails keeps its logo and TVL and backs off 6 hours', async () => {
    const db = freshDb();
    await seedDefiLlamaDomains(db.d1, PROTOCOLS, NOW);
    const meta = (await enrichDomainsBatch(db.d1, ['zap.example'], { ...fakeNet(), nowMs: NOW }))[0]!;
    expect(meta).toMatchObject({ logoUrl: ZAP_LOGO, tvlUsd: 500_000_000, category: 'Dexes', source: 'defillama', error: 'connection refused', expiresAt: NOW + ERROR_TTL_MS });
    db.close();
  });

  test('re-seeding never demotes a fetched row or drops its og data', async () => {
    const db = freshDb();
    await seedDefiLlamaDomains(db.d1, PROTOCOLS, NOW);
    await enrichDomainsBatch(db.d1, ['zap.example'], {
      ...fakeNet({ 'https://zap.example/': { html: ZAP_HTML } }),
      nowMs: NOW,
    });
    await seedDefiLlamaDomains(db.d1, [{ ...PROTOCOLS[0]!, tvl: 900_000_000 }], NOW + HOUR);
    const meta = (await enrichDomainsBatch(db.d1, ['zap.example'], { ...fakeNet(), nowMs: NOW + HOUR }))[0]!;
    expect(meta).toMatchObject({
      logoUrl: ZAP_LOGO,
      tvlUsd: 900_000_000,
      ogImage: 'https://zap.example/img/og.png',
      source: 'html',
      error: null,
      expiresAt: NOW + OK_TTL_MS,
    });
    db.close();
  });

  test('a concurrent DefiLlama re-seed during an HTML fetch is preserved at commit time', async () => {
    const db = freshDb();
    await seedDefiLlamaDomains(db.d1, PROTOCOLS, NOW);
    const newLogo = 'https://icons.llama.fi/zap-v2.png';
    const metas = await enrichDomainsBatch(db.d1, ['zap.example'], {
      lookup: async () => [PUBLIC_IP],
      request: async () => {
        // Simulate heavy ingest updating Layer 1 while the page fetch is in flight.
        await seedDefiLlamaDomains(
          db.d1,
          [{ ...PROTOCOLS[0]!, logo: newLogo, tvl: 900_000_000, category: 'Perps' }],
          NOW + HOUR,
        );
        return { status: 200, html: ZAP_HTML };
      },
      nowMs: NOW,
    });
    expect(metas[0]).toMatchObject({
      logoUrl: newLogo,
      tvlUsd: 900_000_000,
      category: 'Perps',
      ogImage: 'https://zap.example/img/og.png',
      source: 'html',
      error: null,
    });
    expect(db.sqlite.query("SELECT logo_url, tvl_usd, category FROM domain_meta WHERE domain = 'zap.example'").get()).toEqual({
      logo_url: newLogo,
      tvl_usd: 900_000_000,
      category: 'Perps',
    });
    db.close();
  });

  test.each(['t.co', 'localhost', '10.0.0.1', 'bit.ly', 'github.com'])('%s is never resolved or fetched', async domain => {
    const db = freshDb();
    const net = fakeNet();
    const meta = (await enrichDomainsBatch(db.d1, [domain], { ...net, nowMs: NOW }))[0]!;
    expect(meta).toMatchObject({ domain, logoUrl: null, source: 'html', expiresAt: NOW + ERROR_TTL_MS });
    expect(meta.error).toContain('blocked');
    expect(net.lookups).toEqual([]);
    expect(net.calls).toEqual([]);
    db.close();
  });

  test('an unknown host is recorded as an error', async () => {
    const db = freshDb();
    const meta = (await enrichDomainsBatch(db.d1, ['nope.example'], {
      ...fakeNet({}, { 'nope.example': null }),
      nowMs: NOW,
    }))[0]!;
    expect(meta.error).toContain('ENOTFOUND');
    db.close();
  });

  test('CoinGecko market snapshot supplies a logo by project name', async () => {
    const db = freshDb();
    const icon = 'https://assets.coingecko.com/coins/images/16547/arbitrum.png';
    await db.d1
      .prepare('INSERT INTO known_domains (domain, project, origin) VALUES (?1, ?2, ?3)')
      .bind('bridge.example', 'Arbitrum', 'curated')
      .run();
    await db.d1
      .prepare('INSERT INTO snapshots (key, body, etag, fetched_at, ok) VALUES (?1, ?2, ?3, ?4, 1)')
      .bind(
        'markets:crypto',
        JSON.stringify({
          section: { rows: [{ cells: ['Arbitrum (ARB)', '$1', '+2%', '$400M', '$4B'], icon }] },
          sectors: [],
        }),
        '"cg"',
        NOW,
      )
      .run();
    const meta = (await enrichDomainsBatch(db.d1, ['bridge.example'], { ...fakeNet(), nowMs: NOW }))[0]!;
    expect(meta).toMatchObject({ logoUrl: icon, source: 'coingecko', tvlUsd: null });
    db.close();
  });

  test('fetches at most ENRICH_CONCURRENCY pages at once and dedupes domains', async () => {
    const db = freshDb();
    const net = fakeNet();
    const domains = ['a.example', 'a.example', '', '   ', ...'bcdefghij'.split('').map(c => `${c}.example`)];
    const metas = await enrichDomainsBatch(db.d1, domains, { ...net, nowMs: NOW });
    expect(metas.map(m => m.domain)).toEqual([...'abcdefghij'.split('').map(c => `${c}.example`)]);
    expect(net.maxActive()).toBeLessThanOrEqual(ENRICH_CONCURRENCY);
    expect(await enrichDomainsBatch(db.d1, [], { nowMs: NOW })).toEqual([]);
    db.close();
  });
});

describe('enrichActiveClusters', () => {
  function insertCluster(db: RadarDb, id: string, domain: string | null, score: number) {
    db.sqlite
      .prepare(
        `INSERT INTO clusters (id, project, domain, chains, task_types, summary, summary_source, risk_level, risk_reasons,
           score, source_count, first_seen, last_seen)
         VALUES (?1, ?1, ?2, '[]', '[]', 'summary', 'rule', 'ok', '[]', ?3, 1, ?4, ?4)`,
      )
      .run(id, domain, score, NOW);
  }

  function clusterMeta(db: RadarDb, id: string) {
    return db.sqlite
      .query('SELECT og_image, og_title, og_description, tvl_usd FROM clusters WHERE id = ?1')
      .get(id);
  }

  async function seededDb() {
    const db = openDb(':memory:');
    await seedDefiLlamaDomains(db.d1, PROTOCOLS, NOW);
    insertCluster(db, 'top', 'zap.example', 90);
    insertCluster(db, 'second', 'second.example', 80);
    insertCluster(db, 'low', 'low.example', 10);
    insertCluster(db, 'nodomain', null, 99);
    return db;
  }

  test('enriches the top clusters by score and backfills og and TVL columns', async () => {
    const db = await seededDb();
    const net = fakeNet({ 'https://zap.example/': { html: ZAP_HTML }, 'https://second.example/': { status: 403 } });

    expect(await enrichActiveClusters(db.d1, NOW, 2, { ...net })).toEqual({ selected: 2, errors: 1 });
    expect(clusterMeta(db, 'top')).toEqual({
      og_image: 'https://zap.example/img/og.png',
      og_title: 'Zap Protocol & Earn',
      og_description: 'Earn points on Zap.',
      tvl_usd: 500_000_000,
    });
    expect(clusterMeta(db, 'second')).toEqual({ og_image: null, og_title: null, og_description: null, tvl_usd: null });
    expect(clusterMeta(db, 'low')).toEqual({ og_image: null, og_title: null, og_description: null, tvl_usd: null });
    expect(net.lookups).toEqual(['zap.example', 'second.example']);
    db.close();
  });

  test('skips clusters whose domain is cached, and returns once a cache entry expires', async () => {
    const db = await seededDb();
    const net = fakeNet({ 'https://zap.example/': { html: ZAP_HTML } });
    await enrichActiveClusters(db.d1, NOW, 20, { ...net });

    const idle = fakeNet();
    expect(await enrichActiveClusters(db.d1, NOW + HOUR, 20, { ...idle })).toEqual({ selected: 0, errors: 0 });
    expect(idle.lookups).toEqual([]);

    expect(await enrichActiveClusters(db.d1, NOW + OK_TTL_MS + 1, 20, { ...idle })).toEqual({ selected: 3, errors: 3 });
    expect(idle.lookups).toEqual(['zap.example', 'second.example', 'low.example']);
    db.close();
  });

  test('backfills a new cluster from fresh cached domain_meta without making a network request', async () => {
    const db = await seededDb();
    const net = fakeNet({ 'https://zap.example/': { html: ZAP_HTML } });
    await enrichActiveClusters(db.d1, NOW, 20, { ...net });

    insertCluster(db, 'late-zap', 'zap.example', 75);
    const idle = fakeNet();
    expect(await enrichActiveClusters(db.d1, NOW + HOUR, 20, { ...idle })).toEqual({ selected: 1, errors: 0 });
    expect(idle.lookups).toEqual([]);
    expect(clusterMeta(db, 'late-zap')).toEqual({
      og_image: 'https://zap.example/img/og.png',
      og_title: 'Zap Protocol & Earn',
      og_description: 'Earn points on Zap.',
      tvl_usd: 500_000_000,
    });
    db.close();
  });
});

describe('enrichAirdropsSnapshot', () => {
  test('backfills logo, ogImage, tvlUsd, and description on non-risk cards while skipping risk cards', async () => {
    const db = openDb(':memory:');
    await seedDefiLlamaDomains(db.d1, PROTOCOLS, NOW);
    const feed: AirdropFeed = {
      cards: [
        {
          r: 1,
          n: 'Zap',
          id: 'asso:zap',
          t: null,
          g: 'A',
          b: ['live'],
          img: '',
          f: '$10M',
          tk: '1/1',
          h: 1,
          u: 'today',
          fit: ['zero'],
          best: { n: 'Use Zap', ty: 'liquidity', c: '$0', m: '—' },
          sc: 80,
          sub: [8, 8, null],
          url: 'https://app.zap.example/farm',
          source: 'ASSO7878',
        },
        {
          r: 2,
          n: 'ScamZap',
          id: 'asso:scam',
          t: null,
          g: 'C',
          b: ['risk'],
          img: '',
          f: '—',
          tk: '1/1',
          h: 0,
          u: 'today',
          fit: ['zero'],
          best: { n: 'Bad', ty: 'other', c: '$0', m: '—' },
          sc: 10,
          sub: [1, 1, null],
          url: 'https://zap.example/fake',
          source: 'ASSO7878',
        },
      ],
      tge: [],
      counts: { active: 2, preToken: 2 },
      fetchedAt: NOW - 1000,
    };
    await upsertSnapshot(db.d1, 'airdrops', feed, NOW - 1000);

    const net = fakeNet({ 'https://zap.example/': { html: ZAP_HTML } });
    const res = await enrichAirdropsSnapshot(db.d1, NOW, 10, { ...net });
    expect(res).toEqual({ enriched: 1, fetched: 1, errors: 0 });

    const stored = await readSnapshot(db.d1, 'airdrops');
    expect(stored?.fetched_at).toBe(NOW - 1000);
    const updated = JSON.parse(stored!.body) as AirdropFeed;
    expect(updated.cards[0]).toMatchObject({
      img: ZAP_LOGO,
      ogImage: 'https://zap.example/img/og.png',
      tvlUsd: 500_000_000,
      description: 'Earn points on Zap.',
    });
    expect(updated.cards[1]?.img).toBe('');
    expect(updated.cards[1]?.ogImage).toBeUndefined();
    db.close();
  });

  test('fetches metadata for cards that already have images but lack description or TVL, and preserves failed snapshot status', async () => {
    const db = openDb(':memory:');
    const feed: AirdropFeed = {
      cards: [
        {
          r: 1,
          n: 'Zap',
          id: 'asso:zap',
          t: null,
          g: 'A',
          b: ['live'],
          img: ZAP_LOGO,
          ogImage: 'https://zap.example/existing-og.png',
          f: '$10M',
          tk: '1/1',
          h: 1,
          u: 'today',
          fit: ['zero'],
          best: { n: 'Use Zap', ty: 'liquidity', c: '$0', m: '—' },
          sc: 80,
          sub: [8, 8, null],
          url: 'https://app.zap.example/farm',
          source: 'ASSO7878',
        },
      ],
      tge: [],
      counts: { active: 1, preToken: 1 },
      fetchedAt: NOW - 1000,
    };
    await upsertSnapshot(db.d1, 'airdrops', feed, NOW - 1000);
    await markSnapshotError(db.d1, 'airdrops', new Error('upstream 503'), NOW - 500);

    const net = fakeNet({ 'https://zap.example/': { html: ZAP_HTML } });
    const res = await enrichAirdropsSnapshot(db.d1, NOW, 10, { ...net });
    expect(res).toEqual({ enriched: 1, fetched: 1, errors: 0 });
    expect(net.lookups).toEqual(['zap.example']);

    const stored = await readSnapshot(db.d1, 'airdrops');
    expect(stored?.ok).toBe(0);
    expect(stored?.error).toBe('upstream 503');
    const updated = JSON.parse(stored!.body) as AirdropFeed;
    expect(updated.cards[0]?.description).toBe('Earn points on Zap.');
    db.close();
  });
});
