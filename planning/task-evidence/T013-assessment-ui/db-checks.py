import subprocess,sys
from pathlib import Path
e=Path.cwd()/'planning/task-evidence/T013-assessment-ui'
args=['node_modules/.bin/vitest','run','tests/practice-assessment-context.test.ts','tests/practice-assessment-client.test.ts','tests/practice-assessment-editor.test.ts','tests/practice-assessment-page.test.ts','tests/practice-assessment-http.test.ts','tests/practice-assessment-http-host.test.ts','tests/practice-trial-assessment-db.test.ts','tests/practice-assessment-decision-db.test.ts','tests/practice-trial-assessment-host.test.ts','tests/practice-assessment-decision-host.test.ts','tests/practice-trial-assessment-boundary.test.ts','tests/practice-assessment-decision-boundary.test.ts','tests/own-skill-assessment-db.test.ts','tests/shared-contracts.test.ts']
with (e/'affected.log').open('w') as out:r=subprocess.run(args,stdout=out,stderr=subprocess.STDOUT)
print('affected',r.returncode,flush=True)
if r.returncode:raise SystemExit(r.returncode)
raise SystemExit(subprocess.run([sys.executable,str(e/'verify-run.py')]).returncode)
