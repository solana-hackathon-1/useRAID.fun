# T006 B2a/B2b — handoff for independent Codex re-review

Prepared 2026-10-10 by Claude Sonnet 5.5 (author of the fixes). **Review gate: OPEN.** B2a was REJECTED by the earlier Codex security review (B2A-01 high, B2A-02 medium, B2A-03 low). B1 was ACCEPTED by Codex. A Claude subagent reviewed the intermediate fix and returned ACCEPTED WITH CONDITIONS for B2a and B2b ([record](T006-wallet-links-b2-rereview.md)); it shares the author's model family and is **not** independent acceptance. The author's later fixes (N1–N6) have had no review. Nothing below is accepted until Codex says so. Wallet linking stays disabled: `WALLET_LINKS_ENABLED` defaults off and no route, page, component or X callback calls the new commands. No commit, push, merge, deploy or board action has happened. All 27 T006 criteria remain NOT VERIFIED.

Maps to R04, R13, R15, R16, I05, I10, I11, I13; DEC-2026-10-09-01 and DEC-2026-10-10-01 (blueprint §§02.6–02.7); §§07.1–07.2, 13, 24.6–24.7, 25–28, 30, 32, 35 (AC01 partial, AC02 partial, AC40, AC73–AC75). Affected entities: User, XAccount, Session, WalletChallenge, WalletIdentity, WalletLink, Participant. B2c (routes, revoke composition, session invalidation, durable audit) and B3 (UI) are **not started** and must not start before this gate passes.

## Candidate identity

- Base: `main` `66d6a3a05936df54c8dbca150b7c3bea6e6134be`, branch `main`, staging empty, everything uncommitted in `/Users/dushyant/Documents/useRAID.fun` (read-only for the reviewer).
- Frozen snapshot, outside the repository and outside the author's reach of later edits: `/Users/dushyant/Documents/useRAID-reviews/2026-10-10-b2-rereview-candidate/`
  - `candidate/`: full working tree minus `.git`, `node_modules`, `.next*`, `.claude`, test output and the generated `next-env.d.ts` drift (not part of delivery).
  - `candidate-SHA256SUMS` (hash `494a7692…cf9cd`), `tracked-vs-HEAD.patch` (hash `229f784d…e33c`), `modified-files.txt` (21), `untracked-files.txt` (194, includes historical evidence snapshots), `source-manifest.json` (30 critical files, all verified equal to the working tree at preparation time), `top-level-hashes.txt`.
  - `REVIEW-HANDOFF.md`: a copy of this file.
- The snapshot was taken after the last source or test edit. The only later edits are this document and `docs/ai-handoff/CURRENT.md`.

## What changed since the rejected snapshot (`wallet-auth.ts` `228a1e0e…`)

1. **B2A-01 (wallet-only session).** `linkAdditionalWallet` (`src/lib/wallet-auth.ts:338`) now requires the current session's `via === 'x'` (403 otherwise), the caller's own session, a live expiry by the database clock, and a still-connected X account. Owner clarification recorded as DEC-2026-10-10-01.
2. **B2A-02 (stale authority during lock waits).** New optional `observeAuthority(tx)` hook in the identity-link module (`src/identity-link/contracts.ts:56`, `index.ts:179-210`), awaited after the wallet-subject advisory lock and the account row lock and before the preflight. Host `observeLinkAuthority` (`wallet-auth.ts:305`) reads `Session` and `XAccount` with `FOR SHARE` and `clock_timestamp()`, so a revoke, expiry or X disconnect committed during the wait denies the link and rolls back the challenge claim, and a writer arriving afterwards waits for the link's commit.
3. **B2b.** `verifyWalletChallenge` (`wallet-auth.ts:123`) calls `resolveWalletCredential` only when the address is not a payout wallet. Active link + unauthenticated + switch on gives a `via='wallet'` session for the owning account; every other link case is a 409. `ownershipConflict` (`wallet-auth.ts:69`) maps unique/trigger errors to a sanitized 409 in verify and `rotateWallet`.
4. **N1–N6 from the Claude re-review** (see below).

## Items requiring particular attention

### A. Account-merge deadlock fix (N1)

