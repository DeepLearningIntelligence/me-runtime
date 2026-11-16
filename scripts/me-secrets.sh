#!/usr/bin/env bash
# Owner-run: put the deployment secrets into the runtime's .env without any agent
# ever seeing them. Run this in a terminal on the host, once.
#
#   ./scripts/me-secrets.sh
#
# It prompts with hidden input, writes each value to the env file named below with
# mode 600, and prints only the names it wrote and how many. It never echoes a value,
# never writes one to a log, and never puts one on a command line where `ps` could
# read it.

set -euo pipefail

ENV_FILE="${ENV_FILE:-/root/spike/rakazo/.env}"
KEYS=(
  OPENROUTER_API_KEY
  WHATSAPP_ACCESS_TOKEN
  WHATSAPP_PHONE_NUMBER_ID
  WHATSAPP_APP_SECRET
  WHATSAPP_VERIFY_TOKEN
  GFIN_HOUSE_KEY
)

if [ ! -f "$ENV_FILE" ]; then
  echo "me-secrets: $ENV_FILE does not exist; run this where the runtime's compose file lives" >&2
  exit 1
fi

umask 077
WRITTEN=0

for key in "${KEYS[@]}"; do
  # read -s: no echo. The value never appears in argv, so it cannot be read from ps.
  printf '%s (leave blank to keep the current value): ' "$key"
  IFS= read -rs value
  printf '\n'
  [ -n "$value" ] || continue

  # Replace an existing assignment in place, or append once. grep -v keeps the file
  # valid when the key already exists; the write is atomic before the move.
  tmp="$(mktemp "$ENV_FILE.XXXXXX")"
  grep -v "^${key}=" "$ENV_FILE" > "$tmp" || true
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  mv "$tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  WRITTEN=$((WRITTEN + 1))
done

echo "wrote $WRITTEN value(s) to $ENV_FILE (mode 600)"
echo "keys present now:"
grep -oE '^[A-Z_]+=' "$ENV_FILE" | tr -d '=' | sort | sed 's/^/  /'
echo "values were not printed. Restart the stack to apply them."
