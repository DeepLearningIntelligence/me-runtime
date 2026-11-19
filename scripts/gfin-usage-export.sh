#!/usr/bin/env bash
# Read-only export for the staged GFIN bill.
#
# Two meters exist and this script reads whichever the target DB has:
#   usage_events  (me_io, written by me-gofunditnow's usage emit; provider "gfin_mcp")
#   usage_records (me-runtime, written through recordUsage, including the MCP
#                  execute path after the P27 metering fix; provider is the
#                  connection slug, "gfin")
# Which one is authoritative for the bill is an owner decision; this prints
# both, plainly labelled, so the decision is made on real rows. Money still
# lives in the ledger, not in either meter. Read-only: SELECTs only.
set -euo pipefail

URL="${DATABASE_URL:?DATABASE_URL is not set}"

have() {
  [ "$(psql "$URL" -Atc "select to_regclass('public.$1') is not null")" = "t" ]
}

if have usage_events; then
  echo "# meter: usage_events (app)"
  psql "$URL" -Atc \
    "SELECT to_char(occurred_at,'YYYY-MM')||'|'||provider||'|'||kind||'|'||units FROM usage_events WHERE provider ILIKE 'gfin%' ORDER BY occurred_at DESC LIMIT 100"
fi

if have usage_records; then
  echo "# meter: usage_records (runtime)"
  psql "$URL" -Atc \
    "SELECT to_char(created_at,'YYYY-MM')||'|'||provider||'|'||model||'|'||coalesce(total_tokens,0)||'|'||coalesce(cost_usd::text,'') FROM usage_records WHERE provider ILIKE 'gfin%' ORDER BY created_at DESC LIMIT 100"
fi

if ! have usage_events && ! have usage_records; then
  echo "no meter table in this database (usage_events, usage_records) - wrong DATABASE_URL" >&2
  exit 1
fi