- **Defect found by the Claude reviewer:** the command takes the account (`User`) lock and then `FOR SHARE` on that account's `XAccount`; `absorbAccount` deleted the `XAccount` before updating `User`. With the command paused between its two lock steps, the merge failed with a real PostgreSQL deadlock (40P01).
- **Fix:** `src/lib/account-merge.ts:32` locks both `User` rows `ORDER BY "id" FOR NO KEY UPDATE` before any `XAccount`, `Session` or wallet write. Lock order for identity writers: subject advisory lock, `User` rows (id order), then `Session`/`XAccount`.
- **Evidence:** deterministic RED/GREEN test `does not deadlock with the legacy account merge while the command holds its locks (N1)` in `tests/wallet-link-authority-db.test.ts`; mutation removing the lock is killed. **Changed existing test:** the mock in `tests/account-merge-canonical.test.ts` gained `$queryRaw` (a read lock); its "before any mutation" assertions are unchanged.
- **Please attempt:** other writers that touch `User`, `Session`, `XAccount` or wallet rows in an opposite order (X sign-in/reconnect `completeConnection`, `disconnectX`, wallet rotation, logout, admin suspend, other `absorbAccount` callers) and the new lock's effect on merge availability. The author did not audit every call site.

### B. `observeAuthority` hook tests (N2)

- New file `tests/identity-link-authority-hook-db.test.ts` (9 cases on real PostgreSQL): hook runs after both locks and before any other read (SQL spy), hook observation overrides stale `session`/`now`, hook-thrown `IdentityLinkError` passes through, any other throw becomes `STORAGE_UNAVAILABLE` without its text, malformed returns are `INVALID_INPUT`, no-hook callers still need a valid session and clock. Documented in `docs/raid-wallet-links.md` (Public interface table, lock order).
- **Please judge:** whether the contract is complete (the hook can read but not forbid reading before the locks), whether `session` and `now` becoming optional weakens existing callers, and that the consuming example `examples/wallet-links` still does **not** exercise the hook (open under C20/C21/AC74).

### C. Revoked-link response consistency (N4)

- `verifyWalletChallenge` maps `IDENTITY_REVOKED` and `IDENTITY_CONFLICT` from the resolver to the same `409 Wallet belongs to another account.` (`wallet-auth.ts` near line 219), equal to the switch-off response, so a revoked link is indistinguishable from an active one for an unauthenticated caller. Test: `gives a revoked link and a switch-off link the same conflict text (N4)` in `tests/wallet-link-signin-db.test.ts`.
- **Known remaining distinguishers (intentional, please assess):** a suspended link owner still returns `403 This account is suspended.` (same as a suspended primary wallet today); the link command's own conflict text (`This wallet cannot be added to your account.`) differs from the sign-in text but is only reachable by an authenticated X-authority caller.

### D. Audit provenance (N6) — what exists and what does not

- **Exists:** every `WalletLink` stores `linkActorAccountId`, `linkRequestId`, `proofRef` (the consumed challenge digest) and `verifiedAt` (columns in `prisma/schema.prisma`); test asserts actor and request id are persisted (`links a fresh wallet…` in `tests/wallet-link-additional-db.test.ts`; a constant-requestId mutation is killed). Challenge consumption is atomic with the insert.
- **Does not exist:** no `ModerationEvent`/audit-event row for link creation or sign-in-through-link, no command receipt (T019 consumer not wired), no outbox event, no revoke audit or session invalidation. Those belong to B2c and enablement gates; the blueprint's I11/G10 audit expectations are **not** met for this slice and the review should not treat provenance columns as the audit trail.

### E. Victim-signed-challenge risk (not fixed, needs an owner decision)

The signed statement is the fixed string `LINK_ADDITIONAL_STATEMENT`; it does not name the target account. An attacker holding an X-authority session on account A can obtain a `link-additional` challenge for a victim's wallet address and ask the victim to sign it (for example through a fake prompt). The command then links the victim's address to A, reserves that address for A, and after B2b the victim's wallet sign-in lands in A. Mitigations considered but **not decided or implemented**: name the account in the signed statement, a confirmation step on the signing side, O11 recovery/revoke by the wallet owner. **Question for Codex:** is this blocking for the B2a/B2b gate or acceptable only while the switch stays off and no route exists? The author's position: it blocks enablement, not the gate.

