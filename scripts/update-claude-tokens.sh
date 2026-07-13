#!/usr/bin/env bash
# Refresh claude-tokens.json, then commit + push. Run manually, or wire into
# launchd/cron. Safe to run repeatedly: only commits when the numbers change.
#
# Source of truth: the Anthropic Admin API usage/cost reports (org-wide, so it
# covers Claude Code on any machine, web sessions, cloud agents, and API apps).
# Needs an admin key in $ANTHROPIC_ADMIN_KEY or ~/.anthropic-admin-key
# (create one in Console -> Settings -> Admin keys). Without a key, falls back
# to ccusage, which only sees this machine's ~/.claude session logs.
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
import json, os, sys, urllib.parse, urllib.request

out_path, usage_path = sys.argv[1], sys.argv[2]

# Earliest date the Admin API is asked for. The org didn't exist before this;
# widen it if that ever turns out to be wrong.
START = "2025-01-01T00:00:00Z"
API = "https://api.anthropic.com/v1/organizations"


def admin_key():
    key = os.environ.get("ANTHROPIC_ADMIN_KEY", "").strip()
    if key:
        return key
    try:
        with open(os.path.expanduser("~/.anthropic-admin-key")) as f:
            return f.read().strip() or None
    except OSError:
        return None


def paged_buckets(endpoint, key):
    params = {"starting_at": START, "bucket_width": "1d", "limit": 31}
    while True:
        url = f"{API}/{endpoint}?{urllib.parse.urlencode(params)}"
        req = urllib.request.Request(url, headers={
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
        })
        with urllib.request.urlopen(req, timeout=60) as r:
            data = json.load(r)
        yield from data["data"]
        if not data.get("has_more"):
            return
        params["page"] = data["next_page"]


def org_totals(key):
    tokens = 0
    for bucket in paged_buckets("usage_report/messages", key):
        for r in bucket["results"]:
            cc = r.get("cache_creation") or {}
            tokens += (
                (r.get("uncached_input_tokens") or 0)
                + (r.get("cache_read_input_tokens") or 0)
                + (r.get("output_tokens") or 0)
                + (cc.get("ephemeral_1h_input_tokens") or 0)
                + (cc.get("ephemeral_5m_input_tokens") or 0)
            )
    cents = 0.0
    for bucket in paged_buckets("cost_report", key):
        for r in bucket["results"]:
            cents += float(r["amount"])  # lowest currency units (cents)
    return tokens, cents / 100.0


with open(usage_path) as f:
    local = json.load(f)["totals"]
local_tokens, local_cost = int(local["totalTokens"]), float(local["totalCost"])

key = admin_key()
tokens, cost, source = local_tokens, local_cost, "ccusage"
if key:
    try:
        tokens, cost = org_totals(key)
        source = "anthropic-admin-api"
        print(f"org api: {tokens:,} tokens / ${cost:,.0f}  "
              f"(local ccusage: {local_tokens:,} / ${local_cost:,.0f})")
    except Exception as e:
        print(f"admin api failed ({e}), falling back to ccusage", file=sys.stderr)
else:
    print("no admin key found, using local ccusage totals", file=sys.stderr)

payload = {
    "totalTokens": tokens,
    "totalCost": cost,
    "source": source,
    "updated": os.environ["UPDATED"],
}
with open(out_path, "w") as f:
    json.dump(payload, f, indent=2)
    f.write("\n")
print(f"tokens={payload['totalTokens']:,}  cost=${payload['totalCost']:,.0f}  source={source}")
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
