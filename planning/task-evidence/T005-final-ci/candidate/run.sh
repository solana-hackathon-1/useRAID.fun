#!/bin/bash
set -uo pipefail
cd /tmp/raid-t005-final-source
export CI=1 NEXT_TELEMETRY_DISABLED=1 PLAYWRIGHT_HTML_OPEN=never
export DATABASE_URL=postgresql://useraid:useraid@127.0.0.1:5432/useraid_test DEMO_MODE=false
export COMPOSE_PROJECT_NAME=raid-t005-final COMPOSE_FILE=/tmp/raid-t005-candidate-evidence/compose.yaml
for cache in .next .next-db-down .next-studio; do
  if [ -d "$cache" ]; then mv "$cache" "/tmp/raid-t005-candidate-evidence/${cache#.}-previous" || exit 1; fi
done
failed=0
step() {
  local name=$1
  shift
  echo "Running $name"
  "$@" > "/tmp/raid-t005-candidate-evidence/$name.log" 2>&1
  local result=$?
  echo "$name: $result" | tee -a /tmp/raid-t005-candidate-evidence/results.txt
  if [ "$result" != 0 ]; then failed=1; tail -15 "/tmp/raid-t005-candidate-evidence/$name.log"; fi
  return "$result"
}
step install npm ci || exit 1
step generate npm run db:generate || exit 1
step planning python3 -m unittest discover -s tests -p 'test_raid_*.py' || true
step format npm run format:check || true
step routes npx next typegen || exit 1
step types npm run typecheck || true
step lint npm run lint || true
step security npm run audit:check || true
step migrations npm run db:migrate || exit 1
docker compose exec -T db psql -U useraid -d postgres -Atc "SELECT datname FROM pg_database" | awk '$0 == "useraid_shadow" {found=1} END {exit !found}' || docker compose exec -T db createdb -U useraid useraid_shadow || exit 1
step drift npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url postgresql://useraid:useraid@127.0.0.1:5432/useraid_shadow --exit-code || true
step tests env RUN_DB_TESTS=true npm test -- --reporter=default --reporter=junit --outputFile=/tmp/raid-t005-candidate-evidence/vitest.xml || true
step browser-install npx playwright install --with-deps chromium || exit 1
step demo npm run test:browser || true
mkdir -p /tmp/raid-t005-candidate-evidence/demo-reports
cp -R test-results /tmp/raid-t005-candidate-evidence/demo-reports/ || exit 1
step studio env DATABASE_URL=postgresql://useraid:useraid@127.0.0.1:5432/useraid_studio_test npm run test:browser:studio || true
mkdir -p /tmp/raid-t005-candidate-evidence/studio-reports
cp -R test-results /tmp/raid-t005-candidate-evidence/studio-reports/ || exit 1
step build npm run build || exit 1
step live-flow npm run test:live || true
step live-browser npm run test:browser:live || true
mkdir -p /tmp/raid-t005-candidate-evidence/live-browser-reports
cp -R test-results /tmp/raid-t005-candidate-evidence/live-browser-reports/ || exit 1
exit "$failed"
