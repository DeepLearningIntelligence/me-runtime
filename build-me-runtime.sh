#!/usr/bin/env bash
# Build and deploy the me.io runtime on the legacy host.
#
# Runs on the host, not on a workstation: it needs the host's Docker daemon and the
# compose override that the demo already uses. One argument, the git sha to build.
#
#   ./build-me-runtime.sh <sha>
#
# What it does, in order: verify the checkout is that sha and clean, build the image
# as me-runtime:<sha>, point the compose override at it, bring the stack up, probe
# health, and roll back to the previous tag if the probe fails. It prints the tag it
# built and the probe output, and never prints a value from .env.

set -euo pipefail

FORK_DIR="${FORK_DIR:-/root/spike/me-runtime}"
RUNTIME_DIR="${RUNTIME_DIR:-/root/spike/rakazo}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.images.yml}"
OVERRIDE="${OVERRIDE:-docker-compose.override.yml}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:5173/api/health}"
PROBE_ATTEMPTS="${PROBE_ATTEMPTS:-30}"

fail() { echo "build-me-runtime: $*" >&2; exit 1; }

SHA="${1:-}"
[ -n "$SHA" ] || fail "usage: build-me-runtime.sh <sha>"

cd "$FORK_DIR"
git rev-parse --verify --quiet "$SHA^{commit}" >/dev/null || fail "unknown sha $SHA"
if [ -n "$(git status --porcelain)" ]; then
  fail "working tree is dirty; a build tag must name exactly the code it built"
fi
git checkout --quiet "$SHA"

TAG="me-runtime:${SHA:0:12}"
PREVIOUS="$(grep -oE 'me-runtime:[a-f0-9]{12}' "$RUNTIME_DIR/$OVERRIDE" 2>/dev/null | head -1 || true)"

echo "building $TAG"
docker build -t "$TAG" -f Dockerfile . || fail "docker build failed"

if [ -f "$RUNTIME_DIR/$OVERRIDE" ]; then
  sed -i "s|me-runtime:[a-f0-9]\{12\}|$TAG|g" "$RUNTIME_DIR/$OVERRIDE"
else
  fail "$RUNTIME_DIR/$OVERRIDE is missing: it is what pins the runtime image"
fi

rollback() {
  if [ -n "$PREVIOUS" ] && [ "$PREVIOUS" != "$TAG" ]; then
    echo "health probe failed; rolling back to $PREVIOUS" >&2
    sed -i "s|$TAG|$PREVIOUS|g" "$RUNTIME_DIR/$OVERRIDE"
    ( cd "$RUNTIME_DIR" && docker compose -f "$COMPOSE_FILE" -f "$OVERRIDE" up -d )
    echo "rolled back to $PREVIOUS" >&2
  else
    echo "health probe failed and there is no previous tag to roll back to" >&2
  fi
  exit 1
}

( cd "$RUNTIME_DIR" && docker compose -f "$COMPOSE_FILE" -f "$OVERRIDE" up -d )

for attempt in $(seq 1 "$PROBE_ATTEMPTS"); do
  if body="$(curl -fsS --max-time 5 "$HEALTH_URL" 2>/dev/null)"; then
    echo "healthy after ${attempt} attempt(s): $body"
    echo "deployed $TAG"
    exit 0
  fi
  sleep 2
done

rollback
