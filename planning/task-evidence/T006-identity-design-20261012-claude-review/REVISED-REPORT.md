# Claude independent review — revised T006/T007 identity locking design

**Verdict: ACCEPT FOR IMPLEMENTATION of the first protocol slice, conditional on amendments A1–A3 below (design only).** Reviewer Claude Sonnet 5.5, independent of the author (Codex) of the revision. 12 October 2026. This is not implementation review, UAT, real Phantom/devnet, capacity, recovery, release or full T006/T007 acceptance; all 27 criteria per task remain NOT VERIFIED.

Reviewed: [design-reconciliation.md](../T006-identity-design-20261012/design-reconciliation.md) (sha256 `43d84943…be68`), [R1-R8-decisions.md](../T006-identity-design-20261012/R1-R8-decisions.md) (`8d2e61eb…4679`). Source: main `2992a78cc77112569740abf0522d399994c77910`; `git status src prisma` empty (no application/schema/migration change). No author file modified, nothing committed, no gate changed, no agent launched.

## Executed (own PG16.15 `raid-claude-designreview-20261012`, 127.0.0.1:64121, 22 migrations; probes UTC 2026-10-12T10:01:31Z→10:01:41Z)

Scripts/results: `revised-review-probes.mjs` → `revised-probe-results.json` (`c2c455de…`, `17c25821…`), `revised-s4-probe.mjs` → `revised-s4-results.json` (`943440aa…`, `80ce0c14…`). Errors retained in full (first review truncated them); `pg_blocking_pids` waiter/blocker pairs sampled every 20 ms are in each scenario's `waitTrace`. History: first run hung (my probe's gate never opened after the writer errored on a CHECK constraint); S4 then failed on the `TEST_FUNDS` sandbox trigger and was rerun with `UsdcTransfer`. Both failures were probe bugs, not design evidence.

| Probe | Result |
| --- | --- |
| S1 R1 sign-in root vs suspension | `FOR KEY SHARE`: suspension commits while sign-in holds the root; sign-in then inserts a Session → **suspended account keeps 1 live session**. `FOR SHARE`: suspension waits on sign-in (trace 281←279), then deletes it → **0 sessions**. R1's SHARE modification is correct and necessary. |
| X1 root-less writer vs `FOR UPDATE` merge, both queue orders | `40P01` in **writerFirst and mergeFirst** (full SQLSTATE; traces 279↔281 on `DELETE Session` / `INSERT Session`). |
| X1 root-first writer (`KEY SHARE` and `SHARE`), both orders | No deadlock. writerFirst: merge waits then completes. mergeFirst: writer waits then reads **0 root rows** (account folded away) → the PLAN_CHANGED signal; it must not insert. |
| X2 unsorted multi-user FK writer vs sorted `FOR UPDATE` roots, both orders | `40P01` in both orders (traces 281↔279 on `SELECT … FOR UPDATE` / `INSERT Session`). Victim was the merge both times; not asserted as a property. |
| X2 writer taking sorted roots first, both orders | No deadlock. |
| S4 finance emptiness race (unlocked `UsdcTransfer` insert for dropped account) | Root `NO KEY UPDATE`: emptiness check sees 0 rows, merge DELETE waits then fails **23503 FK violation** (safe: account survives, transfer row kept). Root `FOR UPDATE`: root wait precedes the check, which then sees 1 row. Both fail closed; `FOR UPDATE` fails earlier. |
| S5a two `SHARE` holders both upgrading | `40P01` — confirms the no-upgrade rule. |
| S5b new `SHARE` while `NO KEY UPDATE` waits behind a `SHARE` holder | New `SHARE` granted in 9 ms, passing the queued suspension (no queue fairness): sustained sign-ins could starve a suspension. Transactions are short; record as an operational risk, not a blocker. |
| S6 trigger vs application advisory key | Trigger-held key equals `hashtextextended('wallet-subject:'||addr,0)` (`pg_try_advisory_xact_lock` false); a different label is acquirable. Contract test on the shared builder is feasible. |

## Dispositions

- **R1 (MODIFY → SHARE for status-sensitive read-only sign-in): AGREE.** S1. Keep the no-upgrade rule (S5a).
- **R2, R3, R5, R6, R7, R8: AGREE** with the design text; R3 per earlier X4. Prelocked-capability and standalone contract, AST fence, bounded re-plan, side-effect rules reviewed by reading only (nothing implemented; current `wallet-auth.ts:34–52` maps `RETRY_TRANSACTION` to 503 with no automatic retry, so the bounded retry is new behaviour needing its own tests).
- **R4 (MODIFY → pairwise 2^-64 assumption, detected aliases fail closed): AGREE.** S6 confirms builder/trigger equality is testable.

## Required amendments

- **A1 — lock-class registry is incomplete.** The design lists global, balance, subject, x-auth and mentions `finance:`/`reward:`/729103. Source also takes `tracking:<raidId>` (`tracking.ts:16`, `lockTracking`), `post:<id>` (`tracking.ts:268`), `x-endpoint:<path>` (`providers/x.ts:64,121`), 729102/729104. Observed finance order: `729103 → tracking → balance(sorted)` (`studio-campaigns.ts:227–229`, `studio-finance.ts:15,75–78`). The registry must place `tracking`/`post` before `balance` and declare which are reachable from composed identity transactions.
- **A2 — concrete X2 consumer exists.** `studio-finance.ts:80,91,114` `createMany`/`createManyAndReturn` insert FK rows for several users in allocation order (not sorted); non-credit allocation users get no balance lock (only creator + credit users, lines 75–78). With the fold gate on and `FOR UPDATE` merge roots, a settlement transaction can deadlock with a merge that targets a participating account (the merge would then be refused as non-empty, but only after locks). This is source reasoning plus the executed synthetic X2; the real code path was **not** run. The slice must convert settlement to take sorted `KEY SHARE` roots (or sorted inserts) and must add a real-code interleaving test; also plan an unlocked emptiness pre-check so obviously non-empty drop accounts are denied before any `FOR UPDATE`.
- **A3 — FK violation mapping.** S4 shows merge can end in 23503. Map it to the terminal "not activity-free" denial, not a retry or 500.

Notes (non-blocking): record the SHARE-starvation observation in operations monitoring; deadlock victim is nondeterministic; mixed-version windows stay unproven (Watchtower).

## Not run / not established

Real finance/campaign code interleavings, multi-instance and load behaviour, backlog sweeps, unique-index/trigger wait composition on real writers, unknown-commit receipt composition, real Phantom Resources display and devnet retest, staging WalletLink/Session recount (my earlier 0/2/0 count is historical), hosted CI, any implementation, independent code review, UAT, O11/recovery, G01–G10.

## Exit

Codex may proceed to **one** failing-test-first protocol slice (conversion + AST fence + standalone/prelocked consuming examples) incorporating A1–A3, then independent code review; attribution/selective-revoke and SIWS/Phantom remain later reviewed slices. Disposable DB `raid-claude-designreview-20261012` left running; stop only it with `docker stop raid-claude-designreview-20261012`.
