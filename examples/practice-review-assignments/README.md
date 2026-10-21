# Independently installed scoped practice review assignment host

This synthetic minimal PostgreSQL host consumes the canonical assignment module without Next.js, Prisma, Root auth globals or Root node_modules. It creates synthetic account/session/HUMAN/catalog/definition/start/private-submission records using actual SQL and canonical commands, then explicitly issues one OWNERSHIP_REVIEW appointment to a distinct evaluator with a finite expiry and current scoped admin policy. It checks designated evaluator/session, wrong-purpose and admin-without-assignment denial, injected policy denial, immutable revocation and original issue replay with new writes disabled. The submission stays UNCONFIRMED. The assignment port does not read private answers or execute submitted code. The host also wraps the same commands in the portable `skills/practice-review-assignment-http.ts` administrator transport (strict v1 POST bodies, `Idempotency-Key` replay, key-reuse conflict, immutable revoke) with its own injected origin, actor and quota stubs; real deployments must supply an actual X-administrator actor and CSRF/origin check.

Host dependencies are explicit in schema.sql, participant-index.sql, migrations/, connection.ts, host.ts and package.json. The host owns a READ_COMMITTED transaction/rollback/whole-deadlock retries, current User/Session/Participant records, the database clock, approved scoped synchronous management/use policies, and real pg connection. Transaction-local5s statement/2s lock/5s idle limits are asserted against the actual server. These synthetic technical bounds are not production policy. Canonical module/contract/migration symlinks keep one source; copy while dereferencing all links for standalone use.

Use Node>=22.12 and a fresh dedicated local PostgreSQL16 database named useraid_practice_review_host_test. Only localhost/loopback is accepted and NODE_ENV=production is rejected. Do not use a live database or real evaluator appointments.

```sh
cp -RL examples/practice-review-assignments /tmp/raid-review-example
cd /tmp/raid-review-example
npm ci
npm run typecheck
DATABASE_URL=postgresql://postgres:synthetic-only@127.0.0.1:5432/useraid_practice_review_host_test npm run migrate
DATABASE_URL=postgresql://postgres:synthetic-only@127.0.0.1:5432/useraid_practice_review_host_test npm start
```

The password/port are synthetic examples; supply only the dedicated fixture values. No Root dependency symlink is sufficient evidence: verification installs this package independently. Policies can be replaced by another approved synchronous exact-scope implementation; keep current server checks, original immutable receipts/authority bindings and deny-default behavior. No seed/flag creates real operating authority. Retention, approved evaluator operating model, grading calibration, private protected review reads and actual ownership/assessment decisions remain separate dependencies. See ../../docs/raid-practice-review-assignments.md for errors, lock order, operational health and rollback contracts.
