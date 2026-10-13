# Independent authorized taxonomy host

Synthetic PostgreSQL16 CLI fixture for [the stable catalog storage contract](../../docs/raid-skill-taxonomy-storage.md). Node≥22.12; pg8.23.1, Zod4.6.5, bs58 6.0.0, tsx4.23.15 are declared and locked. The host owns a minimal User (id/role/xId/suspended) and Session (hash/user/expiry/via) schema, scoped allowlist policy, READ COMMITTED transaction/driver and whole retries. Shared receipt/catalog SQL is canonical; local relative links intentionally refer to source. Copy with dereferencing to obtain an independent source tree and dependency installation:

```sh
consumer_dir=$(mktemp -d /tmp/raid-skill-taxonomy-consumer-XXXXXX)
cp -RL examples/skill-taxonomy/. "$consumer_dir/"
cd "$consumer_dir"
npm ci
export NODE_ENV=test
export DATABASE_URL='postgresql://postgres:synthetic-only@127.0.0.1:YOUR_OWN_PORT/useraid_skill_host_test'
npm run migrate
npm start
```

Provision a fresh dedicated database `useraid_skill_host_test` on your own loopback PostgreSQL16 fixture before running migration. No root Prisma installation, RAID User data, real X account, secret/admin credential or external service is needed. The URL guard rejects another database, remote hosts and NODE_ENV=production. `migrate` applies the independent account/session schema, existing immutable receipt/audit migration and new catalog migration; it is a one-time fresh-schema command, not destructive cleanup. Node host closes its pool in finally; the fixture owner stops only its own PostgreSQL container after all checks, retaining evidence/data as required.

Expected output: PASS for actual authorized publication/read/original replay/current policy revocation; stable frontend/Solana domains; the saved taxonomy never verifies a self claim; no outbox. Synthetic data only. The CLI persists an actual catalog via a synthetic allowed ADMIN with a live session, replays the exact original result with writes disabled, reads it, consumes that saved catalog in pure unverified preparation and rejects replay after removing policy authority. The pure preparation's HUMAN participant is an explicitly synthetic host fact, not a persisted canonical participant. This minimal schema does not store a claim or assessment, or prove production root auth/admin rollout, UAT, independent review or release gates.

The module contains no driver SDK types, environment singleton, Next app routing or provider fetch. A local synchronous current allowlist receives locked database account/xId facts. Existing role/suspension/session checks cannot be bypassed by the callback. Replace the driver with another port implementation only while preserving actual PostgreSQL transaction/isolation/constraints, whole retry identity, immutable versions and scoped current authorization. See the contract for SQL privilege limits and unsupported destructive rollback.
