import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const BASE = process.env.VITE_BASE || (process.env.GITHUB_ACTIONS ? '/web3-data-dashboard/' : '/');

function prefetchStaticSnapshots(): Plugin {
  let isStatic = false;
  let resolvedBase = '/';

  return {
    name: 'prefetch-static-snapshots',
    configResolved(config) {
      isStatic = Boolean(config.env.VITE_STATIC) && !(config.env.VITE_API_BASE ?? '').replace(/\/+$/, '');
      resolvedBase = config.base;
    },
    transformIndexHtml() {
      if (!isStatic) return [];
      const feedUrl = `${resolvedBase}data/feed.json`;
      const airdropsUrl = `${resolvedBase}data/airdrops.json`;
      const marketsUrl = `${resolvedBase}data/markets.json`;
      const sourcesUrl = `${resolvedBase}data/sources.json`;
      return [
        {
          tag: 'script',
          injectTo: 'head',
          children: `window.__RADAR_PREFETCH__={feed:fetch('${feedUrl}').then(function(r){return r.ok?r.json():null}).catch(function(){return null}),airdrops:fetch('${airdropsUrl}').then(function(r){return r.ok?r.json():null}).catch(function(){return null}),markets:fetch('${marketsUrl}').then(function(r){return r.ok?r.json():null}).catch(function(){return null}),sources:fetch('${sourcesUrl}').then(function(r){return r.ok?r.json():null}).catch(function(){return null})};`,
        },
      ];
    },
  };
}

export default defineConfig({
  plugins: [react(), prefetchStaticSnapshots()],
  base: BASE,
  build: { target: 'esnext', outDir: 'dist' },
});
