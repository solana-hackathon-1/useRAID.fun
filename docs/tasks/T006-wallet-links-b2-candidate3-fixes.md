# T006 B2a — candidate 3: first-X-connection deadlock (CR-B2-05)

Date: 2026-10-10. Author: Claude Sonnet 5.5 (same writer family as candidates 1 and 2; **not independent acceptance**). Status: **SELF-EVALUATED, IMPLEMENTED_UNVERIFIED**. Independent acceptance is Codex's. Wallet linking stays disabled (`WALLET_LINKS_ENABLED` default off; no route, page, component or X callback reaches the link commands). No commit, push, merge, deploy, GitHub board edit or GitHub Actions run. B2c and B3 not started. No change to the victim-signed-challenge policy or any signed-statement bytes. All 27 T006 criteria remain NOT VERIFIED.

Input: the Codex candidate-2 report `/Users/dushyant/Documents/useRAID-reviews/2026-10-10-b2-rereview-candidate-2/codex/REPORT.md` (read in full). Codex evidence and candidates 1 and 2 were not modified. Candidate 2's confirmed fixes (CR-B2-01 post-lock clock; CR-B2-02 X advisory lock before User rows, changed-X fail-closed guard) are preserved byte-for-byte except for the one addition below.

Maps to R04, R13, R15, R16, I05, I10, I11, I13; DEC-2026-10-09-01, DEC-2026-10-10-01; blueprint §§07.1–07.2, 13, 24.6–24.8, 27–28, 30, 32, 35 (AC01/AC02 partial, AC40, AC73–AC75). Entities: `User`, `OAuthAttempt`, `XAccount`, `Session`, `WalletIdentity`, `WalletChallenge`. No schema, migration, permission, money or state-machine change.

## Root cause (the actual PostgreSQL wait-for cycle)

First X connection of an account with `xId = null` (wallet-only account, `completeConnection`) versus the merge of that same account as the dropped side, reached from `absorbAccount` directly and from the wallet-fold branch of `verifyWalletChallenge`:

