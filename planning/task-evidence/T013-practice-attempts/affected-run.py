import subprocess
commands=[['node_modules/.bin/vitest','run','tests/practice-trial-attempt-db.test.ts','tests/practice-trial-attempt-boundary.test.ts','tests/practice-trial-attempt-host.test.ts','tests/practice-trial-storage-db.test.ts','tests/skill-taxonomy-db.test.ts','tests/skill-claim-storage-db.test.ts','tests/command-receipts-db.test.ts','tests/skill-taxonomy-editor-db.test.ts'],['node_modules/.bin/vitest','run','tests/command-receipts-boundary.test.ts','-t','minimal external host']]
for command in commands:subprocess.run(command,check=True)
