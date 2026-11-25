import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { createDevLocalhostCspPlugin } from './src/lib/devCsp';

const BASE = process.env.VITE_BASE || (process.env.GITHUB_ACTIONS ? '/web3-data-dashboard/' : '/');

function buildPrefetchScript(base: string): string {
  const urls = {
    feed: `${base}data/feed.json`,
    airdrops: `${base}data/airdrops.json`,
    markets: `${base}data/markets.json`,
    sources: `${base}data/sources.json`,
  };
  return [
    'window.__RADAR_PREFETCH__ = (function (u) {',
    '  function load(url) {',
    '    return fetch(url).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });',
    '  }',
    '  return { feed: load(u.feed), airdrops: load(u.airdrops), markets: load(u.markets), sources: load(u.sources) };',
    `})(${JSON.stringify(urls)});`,
    '',
  ].join('\n');
}

function prefetchStaticSnapshots(): Plugin {
  let isStatic = false;
  let resolvedBase = '/';

  return {
    name: 'prefetch-static-snapshots',
    configResolved(config) {
      const rawStatic = (config.env.VITE_STATIC ?? '').trim().toLowerCase();
      const apiBase = (config.env.VITE_API_BASE ?? '').replace(/\/+$/, '');
      isStatic = (rawStatic === '1' || rawStatic === 'true') && !apiBase;
      resolvedBase = config.base;
    },
    configureServer(server) {
      if (!isStatic) return;
      const route = `${resolvedBase}prefetch-static.js`;
      server.middlewares.use((req, res, next) => {
        if (req.url === route) {
          res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
          res.end(buildPrefetchScript(resolvedBase));
          return;
        }
        next();
      });
    },
    generateBundle() {
      if (!isStatic) return;
      this.emitFile({
        type: 'asset',
        fileName: 'prefetch-static.js',
        source: buildPrefetchScript(resolvedBase),
      });
    },
    transformIndexHtml() {
      if (!isStatic) return [];
      return [
        {
          tag: 'script',
          attrs: { src: `${resolvedBase}prefetch-static.js` },
          injectTo: 'head',
        },
      ];
    },
  };
}

export function devLocalhostCsp(): Plugin {
  return createDevLocalhostCspPlugin();
}

export default defineConfig({
  plugins: [react(), prefetchStaticSnapshots(), devLocalhostCsp()],
  base: BASE,
  build: { target: 'esnext', outDir: 'dist' },
});