| Transaction                   | Held                                                                                   | Wants                                                             |
| ----------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `completeConnection`          | `x-auth:<new profile id>` advisory lock; the deleted (claimed) `OAuthAttempt` row      | the account's `User` row (`user.update`)                          |
| `absorbAccount` (candidate 2) | both `User` rows (the dropped account's X id is null, so it took **no** advisory lock) | the same `OAuthAttempt` row (`deleteMany`, `account-merge.ts:81`) |

attempt → User versus User → attempt. Candidate 2 only ordered the X advisory lock before the User rows; with a null X id there is no shared advisory key, so the two writers meet only on the attempt row and the User row, in opposite orders. PostgreSQL reported `40P01`: "Process 874 waits for ShareLock on transaction 19356; blocked by process 878. Process 878 waits for ShareLock on transaction 19357; blocked by process 874." (full detail in `red-initial.xml`).

## Corrected lock order

For every identity writer (merge, X first-connect/reconnect/disconnect, wallet link):

1. `wallet-subject:<address>` advisory lock (wallet writers) and/or `x-auth:<xId>` advisory lock (X writers)
2. the account's `OAuthAttempt` rows (**new**: merge locks them `FOR UPDATE` in `stateHash` order)
3. `User` rows in id order
4. `XAccount` / `Session` / wallet rows

`completeConnection` already followed 1 → 2 → 3. `absorbAccount` now follows it for every dropped account, including `xId = null`: observe X id → advisory lock if any → `SELECT … FROM "OAuthAttempt" WHERE "userId" = dropId ORDER BY "stateHash" FOR UPDATE` → sorted `User` locks → re-check the X id (fail closed if a connection committed meanwhile) → emptiness check → the original deletes. The attempts are still **deleted at the end**, after the emptiness check (moving the delete earlier would mutate before the denial). Not a retry, not a timeout. Behaviour after the fix when the connection is queued first: it commits (the account gains an X id); the merge then fails closed with `Account identity changed during the merge; try again.` and folds nothing. When the merge is first, the connection finds its attempt gone and fails with the existing `state` error. Either way exactly one serialized outcome and no `40P01`.

## Changes

| File                                      | Change                                                                                                                                                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/lib/account-merge.ts`                | the ordered attempt-row lock and the updated lock-order comment (the only logic change)                                                                                                                      |
| `src/identity-link/index.ts`              | comment only: lock order now mentions attempt rows; corrected the unverified claim that the host "retries the whole callback" (the bundled host does not retry)                                              |
| `tests/wallet-link-lock-order-db.test.ts` | 3 cases appended; the 4 existing cases are untouched; one shared helper (`attemptWaiters`) observes any statement on `OAuthAttempt`, because the merge now queues on the `FOR UPDATE` rather than a `DELETE` |
| `docs/raid-wallet-links.md`               | lock-order section rewritten for the four-level order; documents the first-connect cycle, the 503/redirect failure mapping and the residual below                                                            |

Unchanged: `src/lib/wallet-auth.ts` (byte-identical to candidate 2), `src/lib/x-oauth.ts`, every B2b byte, schema and migrations.

## Test-first evidence (author)

New cases (real PostgreSQL; second connection holds the `OAuthAttempt` row; both waiters observed through `pg_stat_activity`/`pg_blocking_pids` before release; no mocked SQL):

1. `first X connection versus merge › serializes without a deadlock and fails the merge closed after the connection wins`
2. `first X connection versus wallet fold › …` (real `verifyWalletChallenge` with a real signed `link` challenge; asserts the challenge stays unconsumed and nothing is merged)
3. `lets unrelated merges and a first X connection proceed without waiting on each other` (control: two unrelated merges finish while an unrelated connection is parked; passes before and after the fix by design)

| Phase            | Source                                                                                                                  | Result                                                                                                                                                  | Artifact                                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| RED              | candidate-2 production files, new tests                                                                                 | 7 tests, **2 failures** (cases 1 and 2): `40P01 deadlock detected` at `account-merge.ts:81`; the other 5 pass (the 4 candidate-2 tests and the control) | `planning/task-evidence/T006-wallet-links-b2-candidate3-fixes/red-initial.xml` |
| RED, final tests | final test file against candidate 2's `account-merge.ts` swapped in temporarily (restored byte-for-byte, `cmp` checked) | same 2 failures                                                                                                                                         | `…/red-final-tests-vs-candidate2-merge.xml`                                    |
| GREEN            | final tree                                                                                                              | 7/7 in the file; with `account-merge-canonical.test.ts` 20/20                                                                                           | `…/green.xml`                                                                  |
| Mutation         | the attempt lock moved after the User lock                                                                              | both new cases fail again (2 failed, 5 passed); source restored                                                                                         | run log in this session; not archived as XML                                   |

The first RED run used the narrower waiter helper (`DELETE` only); the helper was widened afterwards and RED was re-proved with the final tests as shown. No existing test was edited or weakened; the 4 candidate-2 cases (expiry ×2, merge versus reconnect, changed-X guard) all still pass.

Coverage of the requested scenarios: merge versus first X connection (case 1); wallet-fold versus first X connection (case 2); merge versus X reconnect, session expiry during lock waits and changed X identity during a wait (candidate-2 cases, preserved); successful non-conflicting concurrent operations (case 3). Case 4 of candidate 2 still tests the changed-X guard with a synthetic committed update; case 1 and 2 additionally exercise it end-to-end through a real callback.

## Local verification (author, SELF-EVALUATED, not hosted CI, not independent)

Own tmpfs container `raid-claude-resume-20261010` (postgres 16-alpine `ef738a34a865`, loopback 56901, synthetic credentials, `useraid_test` and empty `shadow`); `env.sh` in the evidence folder.

| Check                                                                      | Result                                                                        |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Full `npm test`                                                            | **89 files / 1117 passed / 0 failed / 0 skipped** (candidate 2: 1114; +3 new) |
| `prisma migrate status`; `migrate diff` from migrations to schema (shadow) | 22 migrations, up to date; no difference, exit 0                              |
| `tsc --noEmit`; scoped ESLint (4 files)                                    | exit 0; 0 problems                                                            |
| Python planning tests                                                      | all pass (37)                                                                 |
| `prettier --check .`; `git diff --check`                                   | clean                                                                         |
| `npm run audit:check`                                                      | PASS (allowlist policy)                                                       |

Not run: the 22-step local CI aggregate, browser suites, production build/Docker, hosted CI, Codex's mutation set, the completion validator (expected exit 1), a development preview (no browser-visible change).

## Writer audit after the change

Inspection plus the tested interleavings; not exhaustive and not a load or starvation proof.

- `completeConnection` (first connect, reconnect, in-callback fold): 1 → 2 → 3 → 4. Its own `absorbAccount` call takes the same advisory key and locks further attempts of the dropped account in order.
- `absorbAccount` (reconnect fold, wallet fold, direct): now 1 → 2 → 3 → 4 for null and non-null X ids.
- `startAttempt`, `disconnectX`: advisory lock and attempt/X rows only; neither takes a `User` row lock afterwards, so they cannot close a cycle with the User lock.
- Additional link and linked sign-in: wallet subject → `User` → `Session`/`XAccount`; they take neither `x-auth` nor attempt locks.
- **Residual, not proven cycle-free:** several writers delete multiple `OAuthAttempt` rows without a common order (`disconnectX`, the expired-attempt sweep in `startAttempt`, the callback's own absorb). They hold no `User` lock, so they cannot recreate this cycle, but two of them against each other, or against the merge's ordered lock, have no dedicated test. Not weakened or ignored; flagged for Codex.
- Error mapping, corrected from candidate 2's handoff: the wallet HTTP wrapper maps the unclassified merge error to **503** `Service unavailable. Please try again.`, and the X callback redirects to `?auth=failed`. A typed conflict/retry mapping is still a follow-up; the bundled host does not retry automatically.

## Remaining blockers (unchanged by this change)

Acceptance: independent re-review of candidate 3 (CR-B2-05 and exact-source regression/security evidence); reconciliation with upstream PR #188 and re-review of the reconciled tree (separate document, see candidate-3 folder `PR188-RECONCILIATION.md`). Enablement: item E (victim-signed challenge, still requires an owner-approved destination/intent consent and recovery design before any exposure); COND-REUSE (the example host does not exercise `observeAuthority`/B2/B2b); COND-CONSUMER-SECURITY (`deepmerge-ts` advisory in the standalone example); COND-FLAG (B2a switch checked on entry only); COND-AUDIT/REVOKE/ROLLOUT (no durable audit, revoke session invalidation, instance rollout, recovery); T007 AC02; owner decisions on revoke session scope and suspended-account revoke. B2c and B3 remain blocked.
