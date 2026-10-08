# Identity storage example host

Minimal consuming host for the T006 HUMAN participant mapping. Full module documentation, contracts, configuration names, retry rules and the step-by-step standalone run are in [docs/raid-identity-storage.md](../../docs/raid-identity-storage.md).

This directory declares its own dependencies (`package.json`), minimal `User` and `Participant` schema, and two migrations. `contracts`, `identity-storage` and `lib/identity-storage-adapter.ts` are symlinks to the canonical sources; copy with `cp -RL` so the copy is self-contained. Supply `DATABASE_URL` for a disposable local database yourself; the host refuses non-local URLs and `NODE_ENV=production`.
