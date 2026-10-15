import subprocess
commands=[['node_modules/.bin/vitest','run','tests/practice-trial-storage-db.test.ts','tests/practice-trial-storage-boundary.test.ts','tests/practice-trials-host.test.ts','tests/practice-trial-attempt-db.test.ts','tests/practice-trial-submission-db.test.ts'],['node_modules/.bin/vitest','run','tests/command-receipts-boundary.test.ts','-t','minimal external host']]
for command in commands:subprocess.run(command,check=True)
