# Independent practice-definition PostgreSQL host

Synthetic PostgreSQL16 CLI consumer of [authorized immutable practice storage](../../docs/raid-practice-trial-storage.md). Own dependencies are pinned: Node≥22.12, pg8.23.1, Zod4.6.5, bs58 6.0.0, tsx4.23.15, TypeScript5.9.3 and Node types22.20.4. Relative source/migration links resolve to canonical files. Copy with dereferencing for a separate source tree and dependency installation:

```sh
consumer_dir=$(mktemp -d /tmp/raid-practice-storage-consumer-XXXXXX)
cp -RL examples/practice-trial-storage/. "$consumer_dir/"
cd "$consumer_dir"
npm ci --ignore-scripts
npm run typecheck
export NODE_ENV=test
export DATABASE_URL='postgresql://postgres:synthetic-only@127.0.0.1:YOUR_OWN_PORT/useraid_practice_host_test'
npm run migrate
npm start
```

Provision a fresh dedicated database `useraid_practice_host_test` on your own loopback PostgreSQL16 fixture first. URL validation rejects other names, remote hosts and production mode. `migrate` applies the minimal owned User/Session schema then exact canonical receipt, taxonomy and practice migrations once to a fresh schema. It does not need Root Prisma, a Root installation, real accounts or provider credentials. No real rubric/publisher/evaluator is seeded. The fixture uses invented safe public/synthetic unpaid content only.

The driver supplies actual READ COMMITTED BEGIN/COMMIT/ROLLBACK, bounded whole retries and explicit transaction port. The host creates a synthetic unrestricted ADMIN/live X session and scoped local policy, publishes an actual catalog and practice revision, retires it, verifies exact original replay with writes disabled, reads original history, rejects changed global rubric content and denies replay after current policy removal. Switching Set to current array policy proves the callback is replaceable while preserving authorization. Expected JSON has true for `synthetic`, `actualPostgreSQL`, `immutableGlobalRubric`, `originalReceiptAfterRetirement`, `alternateScopedPolicy`, `currentRevocationDenied` and `noRankGrantCapacityOrMoney`.

CLI pools close in finally on success/failure. The fixture owner stops only its own PostgreSQL server/container after all checks and retains logs/source/data as required. Re-running requires a new empty fixture database; migration is not destructive cleanup. No listener, Root API/UI, actual trial attempt, assessment/evaluator grant, money/provider or production safety approval is supplied. Full T013, independent review, representative UAT and live rollout remain NOT VERIFIED. A purpose tag alone cannot validate source bytes. Preserve current authority, immutable global references, actual SQL guards, original receipts/private audit and whole transaction semantics when substituting a host; see the contract for recovery and retention limits.

The current CLI also verifies stored Unicode parity: a padded100-symbol supplementary title normalizes to the exact200UTF16-unit bound, while101symbols returns INVALID_INPUT before storage. Original authorized receipt replay remains exact. Actual transaction-local5s statement/2s lock/5s idle bounds are asserted against the live fixture; these are synthetic host technical settings, not production policy. Pure definition schemas keep their installed codepoint semantics; concrete stored publication uses the documented UTF16 SQL contract.
