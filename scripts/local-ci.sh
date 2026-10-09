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
cleanup() {
  docker compose stop db >> "$LOG_DIR/cleanup.log" 2>&1 || true
}
trap cleanup EXIT
{ git rev-parse HEAD; git diff --binary HEAD; node --version; python3 --version; } > "$LOG_DIR/candidate.txt"
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
step browser-install npx playwright install chromium || exit 1
step demo npm run test:browser || true
step studio env DATABASE_URL=postgresql://useraid:useraid@127.0.0.1:55432/useraid_studio_test npm run test:browser:studio || true
step build npm run build || true
step live-flow npm run test:live || true
step live-browser npm run test:browser:live || true
# Retain reports and logs, including failures. No messaging or deployment.
cp -R test-results playwright-report "$LOG_DIR/" 2>/dev/null || true
echo "Evidence: $LOG_DIR"
exit "$failed"
