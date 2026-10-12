# Open PR verification — 10 October 2026

**Result: no new blocking source finding in the reviewed bounded slices. The recorded follow-up fixes are verified. Combined integration is still unverified, T029 cannot close, and this report grants no merge or live authority.**

Owner instruction: “review and verify.” Main remained on `3f37cc9`; no branch, commit, push, retarget, merge, GitHub review/comment or board change. Existing checkpoint edits, generated `next-env.d.ts`, the 9 October audit and `.claude/worktrees/` were preserved. Only this report, its [structured evidence](2026-10-10-pr-stack-verification.json) and the checkpoint were written in the checkout.

## Source and review boundary

| PR                           | Exact remote head                          | Scope reviewed                                               | Disposition                                                           |
| ---------------------------- | ------------------------------------------ | ------------------------------------------------------------ | --------------------------------------------------------------------- |
| #180 (now merged externally) | `54e7e774da5e6801996b10264f496de520ff9786` | Plan and proposed SQL; original independent plan review      | Accepted plan with implementation and rollout obligations             |
| #183                         | `c196ee74d74624b0089185c7b78c926e35238985` | Inert wallet-link storage, proof seam, tests, docs and host  | LR01/LR02/LR03/LR07 verified; PR-B and integration obligations remain |
| #182                         | `10de27c94857acd8763bc4a07e9aa0f5e7ec520a` | Command receipt, inbox, audit and outbox-intent foundation   | COND-01 and F03 verified; COND-02/03 remain downstream                |
| #181                         | `8e366be970f5bfc7ef5d53e596967af67fbf9a21` | Exact asset registry, integer amounts and funding predicates | K2/K4/K5 verified; C02/C08/C15 remain NOT VERIFIED                    |

The existing independent reports were checked against their delivered source and artifacts, not replaced:

