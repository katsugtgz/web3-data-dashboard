# Web3 Radar

Realtime, keyless, 100% English Web3 airdrop aggregator and live market tracker running on **$0 infrastructure** (Cloudflare Workers free tier + D1 + GitHub Pages).

**Live site:** https://katsugtgz.github.io/web3-data-dashboard/

## Architecture

- **Frontend (`src/`)**: Vite 8 + React 19 + TypeScript 7 deployed to GitHub Pages. Polls Worker edge-cached JSON endpoints with `ETag` (`If-None-Match` → `304`), falling back to committed snapshots in `data/snapshot/` when `VITE_API_BASE` is unset or unreachable.
- **Cloudflare Worker (`worker/`)**: Cron-triggered ingestion into Cloudflare D1 (`snapshots` table) and `caches.default` edge caching:
  - `GET /airdrops.json` — English-normalized surf.computer airdrop feed (`worker/src/normalize/i18n.ts` strips/translates all CJK server-side).
  - `GET /markets.json` — Live market sections with per-source staleness flags.
  - `GET /health` — Snapshot freshness and upstream status.
- **Heavy Ingest (`scripts/ingest-heavy.mts`)**: GitHub Actions cron (`*/30 * * * *`) processes large DefiLlama payloads (~10 MB) outside the Worker's 10 ms CPU free-tier budget and writes trimmed sections to D1.

## Data Sources (Keyless)

| Section | Source | Cadence | Where it runs |
| --- | --- | --- | --- |
| Airdrops | [surf.computer](https://import-command-query-8ca052.surf.computer/api/airdrops) (proxied & translated) | 5 min | Cloudflare Worker |
| Crypto Market & Sectors | [CoinGecko](https://www.coingecko.com) (fallback: [Binance Vision](https://data-api.binance.vision)) | 5 min | Cloudflare Worker |
| DeFi TVL | [DefiLlama Protocols](https://defillama.com) | 30 min | GitHub Actions → D1 |
| Yields & Liquidity | [DefiLlama Yields](https://defillama.com/yields) | 30 min | GitHub Actions → D1 |
| Prediction Markets | [Polymarket Gamma](https://polymarket.com) | 5 min | Cloudflare Worker |
| Trending Tokens | [DexScreener](https://dexscreener.com) | 5 min | Cloudflare Worker |
| GitHub Radar | [GitHub Search](https://github.com/search) | 30 min | Cloudflare Worker |

## Local Development

```bash
bun install

# Terminal 1: run Worker locally with D1 & scheduled cron testing
cd worker
npx wrangler d1 migrations apply DB --local
npx wrangler dev --test-scheduled --port 8787
# Trigger cron manually:
curl -s "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"

# Terminal 2: run Vite frontend against local Worker
VITE_API_BASE=http://localhost:8787 bun dev
```

## Checks & Gates

```bash
bun run typecheck       # tsc across root + worker
bun test                # unit tests (normalizers, i18n, markets)
bash scripts/check-no-cjk.sh
bun run build:pages     # builds dist/ + copies data/snapshot/*.json
bun run doctor          # React Doctor (100/100 target)
```

## Deploy (Cloudflare + GitHub Pages)

1. Create a Cloudflare D1 database named `web3-radar` and update `database_id` in `worker/wrangler.toml`.
2. Add GitHub repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
3. Set GitHub repository variable `VITE_API_BASE` to your deployed Worker URL.
4. Free-tier notes: 100k Worker req/day, 10 ms CPU/invocation, 5M D1 reads + 100k D1 writes/day.
