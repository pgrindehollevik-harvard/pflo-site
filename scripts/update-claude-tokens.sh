#!/usr/bin/env bash
# Refresh claude-tokens.json from local Claude Code usage, then commit + push.
# Run manually, or wire into launchd/cron. Safe to run repeatedly: only commits
# when the numbers actually change.
#
#   ./scripts/update-claude-tokens.sh           # update + commit + push
#   PUSH=0 ./scripts/update-claude-tokens.sh    # update + commit, no push
#   COMMIT=0 ./scripts/update-claude-tokens.sh  # just rewrite the json
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
OUT="$REPO_ROOT/claude-tokens.json"

cd "$REPO_ROOT"

# Sync with the remote before regenerating. main may have advanced from another
# checkout (e.g. ~/Documents/pflo edits), so this keeps our push fast-forwardable
# and the job self-healing rather than failing on a non-ff push.
if [ "${COMMIT:-1}" = "1" ] && [ "${PUSH:-1}" = "1" ]; then
  git pull --rebase --autostash origin "$(git rev-parse --abbrev-ref HEAD)" >/dev/null 2>&1 || true
fi

# ccusage reads ~/.claude/projects/*.jsonl and aggregates token usage.
USAGE_JSON="$(npx ccusage@latest --json 2>/dev/null)"

UPDATED="$(date +%Y-%m-%d)" python3 - "$OUT" <<'PY' <<<"$USAGE_JSON"
import json, os, sys
out_path = sys.argv[1]
data = json.load(sys.stdin)
totals = data["totals"]
payload = {
    "totalTokens": int(totals["totalTokens"]),
    "totalCost": float(totals["totalCost"]),
    "updated": os.environ["UPDATED"],
}
with open(out_path, "w") as f:
    json.dump(payload, f, indent=2)
    f.write("\n")
print(f"tokens={payload['totalTokens']:,}  cost=${payload['totalCost']:,.0f}")
PY

cd "$REPO_ROOT"
if [ "${COMMIT:-1}" != "1" ]; then
  echo "COMMIT=0 set, leaving working tree dirty."
  exit 0
fi
if git diff --quiet -- "$OUT"; then
  echo "No change to claude-tokens.json, nothing to commit."
  exit 0
fi

git add "$OUT"
git commit -m "Update Claude token counter" >/dev/null
echo "Committed."
if [ "${PUSH:-1}" = "1" ]; then
  git push
  echo "Pushed."
fi
