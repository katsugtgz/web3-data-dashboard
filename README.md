# Web3 Data Dashboard

English accessible dashboard: Bun + React + Vite frontend, Bun.serve API.

## Setup

```sh
bun install
```

## Development

```sh
bun dev      # Vite dev server (proxies /api to localhost:3000)
```

Run the API alongside it: `bun start`.

## Build

```sh
bun run build   # outputs dist/
```

## Production

```sh
bun run build
bun start       # API + dist/ on http://localhost:3000 (override with PORT)
```

## Checks

```sh
bun run typecheck
bun run doctor   # react-doctor (score must be 100)
```
