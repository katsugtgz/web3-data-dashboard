import { describe, expect, test } from 'bun:test';
import { createDevLocalhostCspPlugin, rewriteDevCspHtml } from './devCsp';

const SAMPLE_HTML = [
  '<!doctype html>',
  '<html lang="en">',
  '<head>',
  '<meta charset="utf-8" />',
  '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\' https://fonts.googleapis.com; font-src \'self\' https://fonts.gstatic.com; img-src \'self\' https: data:; connect-src \'self\' https:; object-src \'none\'; base-uri \'self\'; form-action \'self\'" />',
  '<title>Web3 Radar</title>',
  '</head>',
  '<body><div id="root"></div></body>',
  '</html>',
].join('\n');

describe('rewriteDevCspHtml', () => {
  test('adds loopback HTTP and WebSocket origins to connect-src while preserving all other directives and HTML byte-for-byte', () => {
    const rewritten = rewriteDevCspHtml(SAMPLE_HTML);

    const expected = SAMPLE_HTML.replace(
      "connect-src 'self' https:",
      "connect-src 'self' https: http://localhost:* http://127.0.0.1:* http://[::1]:* ws://localhost:* ws://127.0.0.1:*",
    );
    expect(rewritten).toBe(expected);
  });

  test('appends parsed loopback http: origin from apiBase for localhost, 127.0.0.1, and [::1]', () => {
    const cases: Array<[string, string]> = [
      ['http://localhost:8787', 'http://localhost:8787'],
      ['http://localhost:8787/feed.json?v=1', 'http://localhost:8787'],
      ['  http://LOCALHOST/api  ', 'http://localhost'],
      ['http://127.0.0.1:8787/', 'http://127.0.0.1:8787'],
      ['http://[::1]:8787/airdrops.json', 'http://[::1]:8787'],
      ['http://[::1]', 'http://[::1]'],
    ];

    for (const [apiBase, expectedOrigin] of cases) {
      const rewritten = rewriteDevCspHtml(SAMPLE_HTML, apiBase);
      const expected = SAMPLE_HTML.replace(
        "connect-src 'self' https:",
        `connect-src 'self' https: http://localhost:* http://127.0.0.1:* http://[::1]:* ws://localhost:* ws://127.0.0.1:* ${expectedOrigin}`,
      );
      expect(rewritten).toBe(expected);
    }
  });

  test('strictly ignores non-loopback http:, non-http:, malformed, and path-injected apiBase values', () => {
    const baseline = rewriteDevCspHtml(SAMPLE_HTML);
    const ignored = [
      undefined,
      '',
      '   ',
      'not-a-url',
      'http://example.com',
      'http://example.com:8787',
      'http://localhost.evil.com:8787',
      'http://127.0.0.2:8787',
      'http://0.0.0.0:8787',
      'https://localhost:8787',
      'https://worker.example.com',
      'ws://localhost:8787',
      'javascript:alert(1)',
    ];

    for (const apiBase of ignored) {
      const rewritten = rewriteDevCspHtml(SAMPLE_HTML, apiBase);
      expect(rewritten).toBe(baseline);
      expect(rewritten).not.toContain('example.com');
      expect(rewritten).not.toContain('evil.com');
    }

    const withInjectionAttempt = rewriteDevCspHtml(SAMPLE_HTML, "http://localhost:8787/;script-src 'unsafe-inline'");
    expect(withInjectionAttempt).toBe(rewriteDevCspHtml(SAMPLE_HTML, 'http://localhost:8787'));
    expect(withInjectionAttempt).not.toContain(";script-src 'unsafe-inline'");
  });

  test('is idempotent and does not duplicate tokens already present in connect-src', () => {
    const once = rewriteDevCspHtml(SAMPLE_HTML, 'http://localhost:8787');
    const twice = rewriteDevCspHtml(once, 'http://localhost:8787');
    expect(twice).toBe(once);

    const partial = SAMPLE_HTML.replace(
      "connect-src 'self' https:",
      "connect-src 'self' https: http://localhost:* http://localhost:8787",
    );
    const rewritten = rewriteDevCspHtml(partial, 'http://localhost:8787');
    expect(rewritten).toBe(
      SAMPLE_HTML.replace(
        "connect-src 'self' https:",
        "connect-src 'self' https: http://localhost:* http://localhost:8787 http://127.0.0.1:* http://[::1]:* ws://localhost:* ws://127.0.0.1:*",
      ),
    );
  });

  test('returns HTML unchanged when CSP meta or connect-src directive is missing or commented out', () => {
    const cases = [
      '<html><head><title>No CSP</title></head><body></body></html>',
      '<html><head><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'" /></head></html>',
      '<html><head><meta http-equiv="Content-Security-Policy" content="" /></head></html>',
      '<html><head><meta http-equiv="Content-Security-Policy" /></head></html>',
      '<html><head><meta name="description" content="connect-src \'self\'" /></head></html>',
      '<html><head><!-- <meta http-equiv="Content-Security-Policy" content="connect-src \'self\' https:" /> --></head></html>',
      '<html><head><meta http-equiv="Content-Security-Policy" content="connect-src-extra \'self\'" /></head></html>',
    ];

    for (const html of cases) {
      expect(rewriteDevCspHtml(html, 'http://localhost:8787')).toBe(html);
    }
  });

  test('handles altered CSP meta attribute order, quoting, casing, and connect-src position', () => {
    const reversedAttrs =
      '<html><head><META data-content="connect-src \'none\'" CONTENT="connect-src \'self\' https:; object-src \'none\'" HTTP-EQUIV=\'content-security-policy\'></head></html>';
    expect(rewriteDevCspHtml(reversedAttrs, 'http://localhost:8787')).toBe(
      '<html><head><META data-content="connect-src \'none\'" CONTENT="connect-src \'self\' https: http://localhost:* http://127.0.0.1:* http://[::1]:* ws://localhost:* ws://127.0.0.1:* http://localhost:8787; object-src \'none\'" HTTP-EQUIV=\'content-security-policy\'></head></html>',
    );

    const trailingConnectSrc =
      '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; CONNECT-SRC \'self\'" />';
    expect(rewriteDevCspHtml(trailingConnectSrc)).toBe(
      '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; CONNECT-SRC \'self\' http://localhost:* http://127.0.0.1:* http://[::1]:* ws://localhost:* ws://127.0.0.1:*" />',
    );
  });
});

