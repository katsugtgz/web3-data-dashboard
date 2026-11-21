import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const BASE = process.env.VITE_BASE || (process.env.GITHUB_ACTIONS ? '/web3-data-dashboard/' : '/');

function prefetchStaticDashboard(): Plugin {
  let isStatic = false;
  let resolvedBase = '/';

  return {
    name: 'prefetch-static-dashboard',
    configResolved(config) {
      isStatic = Boolean(config.env.VITE_STATIC);
      resolvedBase = config.base;
    },
    transformIndexHtml() {
      if (!isStatic) return [];
      const dashboardUrl = `${resolvedBase}data/dashboard.json`;
      return [
        {
          tag: 'script',
          injectTo: 'head',
          children: `window.__ICQ_DASHBOARD__=fetch('${dashboardUrl}').then(function(r){return r.ok?r.json().then(function(d){return{data:d}}):{error:'HTTP '+r.status}}).catch(function(e){return{error:e&&e.message?e.message:String(e)}});`,
        },
      ];
    },
  };
}

export default defineConfig({
  plugins: [react(), prefetchStaticDashboard()],
  // GitHub Actions (Pages) builds are published under /web3-data-dashboard/; local / Lighthouse builds override via VITE_BASE=/
  base: BASE,
  server: { proxy: { '/api': 'http://localhost:3000' } },
  build: { target: 'esnext', outDir: 'dist' },
});
