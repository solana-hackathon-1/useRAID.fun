# Independently installed private practice review reader

This synthetic minimal PostgreSQL host consumes the canonical reviewer reader/current assignment/private submission modules without Next.js, Prisma, Root auth globals or Root node_modules. It creates actual synthetic canonical history and explicitly assigns one finite submission/purpose to a distinct evaluator. Actual current policy permits the exact private submission/full original definition and rubric, with ownership still UNCONFIRMED. An admin without the assignment causes zero private-column queries; current policy denial and revocation return no private result. Each authorized attempt creates an identifier-only private access receipt/audit before body selection, with no business mutation/outbox. Returned accessId is its opaque correlation ID, never permission. Denied initial reads create no access record. It never executes stored answers, fetches URLs or supplies rank.

The host explicitly owns account/session/HUMAN and prior31DDL, real pg READ_COMMITTED transactions, rollback/whole deadlock retries, current scoped synchronous management/read policy, DB clock and driver lifetime. Local5s statement/2s lock/5s idle bounds are asserted against actual PostgreSQL. These are synthetic technical limits, not production operating policy. Canonical module/contract/migration symlinks keep one source; dereference them for standalone use. Source, schema, fixture creation, current authorization and dependencies are visible in this directory.

Use Node>=22.12, PostgreSQL16 and a fresh dedicated local database named useraid_practice_review_read_host_test. The host accepts only loopback/localhost and rejects NODE_ENV=production. Never point it at real records or issue real reviewer appointments.

```sh
cp -RL examples/practice-review-reads /tmp/raid-review-read-example
cd /tmp/raid-review-read-example
npm ci
npm run typecheck
DATABASE_URL=postgresql://postgres:synthetic-only@127.0.0.1:5432/useraid_practice_review_read_host_test npm run migrate
DATABASE_URL=postgresql://postgres:synthetic-only@127.0.0.1:5432/useraid_practice_review_read_host_test npm start
```

Credentials/port are examples for a dedicated fixture. Independent verification must install this package's own declared dependencies; a Root node_modules symlink is insufficient. Replace local policy only with another current approved exact-scope implementation and preserve current actor/grant/expiry/revocation checks in the same transaction, immutable original receipts and consent, and no body logging/public caching. This is a server module consumer, not an HTTP/browser implementation or independent/UAT/business/release acceptance. No actual ownership/assessment decision, real operating approval, grade/calibration/retention policy or Root enablement is supplied. See ../../docs/raid-practice-review-reads.md for public contracts, errors and recovery.
