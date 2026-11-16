#!/usr/bin/env bash
# Host bootstrap: put the fork on the host and build it once. Run as root on the
# runtime host, from anywhere.
#
#   ./host-bootstrap.sh [git-ref]
#
# Idempotent: clones on the first run, fetches and checks out on later ones. It does
# not touch .env and does not start anything; run me-secrets.sh once, then
# build-me-runtime.sh <sha>.

set -euo pipefail

REPO="${REPO:-https://github.com/DeepLearningIntelligence/me-runtime.git}"
FORK_DIR="${FORK_DIR:-/root/spike/me-runtime}"
REF="${1:-me}"

fail() { echo "host-bootstrap: $*" >&2; exit 1; }

command -v git >/dev/null || fail "git is not installed"
command -v docker >/dev/null || fail "docker is not installed"

if [ ! -d "$FORK_DIR/.git" ]; then
  mkdir -p "$(dirname "$FORK_DIR")"
  git clone "$REPO" "$FORK_DIR"
fi

cd "$FORK_DIR"
git fetch --quiet origin
git checkout --quiet "$REF"
git reset --hard --quiet "origin/$REF"

echo "fork at $(git rev-parse --short HEAD) ($(git log -1 --format='%s'))"

if [ ! -f /root/spike/rakazo/.env ]; then
  echo "warning: /root/spike/rakazo/.env is missing; run scripts/me-secrets.sh before building" >&2
fi

echo "next: ./scripts/me-secrets.sh (owner, once), then ./build-me-runtime.sh $(git rev-parse HEAD)"
