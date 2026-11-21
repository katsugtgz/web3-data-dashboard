import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const BASE = process.env.GITHUB_ACTIONS ? '/web3-data-dashboard/' : '/';
const DASHBOARD_URL = `${BASE}data/dashboard.json`;

function prefetchStaticDashboard(): Plugin {
  return {
    name: 'prefetch-static-dashboard',
    transformIndexHtml() {
      if (!process.env.VITE_STATIC) return [];
      return [
        {
          tag: 'script',
          injectTo: 'head',
          children: `window.__ICQ_DASHBOARD__=fetch('${DASHBOARD_URL}').then(function(r){return r.ok?r.json().then(function(d){return{data:d}}):{error:'HTTP '+r.status}}).catch(function(e){return{error:e&&e.message?e.message:String(e)}});`,
        },
      ];
    },
  };
}

export default defineConfig({
  plugins: [react(), prefetchStaticDashboard()],
  // GitHub Actions (Pages) builds are published under /web3-data-dashboard/; local builds stay at /
  base: BASE,
  server: { proxy: { '/api': 'http://localhost:3000' } },
  build: { target: 'esnext', outDir: 'dist' },
});