- [Plan review](https://github.com/solana-hackathon-1/useRAID.fun/blob/54e7e774da5e6801996b10264f496de520ff9786/docs/tasks/T006-wallet-link-plan-review.md).
- [Wallet original review](https://github.com/solana-hackathon-1/useRAID.fun/blob/c196ee74d74624b0089185c7b78c926e35238985/docs/tasks/T006-wallet-links-review.md) and [independent follow-up](https://github.com/solana-hackathon-1/useRAID.fun/blob/c196ee74d74624b0089185c7b78c926e35238985/docs/tasks/T006-wallet-links-followup-independent-review.md).
- [Receipts original review](https://github.com/solana-hackathon-1/useRAID.fun/blob/10de27c94857acd8763bc4a07e9aa0f5e7ec520a/docs/tasks/T019-review.md) and [independent follow-up](https://github.com/solana-hackathon-1/useRAID.fun/blob/10de27c94857acd8763bc4a07e9aa0f5e7ec520a/docs/tasks/T019-followup-review/review.md).
- [Assets original review](https://github.com/solana-hackathon-1/useRAID.fun/blob/8e366be970f5bfc7ef5d53e596967af67fbf9a21/docs/tasks/T029-review.md) and [independent follow-up](https://github.com/solana-hackathon-1/useRAID.fun/blob/8e366be970f5bfc7ef5d53e596967af67fbf9a21/docs/tasks/T029-followup-review/review.md).

These non-author reviewers provide the existing independent technical acceptance. This root authored the historical wallet follow-up tests and some delivery annotations; today's reruns corroborate results and do not constitute new independent acceptance of its own edits. No human UAT, business sign-off or release approval is inferred. At entry all four were open drafts with zero submitted GitHub reviews. At the final remote check, **#180 was merged externally and #183 retargeted to main**; #183/#182/#181 remain open drafts and all four reviewed head SHAs are unchanged. Local main remains `3f37cc9`, now behind remote `9daaf85`. This agent performed neither remote action. Repository review documents and GitHub approvals are different records.

Mapping: R04/R13 (identity half), R15/R16, D13, I03/I05/I06/I09/I10/I11/I13; AC01 partial, AC02 deferred, AC28/AC30 downstream, AC29/AC32/AC41/AC69/AC73–75. Blueprint §§00–04/07/13/16/24–28/30/32–35/39–40; M1 identity, M2 receipt foundation and M4 asset foundation. Inspected actual modules, migrations, legacy wallet/X/merge boundaries, examples and tests. Affected records: User/Participant/WalletIdentity/WalletLink, CommandReceipt/InboxDelivery/AuditEvent/OutboxEvent and Asset/AssetPolicySnapshot. This audit changes no permissions, payouts or business transitions. Host authentication, authorization, verified observations and transaction ownership remain explicit dependencies.

## Executed verification

Fresh source archives were made from the exact Git objects; three independent dependency installs and reviewer-only PostgreSQL 16.15 containers used the pinned image `sha256:ed134ce8cc303c24d12c4bc6f5a2a43dc7ee7bbde8f67d9f60be5cc03206eab0`, loopback ports and tmpfs data without volumes. Original containers/databases/dumps were not touched. Commands and results are in the structured evidence and `/tmp/raid-pr-review-20261010/`.

| Check                         | #183                                                                      | #182                                                                     | #181                                         |
| ----------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------- |
| Fresh bootstrap               | 20 migrations                                                             | 20 migrations                                                            | 20 migrations                                |
| Repeat deploy / schema drift  | No pending / no difference                                                | No pending / no difference                                               | No pending / no difference                   |
| Feature suites                | 96 pass                                                                   | 78 pass                                                                  | 110 pass                                     |
| Restored feature suites       | 96 pass                                                                   | 78 pass                                                                  | 110 pass                                     |
| Full Vitest                   | 829 pass                                                                  | 811 pass                                                                 | 843 pass                                     |
| Python planning               | 27 pass                                                                   | 27 pass                                                                  | 27 pass                                      |
| Independent consuming example | Own dependencies/client; four host migrations; all output predicates true | Own dependencies/client; two host migrations; all output predicates true | Own dependencies; all output predicates true |
| Completion validator          | Exit 1: all 27 T006 criteria unverified                                   | Exit 0: bounded packet structure passes                                  | Exit 1: exactly C02/C08/C15 unverified       |

All final feature/full runs have zero failures, errors and skips. No fourth fresh full run was needed for the plan-only PR: its exact-head prior 731-case JUnit was independently parsed and its plan/proposal were compared with the reviewed version (unchanged).

Six targeted fault injections reproduced the intended failures, then safeguards/source were restored:

| Mutation                                                    | Observed assertion failures                                         | Filtered cases |
| ----------------------------------------------------------- | ------------------------------------------------------------------- | -------------- |
| Wallet D2: partial ACTIVE-only address index                | 2: non-partial catalog assertion and raw revoked-address reuse      | 35             |
| Wallet D6: remove WalletLink exclusivity trigger            | 2: raw own and foreign primary-address INSERT                       | 35             |
| Receipts F03: deduplicate by content instead of delivery ID | 1: two distinct deliveries with identical content must both process | 27             |
| Assets M24: permit extensions on native SOL                 | 1: native extension profile rejected                                | 21             |
| Assets M26: omit token-program chain-verification check     | 1: unverified token program rejected                                | 15             |
| Assets M30: remove recipient ceiling                        | 1: more than 1024 recipients rejected                               | 39             |

These are test-gap mutation checks, not newly invented implementation RED phases. Earlier RED/GREEN/REFACTOR records remain separate. Verified all 108 imported/historical artifact references checked, 941 reviewed critical source/example/test/migration hashes, and four locally retained original wallet TDD artifacts. Wallet document/envelope hashes differ from the historical review manifest only for disclosed later acceptance annotations; runtime, tests, schema and migration hashes match. The historical raw manifest was preserved.

Prior local CI was audited for **all four heads**: each candidate SHA matches, each `results.txt` has 22 exit-zero steps, and JUnit has 731/829/811/843 cases with no failures/errors/skips. Each browser set records **demo 49 pass / 1 skip, Studio 44 pass, live 38 pass / 6 skips**. Step exit zero does not certify skipped browser cases. Prior log roots are `/tmp/raid-local-ci-pr180`, `-pr183`, `-pr182`, `-pr181`. No fresh Docker/browser/build/live-flow run was performed in this review.

GitHub readback also finds the seven named checks successful on each exact head (two historical workflow runs per head). These predate manual workflow disablement; today's local runs did not create hosted checks. Branch-protection inspection returned HTTP 403 with a GitHub plan restriction, so required-check/approval enforcement is unverified.

## Conditions reconciled

| Condition | Verified status and remaining obligation                                                                                                                                                                  |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WR01      | Sanitized SQLSTATE/Prisma classification, no error-message/constraint-name parsing; safe conflict insert/read and real-wrapper privacy tests pass.                                                        |
| WR02      | Explicit FK names, fresh bootstrap, redeploy and empty drift verified.                                                                                                                                    |
| WR03      | Reader/writer inventory records legacy-only payout paths and studio/merge writers; new links remain unwired.                                                                                              |
| WR04      | Connected-X choice is recorded in PR183 DEC-2026-10-09-01. Actual server enforcement, revoke, T007 AC02 and instance rollout remain PR-B pre-enable gates.                                                |
| WR05      | Existing primary required; rejection creates no participant/link.                                                                                                                                         |
| WR06      | Preservation/fold-denial behavior and docs verified. Truthful host error copy and reviewed O11/W03 recovery follow-up remain PR-B.                                                                        |
| WR07      | Legacy writes fail closed and roll back. Linked-wallet sign-in, suspended/revoked handling, typed race conflicts and rollout remain PR-B.                                                                 |
| WR08      | Restriction/session/proof checks precede replay; suspended replay test passes.                                                                                                                            |
| WR09      | Preexisting participant provenance and payout/history snapshots preserved; AC01 capacity half remains unverified.                                                                                         |
| WR10      | Original two-phase RED caveats preserved; required legacy/race/classification/cap tests pass. Original TDD artifacts checked, not fabricated.                                                             |
| WR11      | Strict stored-message proof derivation passes; generator's shared constants remain LR04.                                                                                                                  |
| WR12      | Documented lock order and actual pg_blocking_pids race tests pass in the feature suite.                                                                                                                   |
| WR13      | PR-A/PR-B split preserved; no route/flag/sign-in integration in these heads.                                                                                                                              |
| WR14      | Challenge replay barrier/reservation/receipt wording recorded; ordered 001/002/003 prefixes need no renumbering. Combined bootstrap/CI remains LR06.                                                      |
| LR01      | Verified raw revoked-address INSERT and unconditional index assertion; D2 caught.                                                                                                                         |
| LR02      | Verified raw own/foreign primary INSERT assertions; D6 caught.                                                                                                                                            |
| LR03      | Seventh UNIQUE_CONFLICT code and sanitized 409/rollback host mapping documented.                                                                                                                          |
| LR04      | Deferred to PR-B: share generator Chain ID/statement constants or pin divergence.                                                                                                                         |
| LR05      | Decision recorded; server confirmation/revoke/flag/conflicts/fold copy/recovery/T007/rollout and separate PR-B review still required.                                                                     |
| LR06      | #180 merge and #183 retarget happened externally during review; combined-head migration/test/CI verification and owner authority for remaining merges still required.                                     |
| LR07      | Independent reports/evidence retained and linked; full T006 remains unverified. Historical pending wording is RV01 below.                                                                                 |
| COND-01   | Reviewer and 27 reviewed criteria merged; runtime unchanged; bounded validator passes.                                                                                                                    |
| COND-02   | Documented T020 obligation: authenticated actor, receipt first, bounded transaction/lock wait or rate limit, deliberate 409 mappings and private receipts/audit. Consumer enforcement not delivered here. |
| COND-03   | AC68/O11/outbox dispatcher/reconciler remain unverified and block live enablement.                                                                                                                        |
| K1        | OPEN: C02/C08/C15 still unverified; requires O07/G04/G10 and T031–T033/T080. T029 cannot close.                                                                                                           |
| K2        | All three missing assertions verified; M24/M26/M30 caught.                                                                                                                                                |
| K3        | Documented T069 prerequisite: typed mint/freeze/upgrade/permanent-delegate authority roles and retained freeze powers before O07/G04 approval. Not implemented.                                           |
| K4        | All 11 stored original/follow-up JUnit hashes verified. Weaker missing-table DB RED remains disclosed.                                                                                                    |
| K5        | Reviewer/criteria/status merged; exact final-head historical checks confirmed. Historical CI citations are preserved; latest delivery annotation remains RV01.                                            |
| K6        | Documented downstream rules: fullyFunded gate, balances/claims keyed only by assetKey and allowlist from an approved decision. Consumer enforcement remains unverified.                                   |

## Integration and findings

**Predicted text conflicts were not reproduced.** Six pairwise `git merge-file -p` checks and eight ordered file-only merges from current main through #180 → #183 → #182 → #181 exited zero for `prisma/schema.prisma` and `planning/raid-ci-matrix.json`. The temporary combined schema validates, the matrix parses with 94 unique test paths, and all 14 new feature test paths remain registered. No Git merge, combined repository/head or combined-head CI was created. Text compatibility and schema syntax do not prove all 22 migrations or cross-module behavior together.

**RV01 — Low, evidence wording:** some packets retain historical “awaiting independent follow-up verification” or “final candidate CI pending” labels despite later accepted reports and exact-head checks. Examples: PR183 top-level status/LR01/LR02 fields and imported report annotation notes. Add a current delivery annotation in the next packet update while preserving the historical manifests/reports; no runtime fix is required. This audit is the current reconciliation, not permission to overwrite earlier evidence.

No new blocking source defect was found. Earlier identity-storage independent acceptance, full T006, recovery, human UAT, business/release approval and all dependent live gates remain outside the supplied evidence. Authenticated string equality cannot replace host authentication, a declared CHAIN_VERIFIED observation cannot prove a chain effect, and an empty default production allowlist must remain fail-closed.

Harness errors were retained honestly: the first artifact script had an indentation error; the first standalone copy nested the example directory and produced ENOENT; the first text-merge summary queried an incorrect JSON field; the first source-restoration checker treated a directory symlink as a regular file. The corrected Git-mode-aware check verifies all src/tests/prisma entries against exact-head bytes. Corrected checks passed. None was counted as genuine implementation RED or a source finding.

Report validation: 76 documentation/evidence tests passed with zero failures/errors/skips; owned report/JSON/checkpoint formatting, local links and `git diff --check` passed.

## Ordered next steps

1. Prepare and verify an actual combined integration candidate, preserving every schema addition, test registration, migration byte and the PR183 canonical decision/hash refresh. Run fresh bootstrap/redeploy/drift and all 22 local-CI steps on that combined source, recording browser skips and exact source/runner identity.
2. The #180 merge and #183 retarget preconditions are now fulfilled externally. Remaining Git/merge actions still require explicit owner authorization. This review makes no merge, closure or live decision.
3. Carry LR04/LR05 and WR04/WR06/WR07 into separately reviewed PR-B; retain server-off/T007/rollout gates and full T006's 27 unverified criteria.
4. Keep COND-02/03 and K1/K3/K6 visible on their consumers/policy/recovery tasks. T029 stays open until the three missing criteria have actual evidence.
5. When delivery packets are next updated, resolve RV01 with current-head annotations; retain all original review/TDD evidence. Do not infer human acceptance or branch-policy enforcement from technical test results.
