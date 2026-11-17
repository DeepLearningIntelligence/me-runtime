#!/usr/bin/env bash
# Build and deploy the me.io runtime on the legacy host.
#
# Runs on the host, not on a workstation: it needs the host's Docker daemon and the
# compose override that the demo already uses. One argument, the git sha to build.
#
#   ./build-me-runtime.sh <sha>
#
# What it does, in order: verify the checkout is that sha and clean, check the
# safety posture in .env, build the image as me-runtime:<sha>, point the compose
# override at it, bring the stack up, probe health, and roll back to the previous
# tag if the probe fails. It prints the tag it built and the probe output, and never
# prints a value from .env.

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

# The deployment's safety posture (packet G, D-RUN-12, D-RUN-7): the .env states it,
# so a deploy never inherits the installer's or a stale value's choice. Refuse at
# deploy time rather than silently changing what the runtime allows.
ENV_FILE="$RUNTIME_DIR/.env"
[ -f "$ENV_FILE" ] || fail "$ENV_FILE is missing: the safety posture cannot be checked"
env_value() {
  sed -n "s/^$1=[[:space:]]*//p" "$ENV_FILE" | tail -1 | tr -d '\047\042\r'
}
[ "$(env_value SANDBOX_COMPUTER_EGRESS)" = "restricted" ] ||
  fail "SANDBOX_COMPUTER_EGRESS must be restricted in $ENV_FILE: agent-computer egress is stated, not inherited"
[ "$(env_value SIGNUPS_ENABLED)" = "false" ] ||
  fail "SIGNUPS_ENABLED must be false in $ENV_FILE: accounts exist only through the invite-gated phone door"
case "$(env_value PI_SESSION_RECORDING)" in
  "" | false) ;;
  *) fail "PI_SESSION_RECORDING must stay off in $ENV_FILE: no prompt or completion transcripts are recorded" ;;
esac
case "$(env_value PAID_SERVICES_PROVIDER)" in
  "" | disabled) ;;
  *) fail "PAID_SERVICES_PROVIDER must be disabled in $ENV_FILE: no paid data services (Treg stays off)" ;;
esac
case "$(env_value PAYMENT_WALLET_PROVIDER)" in
  "") ;;
  *) fail "PAYMENT_WALLET_PROVIDER must be unset in $ENV_FILE: the wallet is out of scope and request_purchase is denied" ;;
esac

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
