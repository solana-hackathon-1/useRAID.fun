# T019 independent review — idempotent command receipts, audit and outbox foundation

**Verdict: ACCEPTED WITH CONDITIONS** (technical source and evidence acceptance only; no merge, issue closure, UAT, business or production approval).

- Reviewer: Claude Sonnet 5.5 independent reviewer agent, non-author (AG08 QA/security role). A separate agent context that did not write the implementation, tests, documentation or packet. It shares a model family with the implementer, so independence is role-based. The review re-executes the work and mutates the source; it does not rely on the implementer's statements.
- Reviewed: PR [#182](https://github.com/solana-hackathon-1/useRAID.fun/pull/182) (draft), issue [#61](https://github.com/solana-hackathon-1/useRAID.fun/issues/61), branch `claude/t019-command-receipts`, SHA `d38a45d544efc18aa9948c628a7b95f5960c4a2c`. Source files are byte-identical to `5ea28674c96686e8f8ddc9e6559017ae197a71fe`; `5ea2867..d38a45d` changes only `planning/task-evidence/T019.json`. Baseline `101348a0e65454ec705be17b54c3ecc29801eede`. Blueprint hash `151d00e3…547c5` matches the task registry.
- Date: 2026-10-09. Structured record: [planning/task-evidence/T019-review.json](../../planning/task-evidence/T019-review.json). Implementer material: [plan](T019-plan.md), [module contract](../raid-command-receipts.md), [packet](../../planning/task-evidence/T019.json), [example host](../../examples/command-receipts/README.md).
- Scope read: blueprint 00–04, 12, 13, 25, 26 (26.1, 26.4), 27 (27.3, 27.5), 28, 32, 24.6–24.7, task-contract criteria C01–C22/A/W, module reuse guide, PR and issue text, the full diff, plan, doc, example and packet.

## Result summary

27 criteria disposed: **19 PASS, 8 bounded NOT APPLICABLE, 0 failed.** No blocking finding. One blocking _condition_ (COND-01) is packet bookkeeping that only the implementer can do. 14 of 14 mutations were caught by existing tests, including every real-PostgreSQL race mutation. Full suite 810 of 810, feature tests 77 of 77, stable over 7 runs.

## Commands run and actual results

Environment: macOS Darwin 27.0.0 arm64, Node 26.0.0, npm 11.12.1, Prisma 6.19.3, vitest 4.1.11, PostgreSQL 16.15 in a disposable `postgres:16` container I created (`raid-t019-review-db`, tmpfs, `127.0.0.1:56906`, image sha256 `ed134ce8…eab0`). Other containers (`raid-t006-*`, `raid-t029-*`, `raid-t019-db`) were not touched. Data is synthetic.

| Check                | Command (abridged)                                                                                                                                                                                                    | Actual result                                                                                                                                                            |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Install              | `npm ci`                                                                                                                                                                                                              | 514 packages, exit 0                                                                                                                                                     |
| Migration            | `prisma migrate deploy` (empty DB, then again)                                                                                                                                                                        | all migrations applied; second run "No pending migrations"                                                                                                               |
| Drift                | `prisma migrate diff --from-url … --to-schema-datamodel prisma/schema.prisma --exit-code`                                                                                                                             | "No difference detected", exit 0                                                                                                                                         |
| Feature tests        | `RUN_DB_TESTS=true NODE_ENV=test DEMO_MODE=false vitest run` on the 3 receipt files                                                                                                                                   | 3 files, **77 passed** (46 unit, 27 real DB, 4 boundary), 0 failed, 0 skipped; 6 further repeats identical                                                               |
| Full suite           | same env, `npm test`                                                                                                                                                                                                  | **70 files, 810 passed**, 0 failed, 0 skipped                                                                                                                            |
| Static               | `npm run typecheck`; `prettier --check .`; `eslint` on touched files; `python3 -m unittest discover -s tests -p 'test_raid_*.py'`                                                                                     | clean; clean; no output; 27 OK                                                                                                                                           |
| Standalone host      | `cp -RL examples/command-receipts` to a clean directory outside the repository, own `npm install` (43 packages), `prisma generate`, `migrate deploy`, `migrate diff`, `npm start` against `useraid_command_host_test` | both migrations applied, no drift, one JSON line with all eight flags true                                                                                               |
| CI                   | `gh pr view 182`, `gh run view 37814391505`                                                                                                                                                                           | 7 of 7 required checks success at `d38a45d` (pull_request and push runs); test job logged `command-receipts-db` 27, `command-receipts` 46, `boundary` 4, 70 files passed |
| Packet integrity     | sha256 of the 11 files in `T019.json` against the tree                                                                                                                                                                | all 11 match                                                                                                                                                             |
| Completion validator | `python3 scripts/verify-raid-completion.py T019 planning/task-evidence/T019.json`                                                                                                                                     | **exit 1** as expected: `Missing report field: reviewer` plus all 27 criteria `NOT VERIFIED prevents completion` (28 lines). See "Validator" below.                      |

## Mutation results

Each mutation was applied alone, the three receipt test files run, and the source restored with `git checkout` (database mutations: dropped and recreated from the pristine migration). `git status --short` was empty after every source mutation.

| ID  | Mutation                                                                               | Caught by                                                                                                        |
| --- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| M1  | Remove the digest comparison (same key, different payload returns the original, AC69)  | 6 tests: DB sequential and waiter conflict, DB inbox conflict, unit conflict, unit inbox conflict, consumer host |
| M1b | `ON CONFLICT DO UPDATE` overwriting digest and clearing result                         | 13 failures; immutability trigger also rejects it                                                                |
| M3a | Drop unique index and `ON CONFLICT` (plain insert)                                     | 8 failures: 8-way race not one `EXECUTED`, three blocked-waiter tests time out, uniqueness guard                 |
| M3b | Keep index, remove `ON CONFLICT` (check-then-act)                                      | 6 failures: 8-way race, blocked-waiter replay                                                                    |
| M4a | Omit the outbox insert                                                                 | many: outcome, rollback, append-only, race tests                                                                 |
| M4b | Receipt/audit port built from the global client instead of the host transaction        | many; deferred result-required trigger and races fail                                                            |
| M5  | Inbox dedupe by `(provider, payloadDigest)` instead of `(provider, deliveryId)` (AC32) | 1: changed-payload conflict (see F03)                                                                            |
| M6  | New random semantic key per execution                                                  | 8                                                                                                                |
| M7  | Raw request copied into audit payload (I06)                                            | 2: real-DB dump and unit bindings                                                                                |
| M9  | Unique key and lookup without `actorId`                                                | 1: scopes key to actor and command kind                                                                          |
| T1  | Drop deferred result-required triggers                                                 | 1                                                                                                                |
| T2  | Drop receipt immutability trigger                                                      | 2                                                                                                                |
| T3  | Drop audit/outbox append-only triggers                                                 | 1                                                                                                                |
| K1  | Remove key sort in canonical form                                                      | 1                                                                                                                |

The race tests use independent backends and observe the blocked statement and blocker through `pg_blocking_pids` / `pg_stat_activity`, plus a genuine `40P01` deadlock that is retried as a whole transaction. They fail (by timeout or duplicate execution) when the serialization point is removed, so they test the real boundary and are not mocks. The module cannot write audit/outbox outside the business transaction because it only holds the injected transaction port; M4b confirms the adapter-level equivalent is caught.

Digest probes (reviewer script): object key order and Unicode key order are irrelevant; NFC and NFD forms differ; a lone surrogate differs from U+FFFD; string `"1"` differs from number `1`; `-0` equals `0`; sparse arrays, unsafe integers, `1e21`, depth over 32, class instances and values over 64K characters throw `INVALID_INPUT`; `__proto__` as an own key is hashed normally. Symbol keys and non-enumerable properties are ignored and a throwing getter propagates the raw error (F06, negligible for JSON requests).

## Specific checks requested

- **Digest canonicalization**: sound and domain-separated (`raid.command-receipts.v1`); see probes above.
- **Scoping**: unique on `(actorId, commandKind, idempotencyKey)`; lookup is scoped identically; cross-actor reuse neither collides nor reads another actor's result (M9, scoping test).
- **Result reference vs private result**: only an opaque identifier of at most 200 characters is stored; payloads are digests; audit payload is identifier-only and at most 2 KiB; at most 20 events per command.
- **Error envelope**: module throws `CommandReceiptError` with `IDEMPOTENCY_KEY_REUSED`, `DELIVERY_PAYLOAD_CONFLICT`, `INVALID_INPUT`, `STORAGE_CONTRACT`, `RETRY_TRANSACTION`, `STORAGE_UNAVAILABLE`; message equals the code, never a driver message. HTTP 409 mapping for `IDEMPOTENCY_KEY_REUSED` exists in the shared `ERROR_CONTRACT`; the host performs the mapping.
- **Whole-transaction retry and isolation**: the adapter opens a fresh READ COMMITTED transaction per attempt, verifies `SHOW transaction_isolation` once, and classifies `40001`, `40P01`, `P2034` and wrapped `P2010` as `RETRY_TRANSACTION`. The correctness of `INSERT … ON CONFLICT DO NOTHING` followed by a fresh-snapshot `SELECT` under READ COMMITTED holds: a loser blocks on the unique index until the winner ends, then replays after commit or executes after rollback (both tested).
- **Boundary**: the public module imports only `node:crypto` and the shared `../contracts` (T002); no Next, Prisma, env or global; the Prisma coupling lives in `src/lib/command-receipts-adapter.ts`.
- **Migration**: prefix `202610090001` follows `202610080001`; four `CREATE TABLE`, three functions, no change to existing objects, no backfill; drift check clean; no remote branch holds a competing prefix (the T029 branch uses `202610090002`, ordered after this one).
- **RED genuineness**: `/tmp/raid-t019/red.xml` (67 failed, 10 passed, 0 skipped) fails on assertions against a stub module (empty digest, handler pass-through) and bare tables (no keys, checks, FKs, triggers). Only two failures are `ENOENT` for the then-absent doc and example, correctly not counted as behavioral. Compared with the final tests, post-RED edits added the lock-graph and statement double check and a release hook, message-pattern alternatives for Prisma wording, and two stricter assertions; none weakens a requirement. The RED SHA in the packet is the unchanged baseline because RED was uncommitted; sources and hashes are retained locally and disclosed.
- **No wiring**: no file under `src/app`, `src/components` or existing `src/lib` services changed; existing tables and migrations are untouched.

## Per-criterion assessment

PASS means the criterion is met at the stated bounded scope with the evidence above; NOT APPLICABLE needs the stated rationale. Full records with the validator fields are in the JSON.

| Criterion                                   | Result         | Basis                                                                                                  |
| ------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------ |
| C01 scope                                   | PASS           | Foundation only; 23-file diff; baseline behavior intact (810 of 810).                                  |
| C02 authority                               | PASS           | LOCKED/DEFAULT/OPEN separated; O11/O18 not decided.                                                    |
| C03 entities                                | PASS           | Four tables, keys, FKs, immutability verified in the database and by trigger mutations.                |
| C04 permissions                             | NOT APPLICABLE | No protected route or resource; module authorizes nothing; per-actor key isolation verified under C10. |
| C05 transitions                             | PASS           | Claim, commit or rollback only; rejected commands leave nothing.                                       |
| C06 identity-capacity                       | NOT APPLICABLE | No capacity consumed; claim-first lock order documented for T020.                                      |
| C07 terms-consent                           | NOT APPLICABLE | No terms entity; digest sensitivity to a supplied terms version verified.                              |
| C08 money                                   | NOT APPLICABLE | No obligation or ledger; numeric ambiguity rejected by the digest.                                     |
| C09 privacy-access                          | PASS           | Digests, identifier-only audit, opaque results; M7 caught.                                             |
| C10 idempotency                             | PASS           | Replay, conflict, inbox, scoping and canonicalization verified; six mutation classes caught.           |
| C11 concurrency                             | PASS           | Real-DB blocked-waiter, 8-way, rollback-then-execute and deadlock tests; not mocks.                    |
| C12 external-recovery                       | NOT APPLICABLE | No provider effect; dispatch and reconciliation belong to a later worker task.                         |
| C13 experience                              | NOT APPLICABLE | No user-facing surface.                                                                                |
| C14 security                                | PASS           | Parameterized SQL, typed pre-SQL validation, sanitized errors, no env or global.                       |
| C15 operations                              | NOT APPLICABLE | Nothing enabled; rollback behavior exercised; restore rehearsal and G10 not run (COND-03).             |
| C16 verification                            | PASS           | Packet hashes match; counts reproduced; RED/GREEN real.                                                |
| C17 uat                                     | NOT APPLICABLE | No user-facing scope.                                                                                  |
| C18 handoff                                 | PASS           | Plan, doc, packet, PR body; status text must be updated (COND-01).                                     |
| A01 one outcome                             | PASS           | Sequential and concurrent.                                                                             |
| A02 conflict                                | PASS           | `IDEMPOTENCY_KEY_REUSED`, original byte-identical.                                                     |
| W01 persist digest and result               | PASS           | Row fields verified.                                                                                   |
| W02 reject changed payload                  | PASS           | M1, M1b.                                                                                               |
| W03 atomic state/audit/outbox; inbox dedupe | PASS           | Rollback matrix, M4a/M4b, M5.                                                                          |
| C19 test-driven development                 | PASS           | Semantic RED, GREEN, REFACTOR; tests not weakened.                                                     |
| C20 replaceable integrations                | PASS           | Port, scripted alternate, fail-closed capability gaps (F05).                                           |
| C21 documented reuse                        | PASS           | Doc sections complete; clean `cp -RL` host with its own install runs.                                  |
| C22 CI coverage                             | PASS           | Three files in the matrix; 7 of 7 checks at the candidate; test counts logged.                         |

## Findings

| ID  | Severity | Finding                                                                                                                                                                              | Disposition                                               |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| F01 | Low      | No retention or delete path (O11 OPEN); tables grow; `TRUNCATE` bypasses row triggers (documented).                                                                                  | Accepted; owner decision needed before production volume. |
| F02 | Low      | A duplicate of a slow in-flight command blocks on the unique index holding a pooled connection with no `lock_timeout`.                                                               | Host-owned; COND-02.                                      |
| F03 | Low      | No test that two distinct delivery ids with identical payload both process; M5 is caught only by the changed-payload test.                                                           | Non-blocking; R01.                                        |
| F04 | Info     | The "same identity on retry" assertion is closure-supplied; the guarantee is structural. Commit-then-connection-loss retry untested.                                                 | None.                                                     |
| F05 | Info     | One real adapter; substitution shown by scripted port. Acceptable under 24.6.                                                                                                        | None.                                                     |
| F06 | Info     | Canonicalization ignores symbol and non-enumerable keys; throwing getter surfaces the raw error; `DELIVERY_PAYLOAD_CONFLICT` is non-retryable and the host must map it deliberately. | Documented.                                               |
| F07 | Info     | `retryWholeTransaction` has no backoff or jitter.                                                                                                                                    | Revisit under measured contention.                        |
| F08 | Info     | `OutboxEvent` has no ordering column beyond `createdAt` and no delivery state.                                                                                                       | Worker task.                                              |

No blocking finding.

## Conditions

1. **COND-01 (blocking for the validator):** the implementer merges this review into `planning/task-evidence/T019.json` without touching source: set top-level `reviewer` to the reviewer string, replace the 27 `criteria` records with those in `T019-review.json` (they already carry every validator-required key; NOT APPLICABLE records carry `rationale`), update `status` and the `independent_review` text, and record CI at the final head. Re-run the validator.
2. **COND-02:** T020 (first consumer) claims the receipt first, sets a bounded transaction timeout (and `lock_timeout` or per-actor rate limit), maps `IDEMPOTENCY_KEY_REUSED` to 409, never exposes receipts or audit rows, and authenticates `actorId` in the host.
3. **COND-03:** restore rehearsal (AC68), retention (O11) and the outbox dispatcher/reconciler remain NOT VERIFIED and block live enablement; G01–G10 are not granted.

Recommendations: R01 add the distinct-deliveries-same-payload inbox test; R02 keep CI evidence at the final head after this review commit lands.

## Validator

The unmodified implementer packet fails by design: `Missing report field: reviewer` and 27 `NOT VERIFIED prevents completion`. To check that COND-01 is sufficient, a scratch copy (not committed) of `T019.json` with `reviewer` set and the 27 records replaced by those in `T019-review.json` was run through `scripts/verify-raid-completion.py T019`: **exit 0**, "Completion packet structure passes; independent review must verify actual evidence. No production authority granted." The validator checks structure only; this review is the substantive verification, and any later source change requires re-review.

## Limitations

Disposable-database evidence only; no live rollout, backfill, UAT, business sign-off or release approval. Restore rehearsal and outbox dispatch were not exercised. This reviewer ran on the same model family as the implementer. A sibling session overwrote a shared scratchpad helper during the review; the one affected run (a bogus pass) was discarded and repeated with private scripts, and the repository tree was verified clean.
