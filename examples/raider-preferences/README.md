# Independent private preferences host

See [the complete storage contract](../../docs/raid-raider-preferences.md). This private example uses PostgreSQL16 through its own pg8.23.1 driver, zod4.6.5, bs58 and tsx4.23.15; Node22.12+. No app singleton, root node_modules, Next or Prisma dependency. The optional form consumer additionally declares exact React19.3.0/ReactDOM19.3.0. `cp -RL` dereferences canonical module/shared-contract/migration links into a self-contained host.

Provision a new task-owned PostgreSQL database `useraid_onboarding_host_test` bound to loopback on an available port. Supply its synthetic DATABASE_URL privately in the shell; the host refuses production, other databases and non-loopback hosts. Never use staging/customer data. It owns only that dedicated synthetic database. Retain evidence, then stop only the owned database even on failure/interruption; preserve other services, volumes, images and evidence.

```sh
cp -RL examples/raider-preferences /tmp/raid-preferences-example
cd /tmp/raid-preferences-example
npm install --ignore-scripts --no-audit --no-fund
npm run migrate
npm start
npm run form
```

Set DATABASE_URL before migrate/start. `migrate.ts` is a fresh-fixture initializer, not a production migration runner or repeatable reset: it creates the host's minimal User/Session tables and exact copied Participant/receipt/preference constraints. It cannot retrofit an existing datastore. `host.ts` prints synthetictrue, realDatabase, alternatePgPort, ownSchema, privateRead, originalReplay, changedBodyConflict, foreignSessionDenied, wholeRetry, stableHuman and noRankSlotOrPayment, all true. Each run uses uniquely labeled synthetic identity; no preference or cookie content is printed.

The host implements real READ COMMITTED begin/commit/rollback, checked isolation, sanitized SQLSTATE classification and whole-transaction retry. Replacement providers must preserve authority, constraints and acknowledged semantic IDs; an unsupported datastore is not an equivalent adapter. The fixture is preparation/storage evidence, not actual starter/trial, assessed rank, paid-work availability, independent review/UAT or a live release gate. Production retention/deletion/durability policy remains OPEN.

The form example renders the canonical framework-free component with explicit host state and injected transport. It verifies semantic controls and default-unavailable display without hidden network/database calls. An interactive consumer supplies routing via browseLink and its own React mount/theme/styles, then exercises the documented authenticated transport. Browser interaction/focus/retry/privacy evidence comes from the separate owned Next development preview.
