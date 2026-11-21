# Web3 Radar

Realtime, keyless, 100% English Web3 airdrop aggregator and live market tracker running on **$0 infrastructure** (Cloudflare Workers free tier + D1 + Workers AI + GitHub Pages).

**Live site:** https://katsugtgz.github.io/web3-data-dashboard/

## Features

- **Live Drops Feed (`#drops`)** — Scrapes 51+ public Telegram channels (`t.me/s/<handle>`) via `HTMLRewriter` plus best-effort X timelines (`OlimpioCrypto`, `DefiIgnas`, `CryptoRank_io`, `DropsTab_com`, `airdrops_io`, `cc2ventures`, `DeFi_Dad`, `atoms_res`, `MingoAirdrop`, `layerggofficial`), deduplicates across channels, flags lookalike/punycode/drainer risks, scores by trust + independent source count + recency, and optionally summarizes new/non-English clusters with Workers AI (`@cf/meta/llama-3.1-8b-instruct`).
- **Curated Airdrop Radar (`#airdrops`)** — English-normalized feed proxied from `surf.computer` with multi-facet filters, watchlist, task checklists, and filterable TGE rail.
- **Copy Agent Brief (`Agent profile`)** — Per-card markdown prompt generator for Hermes, OpenClaw, Claude computer-use, and browser-use with a locally persisted environment profile (`radar.agentProfile.v1`), `⛔ HUMAN-REQUIRED` checkpoints (CAPTCHA/Turnstile/wallet-sign/KYC/OAuth), unverified-link isolation, and preview/download support (blocked on RISK items).
- **Live Market Widgets** — Keyless tabs for Crypto Market (`CoinGecko` / `Binance Vision`), DeFi TVL (`DefiLlama`), Yields (`DefiLlama Yields`), Prediction Markets (`Polymarket`), Trending Tokens (`DexScreener`), and GitHub Radar (`GitHub Search`).
- **Weekly Source Auto-Discovery** — Collects `forwarded_from` handles and `t.me/<handle>` links into `source_candidates` (`GET /sources/candidates.json`) and updates a weekly GitHub issue via `.github/workflows/discover-sources.yml` without auto-enabling untrusted channels.

## Architecture

- **Frontend (`src/`)**: Vite 8 + React 19 + TypeScript 7 deployed to GitHub Pages. Polls Worker edge-cached JSON endpoints (`/feed.json`, `/airdrops.json`, `/markets.json`, `/sources.json`) with `ETag` (`If-None-Match` → `304`), falling back to committed snapshots in `data/snapshot/` when `VITE_API_BASE` is unset or unreachable.
- **Cloudflare Worker (`worker/`)**:
  - `1-min cron`: Polls rotating Telegram batches (`TG_BATCH_SIZE=4`), clusters, scores, records candidate channels, and summarizes eligible clusters via Workers AI (capped at `AI_DAILY_MAX=300`/day).
  - `5-min cron`: Polls surf.computer, CoinGecko, Polymarket, DexScreener, GitHub (every 30 min), best-effort X batch (`X_BATCH_SIZE=3`), seeds `known_domains`, prunes >30d posts, and decays cluster scores.
  - Endpoints: `GET /feed.json`, `GET /airdrops.json`, `GET /markets.json`, `GET /sources.json`, `GET /sources/candidates.json`, `GET /health`.
- **Heavy Ingest (`scripts/ingest-heavy.mts`)**: GitHub Actions cron (`*/30 * * * *`) processes large DefiLlama payloads (~10 MB) outside the Worker's 10 ms CPU free-tier budget and writes trimmed sections + `known_domains` to D1.

## Local Development

```bash
bun install

# Terminal 1: run Worker locally with D1 & scheduled cron testing
cd worker
npx wrangler d1 migrations apply DB --local
npx wrangler dev --test-scheduled --port 8787
# Trigger crons manually:
curl -s "http://localhost:8787/__scheduled?cron=*+*+*+*+*"
curl -s "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"

# Terminal 2: run Vite frontend against local Worker
VITE_API_BASE=http://localhost:8787 bun dev
```

## Checks & Gates

```bash
bun run typecheck       # tsc across root + worker
bun test                # unit tests (normalizers, parser, safety, clustering, brief, X, AI, discovery)
bash scripts/check-no-cjk.sh
bun run build:pages     # builds dist/ + copies data/snapshot/*.json
bun run doctor          # React Doctor (100/100 target)
```

## Deploy (Cloudflare + GitHub Pages)

1. Create a Cloudflare D1 database named `web3-radar` and update `database_id` in `worker/wrangler.toml`.
2. Add GitHub repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
3. Set GitHub repository variable `VITE_API_BASE` to your deployed Worker URL.
4. Free-tier notes: 100k Worker req/day, 10 ms CPU/invocation, 5M D1 reads + 100k D1 writes/day, ~10k Workers AI neurons/day.