## Changed assertions in existing tests (please judge whether protection is preserved)

| File                                      | Change                                                                                                                                                                                                                                                               | Reason                                                                       |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `tests/identity-link-boundary.test.ts`    | WR13 guard "wallet-auth.ts has no identity-link reference" replaced by: no use of the commands in `src/app`, `src/components`, `lib/x-oauth.ts`; `revokeWalletCredential` not in wallet-auth; switch default-off for `undefined`, `''`, `false`, `TRUE`, `1`, `yes`. | B2a/B2b legitimately wire `wallet-auth.ts`.                                  |
| `tests/wallet-link-credentials.test.ts`   | Two rotation-race tests expect the losing rotation to surface `409` instead of raw `P2002`; rollback assertions unchanged.                                                                                                                                           | `ownershipConflict` sanitizes driver errors.                                 |
| `tests/wallet-link-additional-db.test.ts` | "No connected X" fixture reassigns a valid stored challenge to the bare account instead of a fabricated digest.                                                                                                                                                      | The old fixture failed proof derivation before reaching the authority check. |
| `tests/account-merge-canonical.test.ts`   | Mock gains `$queryRaw`.                                                                                                                                                                                                                                              | New leading lock (see A).                                                    |

## Evidence (author-run; none of it is independent)

- Final tree: `tsc --noEmit` 0; eslint 0 errors; full `npm test` 88 files / 1108 pass / 0 fail / 0 skip on a disposable PostgreSQL; Python planning 32 pass; `prettier --check .` and `git diff --check` clean (re-run at preparation time).
- Clean unmodified `scripts/local-ci.sh` in an isolated clone with the working tree overlaid: 22/22 steps exit 0, vitest 1108/0/0, demo 49 pass/1 skip, Studio 44 pass, live 38 pass/6 skip (`planning/task-evidence/T006-wallet-links-b2-candidate/ci/`). Local only; not hosted CI.
- RED/GREEN/mutation records: `planning/task-evidence/T006-wallet-links-b2a/`, `…-b2a-authority/`, `…-b2b/`, `…-b2-rereview-fixes/`. RED counts: B2a 7/7 fail, authority 8/9 fail, B2b 5/6 fail, re-review fixes 2 intended failures. Disclosed non-semantic corrections: B2a first GREEN had two failures from a global `walletLink.count()` fixture, scoped to the account.
- Prior reviews: Codex B1 ACCEPTED and B2a REJECTED in `/Users/dushyant/Documents/useRAID-reviews/2026-10-10-independent-b1-b2a/`; Claude re-review record `docs/tasks/T006-wallet-links-b2-rereview.md` (working directory `/tmp/raid-b2-claude-rereview-20261010/`).

## Remaining mutation survivors

| Mutation                                                        | Assessment                                                                                                                     |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Database expiry comparison in `observeLinkAuthority` removed    | Equivalent: module preflight checks the same observation against the same clock.                                               |
| Verify-path `ownershipConflict` removed                         | Backstop: the resolver answers first; mapping is exercised only through `rotateWallet`. A `P2010`-wrapped variant is unproven. |
| Authenticated caller allowed on a link address (sign-in branch) | Backstopped by the database exclusivity trigger (409, no state change); not separately tested.                                 |
| Non-LINK source accepted                                        | Benign (primary owner with the primary key).                                                                                   |
| Mutations the author's script skipped (`no match`)              | Three in the B2b file never ran; the Claude re-review covered two of them.                                                     |
| Reviewer figures                                                | The Claude reviewer ran 32 mutations, 20 killed; all non-equivalent mutations of the new security logic were killed.           |

## Known limitations and risks

