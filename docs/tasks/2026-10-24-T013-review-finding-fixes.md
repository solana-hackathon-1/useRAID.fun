# T013 — independent-review finding fixes (F1, F3, F5)

SELF-EVALUATED by the builder; no independent re-review yet. Branch `claude/t013-practice-trial-ui`, base HEAD `4cf779181588d0f808c5b294ddd6c0e5952b6b6a`, uncommitted. Source: independent review verdict ACCEPT-WITH-NOTES of the [current review](2026-10-24-T013-current-review.md). No policy, schema, API contract or security-semantics change; no commit, push, merge or branch change.

Mapping: R04/R06/R11/R12/R15/R16, I05/I06/I10/I11/I13; manager contract in [practice assignment management](../raid-practice-assignment-management.md).

## Findings and fixes

- **F1 (minor).** “Refresh current appointments” passed the editable lookup text, so after a write404 (STALE) it could load another submission or fail with “Enter a valid submission identifier”. Added controller `refresh()` that reloads `state.context.page.submissionId` (after `null`); the button calls it. “Recheck management access” (no context) still uses the lookup text, as there is no displayed submission.
- **F3 (minor).** The write403 envelope is `FORBIDDEN` for both a lost admin session and business denials (`SELF_REVIEW_FORBIDDEN`, out-of-scope appointee) — the HTTP layer maps them to the same code — so the cause cannot be distinguished reliably. Chose neutral wording for write403 only; fail-closed behaviour is unchanged (pending cleared, private context cleared, DENIED). Write401 and fresh-read 401/403/404 keep the sign-in wording.
- **F5 (test depth).** Two real-PostgreSQL tests with two appointments on one submission: (1) reader paused holding only the first (lower id) mutex while a second administrator revokes the second appointment — revoke is not delayed, no deadlock, and the reader then observes the second as REVOKED; (2) an in-flight revoke holds the second mutex, the reader is observed via `pg_locks`/`pg_blocking_pids` holding the first and waiting on the second, then both complete and the reader observes REVOKED. Reader contract: READ COMMITTED per statement after each mutex; it is not a page snapshot. No fixed-duration sleeps beyond a 20 ms bounded poll interval. No deadlock or inconsistency found; the claim is confirmed.

## Files changed

`src/skills/practice-assignment-manager-client.ts`, `src/components/practice-assignment-manager.tsx`, `tests/practice-assignment-manager-client.test.ts`, `tests/practice-assignment-management-db.test.ts`, `docs/raid-practice-assignment-management.md`, this record, `planning/task-evidence/T013-review-finding-fixes-20261024/`.

## RED / GREEN evidence

- F1/F3 RED (`red-f1-f3.log`): `TypeError: c.refresh is not a function`; write403 message was “Management access is unavailable. Sign in with an authorized administrator account and recheck.” instead of the neutral wording. GREEN (`green-f1-f3.log`): 47/47 in the manager-client and view test files.
- F5: the behaviour already held, so there is no product RED. Sensitivity evidence instead (`red-f5-mutation.log`): temporarily removing the reader’s per-appointment advisory lock made both new tests fail (“Timed out (deadlock?): reader to take the first appointment mutex”; “Timed out waiting for reader to wait on the second mutex”); the production file was restored byte-for-byte (`cmp` identical). GREEN (`green-f5-db.log`): 20/20 in the DB test file.
- Refactor: `refresh` delegates to the existing `load` through a named `api` object rather than `this`.

## Checks run / skipped

Run: the two unit files above; the DB-backed file on a task-owned container; `tsc --noEmit`, ESLint and Prettier on touched files (results in the final report). Container `raid-t013-review-fixes-test-20261024` (label `owner=claude-t013-builder`) was created and removed per run; see `cleanup.json`.
Skipped: full suite, browser (Playwright) suites and production build — not rerun; hosted CI at base HEAD remains the evidence for unchanged code. The component click wiring for F1 has no DOM-level unit test (no jsdom/testing-library in the repository); it is covered by type checking and the existing browser spec, which was not run locally.

## Remaining gaps

F2 (deferred UX decision) and F4 (consumer example not rerun on current dependencies) are unchanged. All NOT VERIFIED statuses in the [current review](2026-10-24-T013-current-review.md) stand: independent criterion review of these fixes, representative UAT, operating policy and release gates.
