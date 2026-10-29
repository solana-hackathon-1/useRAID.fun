# Worker b1 log

- 2026-10-29 b1 (Claude): stopped a stale background vitest run and my old `raid-guild-test-20261027` DB; own test DB is `raid-b1-283-test-20261029` (127.0.0.1:55433, database `useraid_test` because `assertTestDatabase` requires that exact name).
- #283 → `task/283-offer-issuer-followups`: issuer check up front, issuer column validated, guard comment, stronger no-side-effect test, doc line. Full real-PG suite 275 files / 4002 tests, lint 0 errors, typecheck clean.