Clock skew between application and database fails closed (401); the proof `issuedAt` is application time, the decision clock is database time. The `FOR SHARE` on `Session`/`XAccount` makes logout, X disconnect and the expired-session sweep wait for an in-flight link. A session obtained by wallet sign-in through a link has `via='wallet'` and therefore cannot add another wallet. Link limits (5 active / 20 total) are example values supplied by the host. The consuming example does not cover the host commands. No runtime least-privilege check, hosted CI, browser coverage of the new behavior, UAT or live-provider action has been done. Enablement is additionally blocked by revoke with session invalidation and audit (B2c), T007 AC02 network binding, the rollout order (every instance resolving links before the switch), O11 recovery policy and the item E decision.

## Review criteria — exact pass conditions

1. **Integrity:** snapshot hashes match `candidate-SHA256SUMS`; `source-manifest.json` hashes match the snapshot; no schema or migration change; no route, page or component references the commands.
2. **Re-run independently** in your own copy, dependencies and PostgreSQL: `tsc`, the eight wallet-link/identity suites, full suite (expect 88 files / 1108), and your earlier `reviewer-b2a-required.test.ts` and `reviewer-b2a.test.ts` probes (required cases must pass; characterization cases that encoded insecure behavior may now fail).
3. **B2A-01:** wallet, admin, empty and mis-cased `via` values, foreign, absent and expired sessions all denied with the challenge unconsumed and no `WalletLink` or `Participant`; no client-supplied X claim is trusted.
4. **B2A-02:** revoke, expiry, natural expiry, X disconnect and suspension during an observed lock wait deny and roll back; a writer arriving after the decision waits for the commit; no deadlock or partial state in your own interleavings, including your own attempts against the lock-order inversion class (item A).
5. **B2b:** no path signs in as another account without that wallet's key and a fresh signature; switch-off, revoked, suspended and flag-flip races fail closed; ordinary primary sign-in behavior is preserved apart from the listed changes; no account id, link id or address appears in any response.
6. **Test integrity:** the changed assertions above preserve protection; new tests are not vacuous (run your own mutations beyond the survivors list).
7. **Items A–E:** give an explicit disposition for each (accept, condition, or block), including whether item E blocks this gate.
8. **Verdict per slice** (B2a, B2b): ACCEPTED / ACCEPTED WITH CONDITIONS / REJECTED, with numbered findings, severity, file:line, reproduction, and test-first fix, plus NOT RUN items.

## Out of scope for this gate

B2c, B3, T007 AC02/network binding, rollout order, recovery policy (O11/W03), the completion validator, any enablement. Do not edit the author's worktree.

## Codex prompt

The exact prompt to send is in the final section of `docs/ai-handoff/CURRENT.md` (entry dated 2026-10-10 "review gate prepared") and repeated here:

```text
You are the independent security reviewer (not the author) for RAID task T006 slices B2a and B2b. Read the handoff first: /Users/dushyant/Documents/useRAID.fun/docs/tasks/T006-wallet-links-b2-codex-review-handoff.md (identical copy: /Users/dushyant/Documents/useRAID-reviews/2026-10-10-b2-rereview-candidate/REVIEW-HANDOFF.md). Review ONLY the frozen snapshot /Users/dushyant/Documents/useRAID-reviews/2026-10-10-b2-rereview-candidate/candidate (verify candidate-SHA256SUMS first). Treat the author's worktree as read-only; never commit, push, branch, merge, stash or reset; never touch existing containers or databases; create your own tmpfs PostgreSQL and your own dependency install. This is the re-review of the candidate you previously REJECTED (B2A-01/02/03; your reports are in /Users/dushyant/Documents/useRAID-reviews/2026-10-10-independent-b1-b2a/). Apply the exact criteria in the handoff, give an explicit disposition for items A to E (merge deadlock fix, observeAuthority tests, revoked-link response consistency, audit provenance, victim-signed-challenge risk), re-run your probes, run your own mutations and interleavings, judge the changed existing assertions, and report a verdict per slice (ACCEPTED / ACCEPTED WITH CONDITIONS / REJECTED) with severity-ranked findings, reproductions, test-first fixes, and an explicit NOT RUN list. Do not claim acceptance for anything you did not run. Save REPORT.md and report.json under /Users/dushyant/Documents/useRAID-reviews/2026-10-10-b2-rereview-candidate/codex/. Do not implement fixes.
```
