- #285 → `task/285-consent-followups`: consent pre-screen reuses acceptance's offer checks/codes (`findParticipantOffer` + `assertOffer`), shared `assertOpenForTaking` splits DEADLINE_PASSED/PUBLICATION_BLOCKED across consent, acceptance and applications, deterministic-clock tests with a hit check. Full real-PG 274 files / 3999 tests, lint 0 errors, typecheck clean.
# Worker b1 log

- 2026-10-29 b1 (Claude): stopped a stale background vitest run and my old `raid-guild-test-20261027` DB; own test DB is `raid-b1-283-test-20261029` (127.0.0.1:55433, database `useraid_test` because `assertTestDatabase` requires that exact name).
- #283 → `task/283-offer-issuer-followups`: issuer check up front, issuer column validated, guard comment, stronger no-side-effect test, doc line. Full real-PG suite 275 files / 4002 tests, lint 0 errors, typecheck clean.
- #329 item 1 → `task/329-return-to-array`: `accountReturn` fails closed (null) on repeated `returnTo` array instead of throwing 500; widened page searchParams type. Targeted return-to test, tsc, lint.
