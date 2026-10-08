# T006 storage implementation review (Claude, owner-directed substitute)

**Status: REVIEWED WITH NO BLOCKING FINDINGS for the bounded HUMAN mapping and legacy merge guard on the disposable copy. This is not an independent review.** Owner said the Codex reviewer's usage is finished and Claude must perform the review. The reviewer (Claude Sonnet 5.5) wrote the documentation, the docs test and the final delivery checks, and continued the Codex-authored implementation; it did not write the original module, SQL or tests. Treat this as an adversarial author-side review. Any task criterion that requires _independent_ review stays NOT VERIFIED until the owner explicitly accepts this review as sufficient or another reviewer signs. Reviewed tree: HEAD `70c654f8785dc1b3a2927effe94fc879cad1d30f` plus uncommitted working tree; hashes in [WIP evidence](../../planning/task-evidence/T006-storage-implementation-wip.json). Review date 2026-10-08.

## Method

Read the module, adapter, SQL, schema diff, legacy merge diff and callers (`wallet-auth.ts`, `x-oauth.ts`), then ran mutation checks: break one protection, confirm a test fails, restore, confirm the tree and catalog match.

## Mutation results (all killed)

| Mutation                                                        | Result                                                               |
| --------------------------------------------------------------- | -------------------------------------------------------------------- |
| Remove `hasHumanParticipant` guard from `isEmptyAccount`        | 5 tests failed (unit guard, absorption, wallet flow, rollback cases) |
| Remove `FOR KEY SHARE` on `User` in `ensureHumanParticipant`    | 2 tests failed (delete-wins race, provisioning)                      |
| `ON CONFLICT DO NOTHING` → overwrite `provisionRequestId`       | 3 tests failed (retry, create/create race, separate read)            |
| Drop trigger `participant_mapping_guard_v1` (on `useraid_test`) | 2 tests failed (catalog fence, mutation rejection)                   |
| Drop FK `Participant_accountId_fkey` (on `useraid_test`)        | 3 tests failed incl. old-binary final DELETE rollback                |

Source files restored byte-for-byte (diff against saved copies). Trigger and FK re-created with the migration's DDL; catalog (constraints, indexes, trigger, columns, function md5, migration count) then diffed identical to a fresh 19-migration bootstrap, drift none, 58/58 tests green again. A first attempt to run the DB tests on a differently named database was skipped by the repository DB guard (12 skipped), so the DB-level mutations were done on the accepted `useraid_test` copy and restored.

## Findings

| ID  | Severity      | Finding                                                                                                                                                                                                                                                                 | Disposition                                                                             |
| --- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| R1  | Low           | Legacy wallet/X login now calls the adapter inside `isEmptyAccount`. If a deployment sets default transaction isolation above READ COMMITTED, the adapter fails closed with `STORAGE_CONTRACT` and the merge path errors. Neither caller sets an isolation level today. | Documented behavior; no code change. Confirm the production default before any rollout. |
| R2  | Low           | `TRUNCATE` is not covered by the row trigger and privileged schema owners can drop the trigger/FK (as the mutations above did).                                                                                                                                         | Already stated in the doc and proposal review; not a defect of the DML fence.           |
| R3  | Informational | `next-env.d.ts` points at `.next/dev/types/`; generated Next state of unknown origin, unrelated to storage.                                                                                                                                                             | Left untouched; decide before any commit whether to revert.                             |
| R4  | Informational | Provenance records creation actor/request only; no command receipt/outbox/audit event.                                                                                                                                                                                  | Documented limitation; part of later T006 work.                                         |

SR01–SR05: SR01 wallet-only drop reaching final DELETE with `pg_blocking_pids` evidence, SR02 auth-side rollback assertions, SR03 explicit READ COMMITTED check and raw/Prisma retry wrappers, SR04 genuine semantic RED before implementation, and SR05 subsequent authorization metadata are each covered by existing tests and the WIP evidence; this review re-ran the tests (58 feature tests, 731 full suite) and found no gap.

## Not reviewed / still due

Browser, build, docker and remote CI; migration on any live database; wallet linking, capacity (one-active), recovery, receipts/outbox, host-loss durability; all 27 full T006 criteria. Original source, restore and dump were not touched by this review.
