#!/bin/bash
set -uo pipefail
cd /tmp/raid-t005-final-source
export CI=1 NEXT_TELEMETRY_DISABLED=1 PLAYWRIGHT_HTML_OPEN=never DEMO_MODE=false
export DATABASE_URL=postgresql://useraid:useraid@127.0.0.1:5432/useraid_studio_test
failed=0
run() {
 name=$1
 shift
 "$@" > /tmp/raid-t005-candidate-evidence/$name.log 2>&1
 result=$?
 echo "$name: $result"
 if [ "$result" != 0 ]; then failed=1; fi
 mkdir -p /tmp/raid-t005-candidate-evidence/$name-reports
 cp -R test-results /tmp/raid-t005-candidate-evidence/$name-reports/ || exit 1
}
run demo-desktop-retest npx playwright test --project=desktop --retries=0 --grep 'raid detail leads to the exact token|/methodology loads cleanly'
run demo-mobile-retest npx playwright test --project=mobile --retries=0 --grep '^.* / loads cleanly$'
run studio-mobile-retest npx playwright test --config=playwright.studio.config.ts --project=mobile --retries=0 --grep 'approved creator.* /creator/new loads cleanly'
exit "$failed"
