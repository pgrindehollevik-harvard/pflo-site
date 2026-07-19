#!/usr/bin/env bash
# Refresh openai-tokens.json from the OpenAI Usage API, then commit + push.
# Run manually, or wire into launchd/cron. Safe to run repeatedly: only commits
# when the numbers actually change.
#
# Needs an Admin API key (sk-admin-...), NOT a regular sk-proj-... key:
#   https://platform.openai.com/settings/organization/admin-keys
#
# The key is never stored in this repo or in the launchd plist. It comes from
# the login keychain, or from the environment for one-off manual runs. Store it
# once (the -w with no value prompts, so it stays out of shell history):
#
#   security add-generic-password -a "$USER" -s pflo-openai-admin-key -w
#
#   ./scripts/update-openai-tokens.sh                # keychain, update + push
#   PUSH=0 ./scripts/update-openai-tokens.sh         # no push
#   COMMIT=0 ./scripts/update-openai-tokens.sh       # just rewrite the json
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
OUT="$REPO_ROOT/openai-tokens.json"
KEYCHAIN_SERVICE="${OPENAI_KEYCHAIN_SERVICE:-pflo-openai-admin-key}"

# Environment wins for manual runs; otherwise fall back to the keychain so the
# scheduled job has no secret sitting in plaintext anywhere on disk.
if [ -z "${OPENAI_ADMIN_KEY:-}" ]; then
  OPENAI_ADMIN_KEY="$(security find-generic-password -w -s "$KEYCHAIN_SERVICE" 2>/dev/null || true)"
fi
if [ -z "${OPENAI_ADMIN_KEY:-}" ]; then
  echo "No admin key found. Store one (prompts, so it stays out of shell history):" >&2
  echo "  security add-generic-password -a \"\$USER\" -s $KEYCHAIN_SERVICE -w" >&2
  echo "...or set OPENAI_ADMIN_KEY in the environment for a one-off run." >&2
  exit 1
fi

cd "$REPO_ROOT"

# Sync with the remote before regenerating, matching update-claude-tokens.sh so
# the two jobs don't fight over a non-ff push.
if [ "${COMMIT:-1}" = "1" ] && [ "${PUSH:-1}" = "1" ]; then
  git pull --rebase --autostash origin "$(git rev-parse --abbrev-ref HEAD)" >/dev/null 2>&1 || true
fi

# Sum input + output tokens across the trailing 365 days of daily usage buckets.
# The Usage API pages results, so we follow next_page until it's exhausted.
OPENAI_ADMIN_KEY="$OPENAI_ADMIN_KEY" UPDATED="$(date +%Y-%m-%d)" python3 - "$OUT" <<'PY'
import json, os, sys, time, urllib.parse, urllib.request

out_path = sys.argv[1]
key = os.environ["OPENAI_ADMIN_KEY"]
start_time = int(time.time()) - 365 * 24 * 3600
base = "https://api.openai.com/v1/organization/usage/completions"

total = 0
page = None
while True:
    params = {"start_time": start_time, "bucket_width": "1d", "limit": 31}
    if page:
        params["page"] = page
    req = urllib.request.Request(
        base + "?" + urllib.parse.urlencode(params),
        headers={"Authorization": "Bearer " + key},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        data = json.load(r)
    for bucket in data.get("data", []):
        for res in bucket.get("results", []):
            total += int(res.get("input_tokens", 0)) + int(res.get("output_tokens", 0))
    page = data.get("next_page")
    if not page:
        break

payload = {"totalTokens": total, "updated": os.environ["UPDATED"]}
with open(out_path, "w") as f:
    json.dump(payload, f, indent=2)
    f.write("\n")
print(f"tokens={total:,}")
PY

cd "$REPO_ROOT"
if [ "${COMMIT:-1}" != "1" ]; then
  echo "COMMIT=0 set, leaving working tree dirty."
  exit 0
fi
if git diff --quiet -- "$OUT" 2>/dev/null && [ -f "$OUT" ] && git ls-files --error-unmatch "$OUT" >/dev/null 2>&1; then
  echo "No change to openai-tokens.json, nothing to commit."
  exit 0
fi

git add "$OUT"
if git diff --cached --quiet -- "$OUT"; then
  echo "No change to openai-tokens.json, nothing to commit."
  exit 0
fi
git commit -m "Update OpenAI token counter" >/dev/null
echo "Committed."
if [ "${PUSH:-1}" = "1" ]; then
  git push
  echo "Pushed."
fi
