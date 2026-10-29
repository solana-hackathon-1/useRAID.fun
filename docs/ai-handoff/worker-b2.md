# Worker b2 log

Worktree `/Users/dushyant/Documents/raid-b2`; test Postgres `raid-b2-test-20261029` on 127.0.0.1:55434 (database `useraid_test`, because the DB guard only accepts that exact name; separate server from the shared one on 55432). Stop: `docker rm -f raid-b2-test-20261029`.

- #281 assessment-lock follow-ups: PR #301 (merged into the stack tip). Shared lock helper, exact-key `pg_locks` wait check, lock-order doc.
- #287 JSON shape follow-ups: PR #307 (merged). Unstorable text refused as INVALID_INPUT; `scripts/audit-work-json-shape.sql`.
- #98 T056 Party storage core: PR #311 (open, no independent review yet: NOT VERIFIED). Migration 202610270011_parties.
- Notes: full-suite runs showed 5 s default-timeout flakes (`studio-db`, `work-workspace-db`) that pass alone while other jobs load the machine. My earlier PRs forgot the CI-matrix registration of new test files; the planning `unittest` catches it, so run it before pushing.
