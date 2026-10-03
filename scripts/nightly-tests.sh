#!/usr/bin/env bash
# Nightly full test run for the fix/everything branch, started by the user unit useraid-nightly.service.
# Runs in a dedicated worktree so the working copy is never touched, always stops the test database
# on exit, keeps going after a failed step, and reports the result to Telegram. Never prints secrets.
set -u
REPO=/srv/projects/useRAIDfun/useRAID-fun
BRANCH=fix/everything
BASE=$HOME/.cache/useraid-nightly
WT=$BASE/wt
LOGS=$BASE/logs
DATE=$(date +%F)
LOG=$LOGS/$DATE.log
H=/home/rpandox/.local/bin/hermes
export PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
export PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/useraid-playwright
export DATABASE_URL=postgresql://useraid:useraid@127.0.0.1:55432/useraid_test
export COMPOSE_PROJECT_NAME=useraid-test COMPOSE_FILE=compose.yaml:compose.test.yaml
export PLAYWRIGHT_HTML_OPEN=never CI=1 NEXT_TELEMETRY_DISABLED=1
mkdir -p "$LOGS"
exec > >(tee -a "$LOG") 2>&1

COMPOSE=(docker compose -p useraid-test -f compose.yaml -f compose.test.yaml)
results=()
failed=0
notify() { HERMES_HOME=/home/rpandox/.hermes/profiles/vault "$H" send -t telegram -s "useraid nightly" "$1" >/dev/null 2>&1 || echo "nightly: telegram send failed" >&2; }
cleanup() {
  cd "$WT" 2>/dev/null && "${COMPOSE[@]}" down >/dev/null 2>&1
  echo "== $(date -Is) test database stopped"
  find "$LOGS" -maxdepth 1 -mtime +14 -exec rm -rf {} + 2>/dev/null
  local head msg
  head=$(git -C "$WT" rev-parse --short HEAD 2>/dev/null || echo unknown)
  if [ "$failed" -eq 0 ]; then
    msg="useraid nightly OK @ $head ($DATE): ${#results[@]} steps passed"
  else
    msg="useraid nightly FAILED @ $head ($DATE)"$'\n'"$(printf '%s\n' "${results[@]}" | grep -v ': ok')"$'\n'"log: $LOG"
  fi
  notify "$msg"
}
step() {
  local name=$1; shift
  echo "== $(date -Is) $name"
  if "$@"; then results+=("$name: ok"); else results+=("$name: FAILED"); failed=1; fi
}
if [ ! -d "$WT/.git" ] && [ ! -f "$WT/.git" ]; then
  mkdir -p "$BASE"
  git -C "$REPO" worktree add --detach "$WT" "$BRANCH" || { echo "worktree add failed"; failed=1; notify "useraid nightly: cannot create worktree"; exit 1; }
fi
cd "$WT" || exit 1
trap cleanup EXIT
echo "== $(date -Is) nightly start"
git checkout --detach "$BRANCH" || { failed=1; results+=("checkout: FAILED"); exit 1; }
git reset --hard "$BRANCH" >/dev/null
step "npm ci" npm ci
step "playwright chromium" npx playwright install chromium
step "prisma generate" npx prisma generate
step "database up" "${COMPOSE[@]}" up -d --wait db
if [ "$failed" -ne 0 ]; then echo "database or install failed; skipping the rest"; exit 1; fi
"${COMPOSE[@]}" exec -T db psql -U useraid -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname='useraid_test'" | grep -q 1 ||
  "${COMPOSE[@]}" exec -T db createdb -U useraid useraid_test
step "db migrate" npm run db:migrate
step "typecheck" npm run typecheck
step "format check" npm run format:check
step "lint" npm run lint
step "unit tests" npm test
step "db tests" env RUN_DB_TESTS=true DEMO_MODE=false npm test
step "build" npm run build
step "test:live" npm run test:live
step "browser (demo)" env PLAYWRIGHT_HTML_REPORT="$LOGS/$DATE-browser/report" npm run test:browser -- --reporter=list,html --output="$LOGS/$DATE-browser/traces"
step "browser (live)" env PLAYWRIGHT_HTML_REPORT="$LOGS/$DATE-browser-live/report" npm run test:browser:live -- --reporter=list,html --output="$LOGS/$DATE-browser-live/traces"
step "browser (studio)" env PLAYWRIGHT_HTML_REPORT="$LOGS/$DATE-browser-studio/report" npm run test:browser:studio -- --reporter=list,html --output="$LOGS/$DATE-browser-studio/traces"
echo "== $(date -Is) summary"
printf '%s\n' "${results[@]}"
[ "$failed" -eq 0 ]
