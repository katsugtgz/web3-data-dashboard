# Web3 Data Dashboard

An English, accessible clone of an 18-section Web3 data dashboard — live airdrop radar, upcoming TGEs, crypto & stock markets, DeFi rankings, VC investors, X traffic, on-chain stocks, AI resources, and more. Original by [@ASSO7878](https://x.com/ASSO7878/).

**Live demo:** https://katsugtgz.github.io/web3-data-dashboard/

## Features

- **Live Airdrop Radar** — polls `https://import-command-query-8ca052.surf.computer/api/airdrops` (`src/lib/airdrops.ts`) every 60s (pauses in background tabs), with manual refresh and graceful snapshot fallback
- **Multi-facet filtering & sorting** — filter by token status (`All`, `Pre-token`, `Token live`, `Saved`), project type (including US stock tokens), tier (`S`/`A`/`B`/`C`), multi-chain, `$0 Free`, best-for profile, and instant search (`/` shortcut); sort by Rank/Score, Funding, Heat (X score), Recency, or Cost
- **Local watchlist & task checklist** — bookmark projects (`★`) and check off individual tasks inside the project detail modal (`localStorage` persisted, synced across tabs)
- **Upcoming TGE / Claimable rail** — filterable horizontal card rail with normalized English statuses (`Claimable` / `Eligibility check`)
- **17 snapshot data sections** — searchable, sortable, sticky-header tables with English column labels, auto-linked URLs, and semantic gain/loss indicators
- **Dual Light / Dark theme** — follows OS `prefers-color-scheme` by default with `<meta name="color-scheme">` FOUC prevention and header toggle
- **URL hash navigation** — deep-link directly to any section (`#airdrops`, `#predictions`, `#defi`, etc.)
- **Local Bun API server** — serves the dashboard snapshot, per-section JSON, and `/api/health`

## Tech stack

- [Bun](https://bun.sh) — package manager, runtime, `Bun.serve` API + static server
- React 19 + TypeScript
- Vite 8 — frontend bundler

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
├── src/             # React app (components, hooks, lib, styles)
└── scripts/         # Pages build helper
```

## API endpoints

| Endpoint | Description |
| --- | --- |
| `GET /api/health` | Service health check with card & section counts |
| `GET /api/dashboard` | Full dashboard snapshot (`data/dashboard.json`) |
| `GET /api/cards` | Card list (`dashboard.CARDS`) |
| `GET /api/sections` | Section summaries (source + name) |
| `GET /api/sections/:source/:name` | One section JSON (`harvest` / `harvest-net`) |

## GitHub Pages

The deployed site at the live demo URL is a **static build with no API server**. The dashboard snapshot is copied into the bundle at build time and fetched directly. The airdrop feed still polls its upstream endpoint; the `bun start` server and `/api/*` routes remain unchanged for local use.

## Data disclaimer

All snapshot sections are scraped from a third-party dashboard and bundled at build time. They are not live, may be stale, and are **not financial advice**.
