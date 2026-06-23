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
# Write to a temp file and pass its path as an argument: the python program
# below is fed on stdin via the heredoc, so the usage JSON can't also go on
# stdin (the last stdin redirection would win and clobber the program).
USAGE_FILE="$(mktemp)"
trap 'rm -f "$USAGE_FILE"' EXIT
npx ccusage@latest --json 2>/dev/null > "$USAGE_FILE"

UPDATED="$(date +%Y-%m-%d)" python3 - "$OUT" "$USAGE_FILE" <<'PY'
import json, os, sys
out_path, usage_path = sys.argv[1], sys.argv[2]
with open(usage_path) as f:
    data = json.load(f)
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
