# T013 administrator issue/revoke HTTP — SELF-EVALUATED (Claude), 2026-10-21

Source: branch `claude/t013-practice-trial-ui`, parent HEAD 1877b2a plus the uncommitted Codex inbox/assessment/ownership/review-UI work and this change, committed together by owner direction ("continue with the admin issue/revoke route, review-and-commit then").

## RED → GREEN

- `tests/practice-review-assignment-http.test.ts`: RED = missing module (suite failed to import); GREEN 52 pass. (An oversize-body expectation of 422 was corrected to the shared bounded-body status 413 before implementation; no assertion weakened.)
- `tests/practice-review-assignment-root-http.test.ts`: RED = missing Root adapter/routes; GREEN 12 pass.
- `tests/practice-review-assignment-http-db.test.ts` (actual PostgreSQL, 3 tests) was written after the transport and drives the unchanged storage; it is integration evidence, not preimplementation RED.

## Checks run (this source)

- Full parent suite on owned disposable PG: 222 files / 3432 tests PASS (327.8 s, `full-suite.log`).
- Consuming example independently installed (`npm ci --ignore-scripts`, 0 vulnerabilities), `tsc --noEmit` PASS, `npm start` against real PG PASS incl. HTTP issue/replay/key-reuse/revoke (`consumer-*.log`).
- `tsc --noEmit` 0; eslint on owned files 0; identity AST fence PASS; prettier check PASS on owned files; planning unittest 55 PASS; `next build --webpack` PASS; compiled smoke: unauthenticated POST 403 private/no-store, GET/HEAD 405, foreign-origin POST 403, server stopped.
- Reviewer read-through of the combined uncommitted candidate: no blocking findings. Observations: assessment/ownership/inbox Root adapters follow the established origin→actor→quota pattern; no `dangerouslySetInnerHTML`; no secrets in new files (pattern scan).

## Not verified / not done

Independent criterion review, hosted Node 22 CI, UAT, staffed operating policy, release gates, full T013 27 criteria, and parked identity protocol remain NOT VERIFIED. `PRACTICE_REVIEW_ASSIGNMENTS_ENABLED` stays default off; no real appointment created. No browser UI for assignment management (next slice). Local runtime Node 26 (not Node 22).

## Cleanup

Disposable PG `raid-t013-assignment-admin-http-20261021` stopped (exit 0) after each run; compiled smoke server stopped; scratch consumer copy lives outside the repo. Existing Codex previews (47150 inbox, 33604, 16680, 99844 and their PGs) left running untouched. `.claude/worktrees/` and `WARP.md` not committed.
