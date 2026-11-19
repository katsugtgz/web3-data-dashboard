# Web3 Data Dashboard

An English, accessible clone of an 18-section Web3 data dashboard — project airdrops, crypto and stock markets, DeFi rankings, VC investors, X traffic, on-chain stocks, AI resources and more. Original by @ASSO7878.

**Live demo:** https://katsugtgz.github.io/web3-data-dashboard/

## Features

- 18 dashboard sections covering airdrops, markets (crypto/stocks), DeFi protocol rankings, VC investors, X traffic, on-chain stocks, AI resources and more
- Two harvest sources with 21 + 34 scraped section snapshots in `data/harvest/` and `data/harvest-net/`
- Live airdrop feed polled from `https://import-command-query-8ca052.surf.computer/api/airdrops` (`src/lib/airdrops.ts`)
- Local API server serving the dashboard snapshot and per-section JSON

## Tech stack

- [Bun](https://bun.sh) — package manager, runtime, `Bun.serve` API + static server
- React 19 + TypeScript
- Vite — frontend bundler

## Quick start

```bash
bun install
bun dev                # dev server with API proxy
bun run build          # production build to dist/
bun start              # serve dist/ + API on http://localhost:3000
bun run typecheck
bun run doctor
```

Requires [Bun](https://bun.sh) 1.4.0 or newer.

## Project structure

```
├── data/            # dashboard.json snapshot + harvest/ and harvest-net/ section scrapes
├── server/          # Bun.serve backend: API routes + static file serving from dist/
├── shared/          # shared TypeScript types
├── src/             # React app (components, hooks, lib)
└── scripts/         # Pages build helper
```

## API endpoints

| Endpoint | Description |
| --- | --- |
| `GET /api/dashboard` | Full dashboard snapshot (`data/dashboard.json`) |
| `GET /api/cards` | Card list (`dashboard.CARDS`) |
| `GET /api/sections` | Section summaries (source + name) |
| `GET /api/sections/:source/:name` | One section JSON (`harvest` / `harvest-net`) |

## GitHub Pages

The deployed site at the live demo URL is a **static build with no API server**. The dashboard snapshot is copied into the bundle at build time and fetched directly. The airdrop feed still polls its upstream endpoint; the `bun start` server and `/api/*` routes remain unchanged for local use.

## Data disclaimer

All data is a snapshot scraped from a third-party dashboard, bundled at build time. It is not live, may be stale, and is **not financial advice**.
