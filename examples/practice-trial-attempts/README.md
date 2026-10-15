# Independent durable practice-start host

Synthetic PostgreSQL16 consumer of the durable private canonical start contract. Node≥22.12 with declared locked pg8.23.1/Zod4.6.5/bs58 6.0.0/tsx4.23.15 and TypeScript5.9.3/Node types22.20.4. Canonical source/migration links are dereferenced into a separate source tree and own dependency installation:

```sh
consumer_dir=$(mktemp -d /tmp/raid-practice-attempt-consumer-XXXXXX)
cp -RL examples/practice-trial-attempts/. "$consumer_dir/"
cd "$consumer_dir"
npm ci --ignore-scripts
npm run typecheck
export NODE_ENV=test
export DATABASE_URL='postgresql://postgres:synthetic-only@127.0.0.1:YOUR_OWN_PORT/useraid_practice_attempt_host_test'
npm run migrate
npm start
```

Provision a fresh dedicated database on an owned loopback PostgreSQL16 first. URL guard rejects remote hosts, other names and production mode. One-time migration applies minimal User/Session schema, canonical immutable HUMAN mapping plus explicitly declared composite identity index, exact receipt/catalog/practice SQL and additive29 start SQL. It needs no Root installation/Prisma, real credential, live publisher/rubric/evaluator or provider. Fixture provisions invented accounts and an actual canonical HUMAN explicitly; the start command never autoprovisions identity. Do not rerun migration on an existing schema or use destructive cleanup as a migration strategy.

The host owns actual READ COMMITTED BEGIN/COMMIT/ROLLBACK, whole retries, bounded local current publisher policy and the pg driver. It publishes an invented safe unpaid definition via current scoped ADMIN/X session; a separate ordinary wallet learner starts against its actual canonical mapping. It verifies the real family attempt maximum, full immutable definition/rubric/tool consent, private read, original start replay after retirement/writes disabled, independent replacement of scoped publisher policy, preserved ordinary learner authority after publisher revocation, and denial after actual learner session deletion. Expected JSON consists of true synthetic/actualPostgreSQL/actualCanonicalHuman/canonicalFamilyLimit/originalStartAfterRetirementAndDisablement/ordinarySessionRevocationDenied and existing rubric/replay/policy/no-rank-effect checks.

All pools close in finally. The fixture owner stops only the owned PostgreSQL resource on every outcome and retains source/logs; no listener/preview is created. Time expectations remain expectations, no hard submission deadline is invented. Non-null accommodation references are explicitly unavailable until real scoped approved authority is stored. No submission/evaluation/assessment/rank/access/capacity/money/provider effect, Root API/UI or release approval is supplied. Actual content safety/provenance remains publisher responsibility; full T013/independent review/UAT/business/release NOT VERIFIED. See the same-change storage contract for operating, privacy, retry and recovery limits.
