import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // GitHub Actions (Pages) builds are published under /web3-data-dashboard/; local builds stay at /
  base: process.env.GITHUB_ACTIONS ? '/web3-data-dashboard/' : '/',
  server: { proxy: { '/api': 'http://localhost:3000' } },
  build: { target: 'esnext', outDir: 'dist' },
});
