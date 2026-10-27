#!/usr/bin/env bash
# Run in a dedicated candidate checkout. Requires Node 22, Python 3.12, Docker,
# browser system dependencies and available ports 3000/3001/3006/3007/3008/55432.
set -uo pipefail
cd "$(dirname "$0")/.."
export CI=1 NEXT_TELEMETRY_DISABLED=1 PLAYWRIGHT_HTML_OPEN=never
export COMPOSE_FILE=${RAID_CI_COMPOSE_FILE:-compose.yaml:compose.test.yaml}
export COMPOSE_PROJECT_NAME=raid-local-ci
export DATABASE_URL=postgresql://useraid:useraid@127.0.0.1:55432/useraid_test
export DEMO_MODE=false
LOG_DIR=${RAID_CI_LOG_DIR:-/tmp/raid-local-ci-$(date +%Y%m%d-%H%M%S)}
mkdir -p "$LOG_DIR"
failed=0
database_attempted=0
step() {
  local name=$1
  shift
  echo "Running $name"
  "$@" > "$LOG_DIR/$name.log" 2>&1
  local result=$?
  echo "$name: $result" | tee -a "$LOG_DIR/results.txt"
  if [ "$result" -ne 0 ]; then failed=1; tail -n 15 "$LOG_DIR/$name.log"; fi
  return "$result"
}
browser_step() {
  local name=$1
  shift
  step "$name" "$@"
  local result=$? report
  # Playwright replaces shared output directories when the next suite starts.
  for report in test-results playwright-report; do
    if [ -d "$report" ]; then
      if ! mkdir -p "$LOG_DIR/$name-reports" || ! cp -R "$report" "$LOG_DIR/$name-reports/"; then
        echo "Failed to retain $name reports" | tee -a "$LOG_DIR/results.txt"
        failed=1
        return 1
      fi
    fi
  done
  return "$result"
}
skip() {
  echo "$1: NOT RUN ($2)" | tee -a "$LOG_DIR/results.txt"
  failed=1
}
ports() {
  local busy=0 port host
  for port in 3000 3001 3006 3007 3008 55432; do
    for host in 127.0.0.1 ::1; do
      if (exec 3<>"/dev/tcp/$host/$port") 2> /dev/null; then
        echo "port $port is already in use on $host"
        busy=1
      fi
    done
  done
  return "$busy"
}
cleanup() {
  local exit_status=$? cleanup_status
  trap - EXIT
  if [ "$database_attempted" = 1 ]; then
    docker compose stop db >> "$LOG_DIR/cleanup.log" 2>&1
    cleanup_status=$?
    echo "cleanup: $cleanup_status" | tee -a "$LOG_DIR/results.txt"
    if [ "$cleanup_status" -ne 0 ]; then exit_status=1; fi
  fi
  # Retain reports and logs on every exit path, including failures. No messaging or deployment.
  cp -R test-results playwright-report "$LOG_DIR/" 2>/dev/null || true
  echo "Evidence: $LOG_DIR"
  exit "$exit_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
{ git rev-parse HEAD; git diff --binary HEAD; node --version; python3 --version; } > "$LOG_DIR/candidate.txt"
step ports ports || exit 1
step install npm ci || exit 1
step generate npm run db:generate || exit 1
step planning python3 -m unittest discover -s tests -p 'test_raid_*.py' || true
step format npm run format:check || true
# Preserve old generated route caches outside TypeScript discovery.
for cache in .next .next-db-down .next-studio; do
  if [ -d "$cache" ]; then mv "$cache" "$LOG_DIR/${cache#.}-previous" || exit 1; fi
done
step routes npx next typegen || exit 1
step types npm run typecheck || true
step lint npm run lint || true
step security npm run audit:check || true
# A failed start may leave a container running; clean up only after our attempt.
database_attempted=1
step database docker compose up -d --wait db || exit 1
for name in useraid_test useraid_shadow; do
  exists=$(docker compose exec -T db psql -U useraid -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname='$name'") || exit 1
  if [ "$exists" != 1 ]; then docker compose exec -T db createdb -U useraid "$name" || exit 1; fi
done
step migrations npm run db:migrate || exit 1
step drift npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url postgresql://useraid:useraid@127.0.0.1:55432/useraid_shadow --exit-code || true
step tests env RUN_DB_TESTS=true npm test -- --reporter=default --reporter=junit --outputFile="$LOG_DIR/vitest.xml" || true
if step docker docker build -t useraid:local-ci .; then
step runtime docker run --rm useraid:local-ci node -e "require.resolve('prisma/package.json'); require.resolve('tsx/package.json'); require.resolve('@prisma/client/package.json')" || true
step runtime-files docker run --rm useraid:local-ci sh -c 'test ! -d /app/tests && test -d /app/prisma/migrations && test -f /app/src/worker.ts && npx prisma --version' || true
else
  echo "runtime/runtime-files: NOT RUN (image build failed)" | tee -a "$LOG_DIR/results.txt"
fi
if step browser-install npx playwright install chromium; then browsers=1; else browsers=0; fi
if [ "$browsers" = 1 ]; then
  browser_step demo npm run test:browser || true
  browser_step studio env DATABASE_URL=postgresql://useraid:useraid@127.0.0.1:55432/useraid_studio_test npm run test:browser:studio || true
  # Affected feature suites chosen by scripts/verify.sh (development mode); hosted Checks adds production mode.
  for suite in ${RAID_CI_FEATURE_SUITES:-}; do
    if [[ "$suite" =~ ^[a-z]+(-[a-z]+)*$ ]] && [ -f "playwright.$suite.config.ts" ]; then
      browser_step "feature-$suite" npx playwright test --config="playwright.$suite.config.ts" || true
    else
      skip "feature-$suite" "unknown suite name"
    fi
  done
else
  skip demo "locked Chromium unavailable"
  skip studio "locked Chromium unavailable"
fi
step build npm run build || true
if [ "$browsers" = 1 ]; then
  step live-flow npm run test:live || true
  browser_step live-browser npm run test:browser:live || true
else
  skip live-flow "locked Chromium unavailable"
  skip live-browser "locked Chromium unavailable"
fi
exit "$failed"
