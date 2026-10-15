import subprocess
commands=[['node_modules/.bin/vitest','run','tests/own-skill-assessment-db.test.ts','tests/own-skill-assessment-http.test.ts','tests/own-skill-assessment-host.test.ts'],['python3','/tmp/raid-t013-own-assessment-view-browser-run.py','production'],['python3','/tmp/raid-t013-own-assessment-view-consumer-run.py'],['node_modules/.bin/vitest','run','tests/command-receipts-boundary.test.ts','-t','minimal external host']]
for command in commands:subprocess.run(command,check=True)
