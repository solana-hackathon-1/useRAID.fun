# Independent Raid terms host

Consumes the public `work-loop/terms`, `work-loop/contracts` and `work-loop/storage` interfaces. Requires Node ≥22.12 and a new empty loopback PostgreSQL16 database named `raid_terms_example`; `DATABASE_URL` is its only configuration. This is a synthetic host with its own session/Guild-authority/reservation tables. It grants no RAID Guild recognition or production authority.

Copy this directory **dereferencing symlinks** to a separate directory (`cp -RL examples/raid-terms /tmp/raid-terms-host`). The declared source dependencies are work-loop, shared contracts, command-receipts, asset-registry, the synthetic fixture and the two exact migrations linked here. Install with `npm ci`, then `DATABASE_URL=postgresql://.../raid_terms_example npm start`. Use a fresh empty database per run. Never point this setup at the application database.

The host verifies save, publication with one exact simulated reservation, write-disabled original replay, alternate scoped authorization and revoked-authority denial. It imports no RAID auth, Prisma, Next, application singleton or credentials. It owns transaction commit/rollback and whole-transaction retry; PostgreSQL deadlock/serialization errors map to RETRY_TRANSACTION. Stop the owned database after testing; preserve unrelated resources. No package publication is required.

See [module contract](../../docs/raid-terms.md) for boundaries and limitations.
