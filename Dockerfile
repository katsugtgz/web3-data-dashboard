# Web3 Radar: Vite frontend + Bun server (API, scheduler, SQLite) in one image.

# Stage 1: build the frontend. The API is served from this origin, so the bundle
# is compiled with the same-origin API base.
FROM oven/bun:1-alpine AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY worker/package.json worker/package.json
RUN bun install --frozen-lockfile
COPY . .
ENV VITE_API_BASE=same-origin \
    VITE_BASE=/
RUN bun run build && bun run check:gambling

# Stage 2: runtime. Nothing under server/, worker/ or shared/ imports an npm
# package at runtime, so no node_modules and no install step here.
FROM oven/bun:1-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOME=/home/bun \
    HOST=0.0.0.0 \
    PORT=3000 \
    DB_PATH=/app/data/radar.sqlite
COPY --from=build /app/dist ./dist
# Bundled offline snapshots: the frontend falls back to these while the API warms up.
COPY --from=build /app/data/snapshot ./dist/data
COPY worker ./worker
COPY shared ./shared
COPY server ./server
RUN mkdir -p /app/data && chown bun:bun /app/data
USER bun
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/health || exit 1
CMD ["bun", "run", "server/index.ts"]
