# Worker b2 log

Worktree `/Users/dushyant/Documents/raid-b2`; test Postgres `raid-b2-test-20261029` on 127.0.0.1:55434 (database `useraid_test`, because the DB guard only accepts that exact name; separate server from the shared one on 55432). Stop: `docker rm -f raid-b2-test-20261029`.

- #281 assessment-lock follow-ups: branch `task/281-assessment-lock-followups` (shared lock helper, exact-key `pg_locks` wait check, unhandled-rejection fix, lock-order doc). Status: see PR.
