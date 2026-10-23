# Independently installed actual review-policy source host

This synthetic minimal PostgreSQL host consumes the actual policy publisher/private admin history/current scoped reviewer observation and exact expected-version lookup. No Next.js, Prisma, Root auth globals, Root node_modules or real operating approval is used. Actual immutable policy data is scoped to the original accepted definition version and purpose, with one canonical family, current approval/withdrawal/reapproval and preserved history/receipts. A guessed version label or another scope cannot stand in for this source. Initial observation needs only the actual case/assignment/purpose; a later decision lookup requires exact expected current reference. Outputs do not confirm ownership, grade skill or grant permission.

The host declares real account/session/HUMAN/prior32 SQL, current X-admin/scoped publication and actual assigned evaluator/session/read policy, READ_COMMITTED transaction/rollback/whole retries, DB clock and pg/runtime/types. Private access is audited before body/guidance and only delivered after COMMIT; audits are authorized-attempt metadata, not proof of delivery. Local5s statement/2s lock/5s idle bounds are asserted against actual PostgreSQL. Technical limits and synthetic text are not production calibration or operating terms. Canonical symlinks retain one source and must be dereferenced for standalone copying.

Use Node>=22.12 and a fresh dedicated PostgreSQL16 database named useraid_practice_review_policy_host_test, accepting only localhost/loopback and rejecting NODE_ENV=production. No live records or actual approvals may be used.

```sh
cp -RL examples/practice-review-policies /tmp/raid-review-policy-example
cd /tmp/raid-review-policy-example
npm ci
npm run typecheck
DATABASE_URL=postgresql://postgres:synthetic-only@127.0.0.1:5432/useraid_practice_review_policy_host_test npm run migrate
DATABASE_URL=postgresql://postgres:synthetic-only@127.0.0.1:5432/useraid_practice_review_policy_host_test npm start
```

Credentials/port are synthetic examples; supply only dedicated fixture values. Install this package independently; a Root dependency symlink is insufficient proof. Replace pg or approved current scope predicates only while preserving actual source/identity/transaction/current-version/audit/failure contracts. Policy publication is platform data approval, not staffed operating/legal/calibration/release sign-off; no actual policy content is seeded. Original definition/rubric/tool/pass conditions take precedence. O09 calibration/O11 retention/operating approval, actual ownership/assessment decisions/projections/APIs/UI/independent/UAT/business/release acceptance remain separate obligations. See ../../docs/raid-practice-review-policies.md for public contracts and recovery.

Assignment storage retains its public exports while declaring the canonical pure `practice-review-assignment-contracts.ts` and `practice-review-assignment-management-contracts.ts` links. Dereference these links with the other source when copying this host; no additional package or implicit Root dependency is introduced.
