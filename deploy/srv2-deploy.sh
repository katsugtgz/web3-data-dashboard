#!/usr/bin/env bash
# Deploys Web3 Radar on srv2 from the repository checkout.
#
# Safe to re-run at any time: it fast-forwards the checkout (never resets or
# rewrites local history), rebuilds only what changed, and leaves .env and data/
# alone. Fails loudly with the container logs if the dashboard does not come up.
#
#   ./deploy/srv2-deploy.sh
#
# Environment:
#   APP_DIR         checkout location        (default: ~/apps/web3-radar)
#   REPO_URL        repository to clone      (default: the GitHub repository)
#   BRANCH          branch to deploy         (default: master)
#   HEALTH_TIMEOUT  seconds to wait for /health (default: 180)
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/apps/web3-radar}"
REPO_URL="${REPO_URL:-https://github.com/katsugtgz/web3-data-dashboard.git}"
BRANCH="${BRANCH:-master}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-180}"

log() { printf '[deploy] %s\n' "$*"; }
die() {
  printf '[deploy] ERROR: %s\n' "$*" >&2
  exit 1
}

# One deploy at a time: a second run waits instead of racing the first. The lock
# file stays behind on purpose; unlinking it would let a later run lock a new file.
exec 9>"${TMPDIR:-/tmp}/web3-radar-deploy.lock"
flock -w 900 9 || die "another deploy is still running"

command -v git >/dev/null || die "git is not installed"
docker compose version >/dev/null 2>&1 || die "docker compose v2 (docker-compose-plugin) is not installed"

if [ -d "$APP_DIR/.git" ]; then
  cd "$APP_DIR"
else
  log "cloning $BRANCH of $REPO_URL into $APP_DIR"
  mkdir -p "$(dirname "$APP_DIR")"
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
  cd "$APP_DIR"
fi

log "updating $BRANCH"
git pull --ff-only origin "$BRANCH"

# Settings live outside git. The first run seeds .env from the example and the
# dashboard comes up with polling enabled; add secrets and re-run to apply them.
if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env
  log "created .env from .env.example"
fi
mkdir -p data

# The container runs as this account so the ./data bind mount stays writable.
export RADAR_UID="$(id -u)" RADAR_GID="$(id -g)"

log "building and starting the stack"
if grep -qE '^CLOUDFLARE_TUNNEL_TOKEN=[^[:space:]#]+' .env; then
  docker compose up -d --build --remove-orphans
else
  log "CLOUDFLARE_TUNNEL_TOKEN is empty in .env; starting web3-radar, rsshub, and redis only"
  docker compose up -d --build --remove-orphans web3-radar rsshub redis
fi

log "waiting up to ${HEALTH_TIMEOUT}s for the dashboard (heavy ingest + first cron pass)"
deadline=$((SECONDS + HEALTH_TIMEOUT))
while :; do
  health="$(docker compose exec -T web3-radar wget -qO- http://127.0.0.1:3000/health 2>/dev/null || true)"
  if [ -n "$health" ] && printf '%s' "$health" | grep -q '"ready":true'; then
    break
  fi
  if [ "$SECONDS" -ge "$deadline" ]; then
    docker compose ps >&2
    docker compose logs --tail=80 web3-radar >&2
    die "web3-radar did not become ready within ${HEALTH_TIMEOUT}s"
  fi
  sleep 3
done

if printf '%s' "$health" | grep -q '"ok":true'; then
  log "healthy: $(git rev-parse --short HEAD) at $APP_DIR"
else
  # The app is up, but at least one upstream snapshot failed its last fetch.
  log "deployed $(git rev-parse --short HEAD), some snapshots are failing (see /health): $health"
fi