describe('devLocalhostCsp Vite plugin', () => {
  test('applies only during serve and rewrites real index.html using resolved VITE_API_BASE', async () => {
    const indexHtml = await Bun.file(new URL('../../index.html', import.meta.url)).text();
    // Production index.html must retain strict connect-src without plaintext loopback origins.
    expect(indexHtml).toContain("connect-src 'self' https:;");
    expect(indexHtml).not.toContain('http://localhost');

    const plugin = createDevLocalhostCspPlugin();
    expect(plugin.name).toBe('dev-localhost-csp');
    expect(plugin.apply).toBe('serve');

    // Before configResolved, standard loopback origins still apply safely.
    const defaultTransformed = plugin.transformIndexHtml(indexHtml);
    expect(defaultTransformed).toBe(
      indexHtml.replace(
        "connect-src 'self' https:;",
        "connect-src 'self' https: http://localhost:* http://127.0.0.1:* http://[::1]:* ws://localhost:* ws://127.0.0.1:*;",
      ),
    );

    // Captures loopback VITE_API_BASE in configResolved.
    plugin.configResolved({ env: { VITE_API_BASE: 'http://localhost:8787' } });
    const withLoopback = plugin.transformIndexHtml(indexHtml);
    expect(withLoopback).toBe(
      indexHtml.replace(
        "connect-src 'self' https:;",
        "connect-src 'self' https: http://localhost:* http://127.0.0.1:* http://[::1]:* ws://localhost:* ws://127.0.0.1:* http://localhost:8787;",
      ),
    );

    // Ignores non-loopback VITE_API_BASE and clears previous resolved value.
    plugin.configResolved({ env: { VITE_API_BASE: 'http://example.com' } });
    const withNonLoopback = plugin.transformIndexHtml(indexHtml);
    expect(withNonLoopback).toBe(defaultTransformed);
    expect(withNonLoopback).not.toContain('http://example.com');
  });

  test('is exported as devLocalhostCsp and registered in vite.config.ts alongside react() and prefetchStaticSnapshots()', async () => {
    const viteConfigSource = await Bun.file(new URL('../../vite.config.ts', import.meta.url)).text();
    expect(viteConfigSource).toMatch(/export\s+function\s+devLocalhostCsp\(\)\s*:\s*Plugin/);
    expect(viteConfigSource).toContain('createDevLocalhostCspPlugin()');
    expect(viteConfigSource).toMatch(
      /plugins:\s*\[\s*react\(\)\s*,\s*prefetchStaticSnapshots\(\)\s*,\s*devLocalhostCsp\(\)\s*,?\s*\]/,
    );
  });
});
