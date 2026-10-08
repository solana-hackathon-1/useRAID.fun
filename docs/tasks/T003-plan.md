# T003 — acceptance-first task packet

Prepared 8 October 2026 (Asia/Kathmandu), before the migration-plan deliverable. Source baseline: `13dd7ff6b0d097270c1d9a3b2ee8c3c8b99404eb`; task [#45](https://github.com/solana-hackathon-1/useRAID.fun/issues/45), M0, AG01/AG03/AG10. Authority: [canonical blueprint](../../RAID_AGENT_BLUEPRINT.md), [27 numbered criteria](../../planning/raid-task-contracts.json), [reuse contract](../raid-module-reuse.md).

## Outcome and boundary

Deliver a reviewable additive migration, backfill and rollback **plan** that protects existing campaign history and financial rights while future features adopt the accepted T002 boundary. Implement no migration, backfill, route, module, provider switch or production action. T001's deployed-obligation/policy audit and restore condition remains mandatory before any migration execution; its absence does not prevent writing the plan. No guessed consent, canonical identity, asset verification or zero-obligation assumption.

Prerequisites: recorded T001 inventory acceptance plus independent C22 retest; recorded T002 acceptance at `798f64f`, integrated at the baseline. Verify actual schema/contracts instead of relying on those reports alone. Existing draft PR #175 remains separate. Do not change issue/board state, close issues, merge or enable features.

## Acceptance defined before execution

1. Map requirements R04/R11/R13/R15/R16, D01/D03/D06/D12/D13 and I01–I13 to inspected files, canonical entities, permissions, state transitions and meaningful future verification. Keep LOCKED/DIRECTION/DEFAULT/OPEN/EXAMPLE separate.
2. Name real legacy tables, constraints/triggers, identifiers, mutable policy gaps, incomplete FK links and existing migration data effects. Record a baseline SHA-256 manifest for all applied-migration source files and verify unchanged contents after writing.
3. List staged schema additions and backfills with owning tasks, keys/FKs, immutable fields, compatibility and per-stage entry/exit checks. Preserve campaign states and distinguish them from work engagements. Later feature schemas remain later work.
4. Specify an authorized read-only deployed audit, exact per-asset liabilities/policy evidence, mismatch handling and sensitive-data boundary. Preserve every historical obligation/receipt/destination; unknown facts block dependent migration and never become invented snapshots.
5. Specify concurrent-writer coordination, canonical participant/operator capacity, same-key altered-payload conflict, durable receipts/outbox and stale-worker recovery. Name real database/provider tests required before each implementation.
6. Define old/new reader and worker compatibility, expand/backfill/verify/cutover sequencing, an isolated restore rehearsal with recovery watermark, stop conditions and rollback limits. Code rollback cannot undo payments, grants or accepted commitments.
7. Populate all 27 criterion records honestly, obtain distinct review, run planning/document checks and the completion validator. Missing source-candidate CI or deployed/recovery evidence stays unverified; no self-approved exclusions or fabricated RED/GREEN.

## Owned records and verification

Owned: this acceptance packet, `T003-migration-plan.md`, `T003-handoff.md`, review/verification/criterion records under `planning/task-evidence/`, and the T003 entry in [task progress](../raid-task-progress.md). Inspect `prisma/schema.prisma`, all migration paths/hashes and relevant SQL, `src/contracts/`, identity merge, state/finance/config/queue/worker code and relevant tests. No implementation files change.

Read blueprint 00–04/13; identity 07; access 10; money 16; architecture/data/API/events/security/config 24–29; recovery 30; roles/milestone/acceptance 33–35; done/handoff 39–40. Plan-only permission is local documentation editing; no customer or financial state transition. Future actor/resource/state matrices belong in the deliverable.

Use existing planning tests, documentation link/script checks, formatting, unchanged schema/migration hash checks, and an independent review of source facts. Nested task links need explicit validation because the existing docs test only enumerates root documents. Run the packet validator and retain a rejected result when evidence is missing. Coding TDD is not applicable to this non-code deliverable: acceptance is defined here first under I13/C19. Future implementations require genuine failing behavior tests, not this plan's prose. R15/R16 requirements are mapped to future modules; no adapter/module delivery or independent-host execution is claimed here.

OPEN O01–O19 and G01–G10 retain their feature-specific authority. Naming a technical phase, diagnostic query, proposed table or test environment does not select custody, hosting, retention, fees, finality or production policy. The next bounded step is an authorized environment audit/compatibility review before migrations, with T004 supplying unmistakably synthetic fixtures independently.
