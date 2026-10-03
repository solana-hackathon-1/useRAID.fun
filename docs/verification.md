# Verification record: `fix/everything`

This is the record of the branch that fixed the findings from the full review. It lists what changed, what was run, and what has not been verified. Update it with exact counts whenever the end-of-branch gate is repeated; do not edit it to say more than was run.

## What the branch contains

Phased commits on top of `main` (history is kept as committed, one concern per commit):

- `385a47d` chore: format baseline and test database override
- `5c28005` refactor: shared test harness, single worker module, HTTP error mapping
- `b1b666f` feat: schema baseline migration and CI release gates
- `e5542b8` fix: queue and worker robustness (dead-letter, deferred errors, isolated scheduling)
- `fffc8b5` fix: lookup classification, finalization correctness and coverage expiry
- `ef4168d` fix: X budget controls and public load limits
- `b07a62a` feat: creator-approval request UI and hardened /api/creator
- `74a208c` feat: money policies (author cap, minimum payout, creator exclusion, early-end measurement, settlement flag, creator approval)
- `dd89ee9` feat: USDC operations (late deposits, withdrawal chain check, reconciliation, pool release, token metadata source)
- `30ec5c3` feat: auth hardening, security headers and media assets
- `1b60b06` test: give the per-visitor analytics DB tests an explicit timeout
- `4557c47` feat: launch key separation, strict GCM parsing and structural image validation
- `aa95d96` fix: launch finance pauses, expiry, rent reserve, single-flight signing and legacy windows
- `79895c2` fix: launchpad gate, reconcile-only scheduling, mint recovery, creator approval and launch UI
- `4cd750a` feat: scoring v3, post re-homing, hot-path indexes, USDC audit and preview database
- `6db65cd` feat: ledger integrity triggers, linked money tables and state vocabularies
- `783bc5e` feat: frontend and UX fixes for forms, lists, formatting and error handling
- `6dd7d67` fix: move the coming-soon static site out of the app's public directory
- `81a637a` refactor: remove the unused Tailwind pipeline and keep its reset
- `e05214e` feat: deploy hardening with worker migrations, schema check at boot and a multi-stage image

Migrations (all additive; the baseline is `202609270001_init`, and `prisma migrate diff` against the schema shows no drift):

- `202609270001_init`
- `202609280001_x_connection`
- `202609280002_pump_launch`
- `202609290001_x_tracking`
- `202609290002_standalone_raids`
- `202609300001_creator_studio`
- `202610020001_studio_fk_alignment`
- `202610020002_job_dead_letter`
- `202610020003_x_budget_controls`
- `202610020004_raid_money_policies`
- `202610020005_token_metadata_source`
- `202610020006_auth_hardening`
- `202610020007_media_assets`
- `202610020008_wallet_rotation`
- `202610020009_launch_finance_hardening`
- `202610020010_hot_path_indexes`
- `202610020011_ledger_integrity`
- `202610020012_state_checks`

Policies in force at the end of the branch:

- Tracking v2 is on by default (pinned by `tests/launch-gate.test.ts` and `tests/env-example.test.ts`); settlement is off by default and `X_TRACKING_V2_SETTLEMENT_ENABLED=true` is required for Creator Studio.
- `launchpadsAvailable` is `false` in `src/lib/release.ts` in every commit. Reconciliation of already-broadcast launch transactions still runs in the worker.
- Funded Raids apply the author cap (`RAID_AUTHOR_CAP_BPS`, default 25%); launchpad fee rewards are uncapped.
- Four-eyes approval of tracking decisions is deferred; decisions are audited.

## Documentation gate (this record's last run)

Run against the isolated PostgreSQL 15 container (`useraid-test`, port 55432, database `useraid_test`):

| Check                                                   | Result                                         |
| ------------------------------------------------------- | ---------------------------------------------- |
| `npx prisma generate`, `npm run typecheck`              | Passed                                         |
| `npm run format:check`                                  | Passed                                         |
| `npm run db:migrate`                                    | No pending migrations (all applied)            |
| `npm test` (database suites skipped)                    | 250 passed, 241 skipped (38 files, 15 skipped) |
| `RUN_DB_TESTS=true DEMO_MODE=false npm test`            | 491 passed (53 files), about 16 minutes        |
| `tests/env-example.test.ts`, `tests/docs-links.test.ts` | Passed (included in the counts above)          |

`tests/env-example.test.ts` fails if the application reads an environment variable that `.env.example` does not document, and `tests/docs-links.test.ts` fails on a broken relative link or anchor in the README or `docs/`, or on a documented `npm run` script that does not exist.

The Playwright suites (`test:browser`, `test:browser:live`, `test:browser:studio`), `test:live`, the production build and the Docker smoke build were not re-run for this documentation change, which touches no application code. Their results belong to the end-of-branch verification.

## Regression proofs

The high-severity fixes (the early-end measurement, creator self-enrollment, unapproved-Studio, USDC late-deposit and withdrawal chain-check, launch finance pause/expiry, and ledger integrity cases) are covered by the database suites counted above, mainly `tests/studio-db.test.ts`, `tests/usdc-ops-db.test.ts`, `tests/launch-db.test.ts`, `tests/money-integrity-db.test.ts` and `tests/tracking-db.test.ts`. The claim that each of these tests fails on `main` was not re-checked in this documentation pass; repeat it by running those files against a checkout of `main` when doing the end-of-branch verification.

## Not verified externally

- Real X credentials, OAuth, search coverage, account permissions, billing, and permitted retention/display.
- Actual end-to-end ten-minute appearance target with posts published on X.
- The selected real token arriving as the output asset in Jupiter's current UI.
- Railway provisioning, production spend, or production backup restoration.
- A funded mainnet settlement smoke test, and production data against the `NOT VALID` state checks (run `npm run tracking:audit`, then ship the `VALIDATE CONSTRAINT` migration).

No X requests, posts, trades, paid deployments, or external account changes were made during any test suite. Complete [operations.md](operations.md) (operator checklist and feasibility gate) before enabling live collection or settlement.

## Continuous integration

`.github/workflows/checks.yml` runs `static` (format, typecheck, lint, `npm run audit:check`), `docker` (image build and runtime smoke test), `test` (migrations, schema-drift diff against a shadow database, the full suite with `RUN_DB_TESTS=true`) and `browser` (demo, database-backed and live Playwright suites on Chromium). The Creator Studio browser suite (`npm run test:browser:studio`) stays out of CI because `studio:preview` needs `docker compose exec`; run it locally before release. Accepted audit advisories live in `audit-allowlist.json` with an expiry date.
