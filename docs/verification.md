# Local verification — 2026-09-27

Verified on Node.js 22.22.2 and isolated PostgreSQL 15 on port 55432.

| Check                                        | Result                                                       |
| -------------------------------------------- | ------------------------------------------------------------ |
| Committed Prisma migration on empty database | Passed                                                       |
| Production Next.js build and TypeScript      | Passed                                                       |
| Unit + PostgreSQL integration tests          | 23 passed                                                    |
| Desktop/mobile Playwright checks             | 8 passed                                                     |
| Database-backed browser journey              | Passed                                                       |
| Dependency audit                             | 0 vulnerabilities                                            |
| Formatting check                             | Passed                                                       |
| Backup restored to separate database         | Passed: 2 campaigns and 1 post preserved                     |
| Collection kill switch                       | Passed with mocked provider; no request allowed while paused |

The database-backed browser journey covers administrator approval, creator draft creation, launch, fixture ingestion, public rendering, exact-mint Jupiter URL, campaign ending, rejected creator-to-admin access, and rejected cross-origin mutations. Test sessions are generated directly in the isolated test database; this is **not** evidence of real X OAuth success.

Integration coverage includes concurrent campaign quotas, owner authorization, idempotent ingestion and counter decreases, normalized scoring, author caps, attribution boundaries, job deduplication and leases, per-raid serialization, atomic spend reservations, 429 backoff, explicit deletions, cursor pagination, edited nonqualifying posts, and missing metric preservation.

Screenshots are in `artifacts/discovery-desktop.png`, `artifacts/discovery-mobile.png`, and `artifacts/raid-live-fixture.png`. The last image contains controlled database fixtures, not real X activity.

## Not verified externally

- Real X credentials, OAuth, search coverage, account permissions, billing, and permitted retention/display.
- Actual end-to-end ten-minute appearance target with posts published on X.
- The selected real token arriving as the output asset in Jupiter's current UI.
- Railway provisioning, production spend, or production backup restoration.

No X requests, posts, trades, paid deployments, or external account changes were made during the test suite. Complete `docs/operations.md` before enabling live collection.

## Continuous integration

`.github/workflows/checks.yml` runs three jobs: `static` (format, typecheck, lint, `npm run audit:check`), `test` (migrations, schema-drift diff against a shadow database, the full suite with `RUN_DB_TESTS=true`) and `browser` (demo, database-backed and live Playwright suites on Chromium). The Creator Studio browser suite (`npm run test:browser:studio`) stays out of CI because `studio:preview` needs `docker compose exec`; run it locally before release. Accepted audit advisories live in `audit-allowlist.json` with an expiry date.
