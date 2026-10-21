# Claude independent design challenge — T006/T007 continuation

Review the **Codex-authored current-source amendment**, not a purported completed feature: [protocol revision](../../../docs/tasks/T006-identity-lock-protocol-20261012.md), [acceptance-first task](../../../docs/tasks/T006-identity-design-20261012.md), and canonical DEC-2026-10-12-03/04 in [the blueprint](../../../RAID_AGENT_BLUEPRINT.md). Historical Claude-authored proposals and old candidate reviews are inputs; author self-evaluation supplies no independent acceptance of them. The requested verdict is limited to this new amended proposal. All full T006/T007 criteria remain NOT VERIFIED.

## Scope and source

Base application source: main `2992a78cc77112569740abf0522d399994c77910`. Application/schema/migrations and existing tests are unchanged by this preparation. Working-tree changes are the two canonical owner decisions, protocol/task/reuse documentation, top-level blueprint fingerprints, author probes, evidence and checkpoint. Pre-existing generated `next-env.d.ts`, WARP.md and nested worktrees were preserved and excluded from the candidate overlay. `source-manifest.json` identifies the exact critical current files; `self-evaluation.json` records source preservation and actual commands/results. A frozen source copy is recorded there for review, with its own manifest; install your own dependencies and use your own disposable PostgreSQL target.

No production code, route, migration, provider call, gate enablement, deployment or publication occurred. The previous design gate explicitly required independent challenge before implementation and has no final verdict. New linking and folds remain disabled in the application. No browser behavior changed, so this prerequisite has no development preview or new build claim.

## Actual author evidence

| Check                           | Observed                                                                                                                                                                                                    |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current attempt graph           | 3 executed / 3 failed, each actual PostgreSQL 40P01. Links off; folds enabled only in the dedicated synthetic probe process. Original no-deadlock/state assertions retained.                                |
| Visible destination consent     | 1 executed / 1 failed: signed bytes contain neither stable destination account ID nor connected X handle. Both soft assertions fail; no serialization policy invented.                                      |
| Proposed database primitives    | 6 executed / 6 pass, no skipped cases. Key-update lock upgrade, non-key control, three skip-locked cleanup tables, next-run attempt progress and sorted-root NOWAIT. These are not application GREEN fixes. |
| Existing baseline identity/docs | 9 files / 205 tests pass, no skips. Selected network/proof/session/auth/module/docs contracts.                                                                                                              |
| Planning                        | 48 tests pass. Final fingerprint requirement check is recorded separately after the last blueprint wording correction.                                                                                      |
| Full completion validators      | T006 and T007 each reject missing independent reviewer/non-code acceptance plus all 27 NOT VERIFIED criteria. Expected rejection; no task closure.                                                          |

Raw current-source sanitized logs and JUnit are adjacent. Earlier setup errors, original broad-filter runs and unredacted synthetic-only diagnostic logs remain in `/tmp/raid-identity-design-20261012/`; they are not semantic RED. The first external config import failed; the retained repository config corrects module resolution. Initial isolated typecheck lacked an explicit Node type root; final scoped check declares it. Initial probe lint had three inherited warnings; type annotations/unused binding cleanup resolved them without changing behavior assertions. Timing/source/check details are in the self-evaluation record.

## Reproduce safely

The probe config deliberately lives outside normal `tests/` discovery. These red cases document missing behavior pending accepted design; they do not turn normal application CI green or claim wired feature coverage. Before actual implementation, promote accepted regressions into test discovery and its CI inventory. Probes truncate all public tables in `useraid_test`; use a new disposable target, never a previous evidence database or staging.

From your isolated source copy, run exact-lock `npm ci` (retain `.npmrc`), generate its own Prisma client, and migrate your disposable PostgreSQL16 target. Set `NODE_ENV=test DEMO_MODE=false RUN_DB_TESTS=true DATABASE_URL=<your local useraid_test URL>` for every command:

```sh
npx prisma generate
npx prisma migrate deploy
npx vitest run --config planning/task-evidence/T006-identity-design-20261012/vitest.config.mjs \
  planning/task-evidence/T006-identity-design-20261012/probes/current-attempt-graph.test.ts \
  planning/task-evidence/T006-identity-design-20261012/probes/destination-binding.test.ts
# Expected current-source exit 1: four failing tests, including three real deadlocks.
npx vitest run --config planning/task-evidence/T006-identity-design-20261012/vitest.config.mjs \
  planning/task-evidence/T006-identity-design-20261012/probes/database-primitives.test.ts
# Expected exit 0: six concrete primitive checks only.
```

The author's disposable container is `raid-identity-design-20261012`, initial ID `8a48b142ca38d016c2ad34e527ec7473d64deee6ac4ace2984ce94fe946f6b75`, start `2026-10-12T07:54:55.207753377Z`, loopback64083, PostgreSQL16.15. Preserve it if inspecting evidence; use your own target for independent execution. Stop only this resource with `docker stop raid-identity-design-20261012` when no longer needed; a restart loses tmpfs state. All pre-existing databases/listener3000 are unrelated and preserved.

## Required verdict

Answer **ACCEPT FOR IMPLEMENTATION / ACCEPT WITH AMENDMENTS / REJECT**, with numbered findings/counter-schedules and actual NOT RUN items. Challenge LP01–LP08 and the complete writer/implicit-lock matrix, final lock modes, immutable advisory/root/child planning, no new acquisition by nested merge, collation/hash assumptions, strong roots versus external FK activity, separately committed cleanup and reused public module compatibility. Explicitly assess selective session provenance/rollout and visible signed destination binding; owner choices are accepted, their implementation is not.

Do not implement fixes while reviewing or approve your prior baseline implementation as independent evidence. Do not commit, push, merge, enable gates or modify the author's source. Save the review report and exact-source identity; the owner can hand it back to Codex. No agent was automatically launched or messaged by this preparation.

After design acceptance: one coherent failing-test-first protocol implementation, then attribution/migration/selective revoke and visible destination proof composition in dependency order. Suspended self-revoke and existing unattributed-session rollout require recorded treatment before enablement. A design verdict does not supply implementation review, real Phantom/devnet, representative UAT, capacity, money/recovery or release gates.
