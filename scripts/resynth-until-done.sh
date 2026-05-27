#!/usr/bin/env bash
# Loop /api/resynth against a given CSV until 0 stubs remain or quota is depleted.
#
# Usage:
#   ./scripts/resynth-until-done.sh "Songfinch_kickoff_view (1).csv"
#
# Why this exists: Vercel functions max out at 300s. One resynth call can only
# process ~50-100 artists before timeout. For a 257-stub backlog you'd need to
# fire the curl ~3-5 times manually. This script does it for you and stops
# when there's no progress (i.e., LLMs are all rate-limited).

set -euo pipefail

CSV_NAME="${1:-}"
APP_URL="${APP_URL:-https://artist-manager-rho.vercel.app}"
MAX_PASSES="${MAX_PASSES:-20}"

if [[ -z "$CSV_NAME" ]]; then
  echo "Usage: $0 \"<csv_name>\""
  echo "Example: $0 \"Songfinch_kickoff_view (1).csv\""
  exit 1
fi

count_stubs() {
  # Quick "stub still exists" probe via the public reports endpoint.
  # Counts reports whose summary contains the stub-fallback marker.
  curl -s "${APP_URL}/api/reports?csv_name=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$CSV_NAME")" \
    | python3 -c '
import json, sys
d = json.load(sys.stdin)
stubs = 0
for r in d.get("reports", []):
    s = r.get("summary") or ""
    if "AI synthesis unavailable" in s:
        stubs += 1
print(stubs)
'
}

prev=-1
for pass in $(seq 1 "$MAX_PASSES"); do
  stubs=$(count_stubs)
  echo "[$(date +%H:%M:%S)] pass $pass — $stubs stubs remaining"

  if [[ "$stubs" -eq 0 ]]; then
    echo "Done — no stubs left."
    exit 0
  fi

  if [[ "$pass" -gt 1 && "$stubs" -eq "$prev" ]]; then
    echo "No progress on last pass — LLMs likely exhausted. Try again after midnight Pacific (Gemini reset) or in an hour (Groq TPD reset)."
    exit 1
  fi
  prev="$stubs"

  # Fire one resynth pass. Output goes through grep so the terminal isn't
  # spammed with the giant report JSON payloads — just outcomes.
  curl -s -N -X POST "${APP_URL}/api/resynth" \
    -H 'Content-Type: application/json' \
    -d "$(python3 -c "import json,sys; print(json.dumps({'csv_name': sys.argv[1]}))" "$CSV_NAME")" \
    | grep -oE '"type":"(report|error|done)"[^}]*"artist":"[^"]+"' \
    | sed 's/.*"artist":"\([^"]*\)".*/  \1/' \
    | head -100
done

echo "Hit MAX_PASSES=$MAX_PASSES — stop and re-run if needed."
