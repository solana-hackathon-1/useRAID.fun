# Asset registry example host

Minimal consuming host for the T029 exact asset registry and bounded amount arithmetic. Full module documentation, contracts, configuration names, limits and the step-by-step standalone run are in [docs/raid-asset-registry.md](../../docs/raid-asset-registry.md).

This directory declares its own dependencies (`package.json`). `contracts` and `asset-registry` are symlinks to the canonical sources in `src/`; copy with `cp -RL` so the copy is self-contained. The host needs no database, network access, environment variable or credential. Every asset in it is a synthetic test fixture and the host demonstrates that production configuration is blocked.
