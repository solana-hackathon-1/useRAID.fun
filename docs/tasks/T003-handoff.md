# T003 planning handoff

Status: **IN_PROGRESS, planning only; independent review and exact candidate CI pending**. No migration/backfill/deployed audit/restore has been executed. Issue #45 and E01 remain open; no board, merge, UAT, business, release or production approval follows.

Outcome: [acceptance-first packet](T003-plan.md) and [migration plan](T003-migration-plan.md) map canonical requirements to actual legacy tables, preserved finance/state guards, proposed stages, permissions, concurrent-writer coordination, audit/recovery evidence and rollback limits. Source baseline is `13dd7ff6b0d097270c1d9a3b2ee8c3c8b99404eb`; acceptance-first commit is `149e4651497bfa26827b8148648f6a9dc26723a2`.

The plan keeps old social campaign enrollment distinct from accepted work; preserves CUID/provider/mint IDs, destinations, append-only ledgers, policy versions and receipts; requires merge/deletion compatibility before new account-linked persistence; and names seven unvalidated legacy state checks. Future stages cover identity, Guilds, receipts/outbox, accepted terms/capacity, exact treasury, constraint validation and later feature-owned schemas. No schema/API/event/command/module behavior changed, and no applied migration was edited.

Actual local checks and hashes will be recorded in [verification evidence](../../planning/task-evidence/T003-verification.json). All 27 criteria are retained in [the evidence packet](../../planning/task-evidence/T003.json). Missing independent review, candidate CI and deployed audit/restore evidence must stay accurately unverified until supplied; earlier source checks cannot verify these documents.

Authority/privacy/money effects: local documentation/evidence only. No live data or private values exported, account rights altered, financial amount/beneficiary changed, capacity acquired or provider effect dispatched. No new module is claimed reusable; R15/R16 obligations are mapped to future implementations with same-change consuming examples/tests. Non-code acceptance was defined first; no fabricated behavioral RED/GREEN.

Next bounded step: obtain the named authorized environment custodian, approved read-only snapshot, deployed source/config/migration/trigger parity, policy/consent/obligation/custody reconciliation and isolated restore/durability evidence described in plan section 3 **before any migration execution**. Actual outstanding amounts, deployed constraints and restore assurance remain NOT VERIFIED. Independent T004 synthetic fixtures may proceed without live data but cannot satisfy that audit. Named operations/rollback/case owners and OPEN decisions remain unassigned/unresolved.

Rollback: these documents have no customer state to undo. Future schema/data rollback must preserve acknowledged terms/consents/capacity/financial/access history and semantic IDs. Application rollback cannot undo chain/provider effects; retain compatible claims/reconciliation and fail closed when recovery authorization is missing.
