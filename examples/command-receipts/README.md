# Command receipts example host

Minimal consuming host for the T019 idempotent command receipt, audit and outbox foundation. Full module documentation, contracts, configuration names, retry rules and the step-by-step standalone run are in [docs/raid-command-receipts.md](../../docs/raid-command-receipts.md).

This directory declares its own dependencies (`package.json`), a minimal `HostCredit` business table, the four receipt tables and two migrations. `contracts`, `command-receipts`, `lib/command-receipts-adapter.ts` and the receipt migration are symlinks to the canonical sources; copy with `cp -RL` so the copy is self-contained. Supply `DATABASE_URL` for a disposable local database yourself; the host refuses non-local URLs and `NODE_ENV=production`.
