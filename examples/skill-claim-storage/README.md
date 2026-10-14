# Independent private canonical skill claim host

Synthetic Node≥22.12 / PostgreSQL16 CLI fixture for [private claim storage](../../docs/raid-skill-claim-storage.md). Declares pg8.23.1, Zod4.6.5, bs586.0.0, tsx4.23.15 and its own locked install. Minimal User/Session schema, actual canonical HUMAN migration, composite ownership index, shared receipts and real catalog/claim migrations are explicit dependencies. No RAID global, root Prisma, production credential or remote provider is used.

```sh
consumer_dir=$(mktemp -d /tmp/raid-skill-claim-consumer-XXXXXX)
cp -RL examples/skill-claim-storage/. "$consumer_dir/"
cd "$consumer_dir"
npm ci
export NODE_ENV=test
export DATABASE_URL='postgresql://postgres:synthetic-only@127.0.0.1:YOUR_OWN_PORT/useraid_skill_claim_host_test'
npm run migrate
npm start
```

First provision a fresh dedicated loopback database `useraid_skill_claim_host_test` in your owned PostgreSQL16 fixture. The URL guard rejects another database, remote host or NODE_ENV=production. `cp -RL` dereferences canonical source/migration links into an independent tree; own `npm ci` supplies every runtime dependency. Migration is one-time fresh-schema setup, never a destructive cleanup. `participant-index.sql` declares the exact composite ownership dependency supplied in root by wallet-link migration, without importing that unrelated integration.

Expected PASS: actual canonical HUMAN private claim/evidence persistence, exact saved catalog binding, original receipt after retirement/write disablement and current session revocation; no assessment/rank/outbox. The synthetic account/HUMAN/session/catalog are actually persisted. Self claims use that same canonical participant ID; no claimed S-rank becomes an assessed rank or an assessment-history reset. Catalog retirement and writes disabled retain the original receipt, while session revocation denies replay.

The CLI closes its pool in finally; the fixture owner stops its own database/container after all checks, including failures/interruption, retaining logs/data/source. No server/browser/port is started by the CLI. This demonstrates PostgreSQL driver/ORM substitution and database-backed identity, not real wallet/X proof, production root enablement, artifact uploads, rubric/evaluator/confidence/reassessment/revocation, independent review, UAT or release gates.

Alternate adapters retain canonical identity, account/session checks, exact version FKs, immutable claim/catalog history, private data boundary, receipts and SQL race behavior. Direct privileged SQL is not a public authorization path. Destructive downgrade after acknowledged records is unsupported; disable new writes and retain histories. Consult the contract for recovery/errors and the next protected-root API/UI task.

## Portable private HTTP consumption

The same installed host also consumes `createSkillClaimHandlers` with explicit synthetic server actor/origin/rate callbacks, actual SQL read/save/catalog transactions and native Node Request/Response. It verifies private GET and the original REPLAYED response while new writes are disabled. Its rate callback is explicitly a fixture no-op; live consumers must supply approved enforcement. Root integration instead supplies current cookies/origin and database rate limits, verified by the separate actual Next development preview. Catalog publication uses an actual current X-authorized admin session; ordinary claim/read sessions may be wallet or X. This update preserves the root administrative contract, with no invented freshness period.
