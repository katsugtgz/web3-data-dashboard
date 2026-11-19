/**
 * Pages build: plain `vite build`, then copy the data snapshot into dist.
 * Runs with GITHUB_ACTIONS=true (see .github/workflows/pages.yml) so vite
 * emits /web3-data-dashboard/ asset paths, and with VITE_STATIC=1 so
 * useDashboard fetches the bundled JSON instead of /api/*.
 */
import { mkdir, copyFile } from 'node:fs/promises';

await Bun.$`vite build`.quiet();
await mkdir('dist/data', { recursive: true });
await copyFile('data/dashboard.json', 'dist/data/dashboard.json');
console.log('dist/data/dashboard.json copied');
