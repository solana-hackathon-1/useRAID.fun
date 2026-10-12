# T006 B1 continuation on combined main

Status: IMPLEMENTED_UNVERIFIED; final independent B1 review and all27 full T006 criteria remain NOT VERIFIED. Base main `66d6a3a05936df54c8dbca150b7c3bea6e6134be`. Codex `/root` continued the preserved B1 implementation at the owner’s request. No branch change, commit, push, PR, merge, board/issue update or live enablement occurred.

## Repository and issue status

The four prior PRs #180/#183/#182/#181 are merged. GitHub has161open issues, no open PRs; T001–T004 are closed. T006 remains open for auth/capacity/recovery integration, T005 remains open on O18/staging, and T029 C02/C08/C15 remain unverified. Hosted workflows are disabled; current verification is local. The earlier independent review conclusions apply to their recorded exact sources; the stale pre-merge handoff was reconciled without removing history.

## Delivered bounded behavior

Imported the unfinished B1 delta from `codex/t006-wallet-links-b1` at `c196ee7` into the current main working tree, preserving its original checkout, genuine historical RED/GREEN artifacts and existing main edits. The reusable module resolves primary/additional wallet ownership under transaction-held locks and revokes an additional credential while retaining permanent reservation/provenance. Shared challenge vocabulary keeps legacy purposes unchanged and rejects unsupported intent before persisting a challenge. Public contracts, same-change docs and an independently installed consumer are included.

A fresh real PostgreSQL race reproduced a material defect: under database-default REPEATABLE READ, legacy rotation waited for an additional link to commit, then incorrectly claimed that same address. RED expected P2002 but received NO_ERROR. Explicit READ COMMITTED on the rotation transaction makes the unchanged selected race pass: original payout wallet retained, challenge unconsumed, additional ownership preserved. Refactored regression additionally covers SERIALIZABLE and verifies no rotation audit on the losing transaction. The preserved delta also explicitly sets READ COMMITTED for wallet verification and X connection; permitted account folds pass under both higher defaults. No applied migration or schema was changed.

Requirement map: R04/R13(identity half)/R15/R16; I05/I10/I13 and preservation of I01/I06/I07/I11; D01/D13; AC01 partial, AC40, AC73/AC74/AC75; blueprint §§07/13/16.13/24.6–24.7/25–28/30/32/33.5/34.1/35/39–40. Entities: User, immutable HUMAN Participant, WalletIdentity, WalletLink and WalletChallenge. Resolver results are internal transaction context, not authentication. Revoke is ACTIVE→REVOKED for a trusted self-session; primary wallets and financial/history rows are protected. Host audit and session invalidation remain B2 dependencies before non-test acknowledgement.

## Actual verification

[Structured evidence and commands](../../planning/task-evidence/T006-wallet-links-b1-resume/verification.json), [source manifest](../../planning/task-evidence/T006-wallet-links-b1-resume/source-manifest.json), [preserved original work](../../planning/task-evidence/T006-wallet-links-b1-resume/original-work-preserved.json).

- Genuine rotation RED:1failure/26explicit filter exclusions; same GREEN:1pass/26filtered. Actual pg_blocking_pids/PID evidence, no timing-only proof.
- Focused9suites160PASS; full83suites1051PASS,0failures/errors/skips. Independently installed archive also1051PASS;357critical files match current source.
- Typecheck, owned lint,32planning checks, formatting and security audit pass. Root lint includes existing warnings from preserved worktrees; no new owned-file warning. Initial formatter failure retained; separate checkout paths and byte-exact historical review imports are excluded without rewriting them.
- Fresh22migration bootstrap/redeploy/no drift on a new pinned-image tmpfs database. Own43-package consumer/client/4migrations on its own separate database;all14flags true.
- Docker image, runtime dependency/file checks, production build and existing synthetic live-flow pass. Existing browser suites: demo49pass/1skip; Studio44pass; live38pass/6skips. These are compatibility checks, not new B2/B3 UI acceptance or human UAT.
- Local CI initial aggregate exits1:21of22layers pass; only planning rejected the temporary runner provenance adaptation. Canonical runner was restored and32planning checks reran successfully. [Original result](../../planning/task-evidence/T006-wallet-links-b1-resume/local-ci/results.txt) and failed log remain; this is not presented as a clean aggregate22-step run.
- Full T006 completion validator exits1 with exactly all27criteria NOT VERIFIED. Existing packets and historical reviews are not rewritten as task acceptance.

## Review boundary and next task

[Historical independent storage review](T006-storage-independent-review-record.md) and B1 core mutation evidence were recovered with exact import hashes. Four current core/proof source files match that prior independent probe; later auth/rotation/test changes are outside it. Final complete B1 non-author review remains required; current author verification does not supply it. Actual runtime least-privilege/noTRUNCATE/schema/trigger powers remains a rollout condition.

Next: independently review the current B1 manifest, then implement B2 trusted connected-X/fresh-proof/session-provenance and invalidation/audit composition, routes and default-off server switch under DEC-2026-10-09-01. B3 visible controls follow that server contract. Keep T007 AC02, capacity/recovery/beneficiary paths, O11/O18/O07,AC68/G10 and human UAT/business/release obligations open. New disposable resources and all original resources are retained for review; no live provider or database was used.
