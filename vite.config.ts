import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const BASE = process.env.VITE_BASE || (process.env.GITHUB_ACTIONS ? '/web3-data-dashboard/' : '/');
const API_BASE = (process.env.VITE_API_BASE ?? '').replace(/\/+$/, '');

function prefetchStaticSnapshots(): Plugin {
  let isStatic = false;
  let resolvedBase = '/';

  return {
    name: 'prefetch-static-snapshots',
    configResolved(config) {
      isStatic = Boolean(config.env.VITE_STATIC) && !API_BASE;
      resolvedBase = config.base;
    },
    transformIndexHtml() {
      if (!isStatic) return [];
      const airdropsUrl = `${resolvedBase}data/airdrops.json`;
      const marketsUrl = `${resolvedBase}data/markets.json`;
      return [
        {
          tag: 'script',
          injectTo: 'head',
          children: `window.__RADAR_PREFETCH__={airdrops:fetch('${airdropsUrl}').then(function(r){return r.ok?r.json():null}).catch(function(){return null}),markets:fetch('${marketsUrl}').then(function(r){return r.ok?r.json():null}).catch(function(){return null})};`,
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
