import subprocess
commands=[['node_modules/.bin/vitest','run','tests/practice-review-assignment-db.test.ts','tests/practice-review-assignment-boundary.test.ts','tests/practice-review-assignment-host.test.ts','tests/practice-trial-submission-db.test.ts','tests/practice-trial-submission-boundary.test.ts','tests/practice-trial-submission-host.test.ts'],['node_modules/.bin/vitest','run','tests/command-receipts-boundary.test.ts','-t','minimal external host']]
for command in commands:subprocess.run(command,check=True)
