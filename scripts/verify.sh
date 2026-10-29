#!/usr/bin/env bash
# Local-first verification for coding agents (DEC-2026-10-27-01).
#   verify.sh fast     format (changed files), types, lint, planning contracts, non-database unit tests
#   verify.sh full     fast tier, then scripts/local-ci.sh plus the affected feature browser suites
#   verify.sh install  opt in to the pre-push hook (git config core.hooksPath .githooks)
# A passing run writes .git/raid-verify/<tree-sha>.json. The receipt is a local pre-screen only; the
# manually dispatched Checks workflow remains the independent verification.
set -uo pipefail
cd "$(dirname "$0")/.."
tier=${1:-fast}

if [ "$tier" = install ]; then
  git config core.hooksPath .githooks && echo "pre-push verification enabled (core.hooksPath=.githooks); disable with: git config --unset core.hooksPath"
  exit $?
fi
case "$tier" in fast | full) ;; *) echo "usage: verify.sh fast|full|install" >&2; exit 64 ;; esac

# A receipt describes a committed tree; refuse to certify uncommitted tracked changes.
# The session checkpoint is rewritten at session end and never affects behaviour, so it is excluded.
# Browser suites rewrite two tracked screenshots as a side effect; neither affects behaviour.
clean() { git diff --quiet HEAD -- . ':!docs/ai-handoff/CURRENT.md' ':!artifacts/raid-live-fixture.png' ':!planning/task-evidence/*/browser-development/*'; }
if ! clean; then
  echo "Tracked changes are uncommitted; commit them first so the receipt matches the tree you push." >&2
  exit 2
fi
tree=$(git rev-parse 'HEAD^{tree}') || exit 2
head=$(git rev-parse HEAD) || exit 2
base=$(git merge-base HEAD origin/main 2> /dev/null || git merge-base HEAD main 2> /dev/null || echo "$head")

failed=0
timings=""
step() {
  local name=$1 started=$SECONDS
  shift
  echo "== $name"
  "$@"
  local result=$? took=$((SECONDS - started))
  echo "-- $name: exit $result in ${took}s"
  timings="$timings${timings:+,}\"$name\":$took"
  if [ "$result" -ne 0 ]; then failed=1; fi
  return 0
}
format_changed() {
  local files=() file target root
  root=$(pwd -P)
  while IFS= read -r file; do
    [ -f "$file" ] || continue
    if [ -L "$file" ]; then
      # Prettier refuses symbolic links: check an in-repo target instead; a link leaving the repo is not ours to format.
      target=$(readlink -f "$file") || continue
      case "$target" in "$root"/*) files+=("${target#"$root"/}") ;; esac
    else
      files+=("$file")
    fi
  done < <(git diff --name-only --diff-filter=d "$base" HEAD)
  if [ "${#files[@]}" -eq 0 ]; then echo "no changed files to format-check"; return 0; fi
  npx prettier --check --ignore-unknown "${files[@]}"
}

fast_tier() {
  step planning python3 -m unittest discover -s tests -p 'test_raid_*.py'
  step format format_changed
  step types npm run typecheck
  step lint npm run lint
  step unit npx vitest run
}

feature_suites() {
  python3 scripts/ci-browser-scope.py | tail -n 1 | python3 -c '
import json, sys
suites = json.load(sys.stdin)["suites"]
print(" ".join(s for s in suites if s not in {"demo", "studio", "live"}))'
}

fast_tier
if [ "$tier" = full ]; then
  RAID_CI_FEATURE_SUITES=""
  if [ "${RAID_VERIFY_FEATURE_BROWSERS:-1}" != 0 ]; then RAID_CI_FEATURE_SUITES=$(feature_suites) || failed=1; fi
  export RAID_CI_FEATURE_SUITES
  step local-ci bash scripts/local-ci.sh
fi

# The tree must not have moved while the checks ran.
if ! clean || [ "$(git rev-parse 'HEAD^{tree}')" != "$tree" ]; then
  echo "Tracked files changed during verification; no receipt issued." >&2
  failed=1
fi
result=pass
if [ "$failed" -ne 0 ]; then result=fail; fi
receipts=$(git rev-parse --git-path raid-verify)
mkdir -p "$receipts"
printf '{"tier":"%s","result":"%s","tree":"%s","head":"%s","seconds":{%s}}\n' \
  "$tier" "$result" "$tree" "$head" "$timings" > "$receipts/$tree.json"
echo "verify $tier: $result (receipt $receipts/$tree.json)"
exit "$failed"
