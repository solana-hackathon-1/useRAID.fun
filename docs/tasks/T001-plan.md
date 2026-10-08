# T001 — Inventory existing behavior and protect legacy obligations

Started: 7 October 2026 (Asia/Kathmandu). Issue: [#43](https://github.com/solana-hackathon-1/useRAID.fun/issues/43). Parent: [E01 #3](https://github.com/solana-hackathon-1/useRAID.fun/issues/3). Milestone: M0 / forecast S01.

Implementation/preparation owner: Codex, acting in AG01/AG03/AG10 preparation roles. Independent reviewer: unassigned; a real reviewer must accept the evidence before Done. Branch: `codex/t001-repository-inventory`. Baseline: `9fd686207da5e20d1e233b863dc736c28a55062d`, initially clean.

## Acceptance defined before inventory execution

This is a documentation and inspection task. It changes no application command, provider adapter, schema, customer record, permission, financial policy or deployment. No RED/GREEN/REFACTOR coding cycle is claimed. C19/I13's non-code exception requires independent review of this boundary.

1. T001-A01/W01: inventory links to inspected source, all migration families, tests, CI, flags and prior verification. Separate source-observed behavior from actually executed results and production facts.
2. T001-W02: map participant, Guild, terms, work, money and access to concrete existing models/commands, keys, state machines, allowed/denied actors, reuse candidates and gaps.
3. T001-A02/W03: identify persisted obligation/policy fields and their compatibility path. Do not assert a live count or absence of obligations without authorized environment evidence. Preserve old identities, policy versions, exact amounts, beneficiaries, receipts and audit history.
4. C01–C22: provide an evidence record for every numbered criterion, including the proposed documentation-only boundary where behavior testing belongs to a later task. All records start NOT VERIFIED; independent acceptance/exclusions remain pending.
5. Run repository planning/document checks, relevant existing baseline tests and the completion-packet validator; record real failures/skips rather than weakening checks. Candidate CI and independent review remain distinct from local baseline verification.

## Authority and mapping

Authority: [canonical blueprint](../../RAID_AGENT_BLUEPRINT.md), [task contracts](../raid-agent-task-contracts.md), [reuse contracts](../raid-module-reuse.md), `planning/raid-task-contracts.json` packet T001. Required initial reading: 00–04/13; architecture/data/API/events/security/configuration 24–29; roles/milestone/acceptance/handoff 33–41; adjacent identity 07, access 10, money 16 and recovery/testing 30/32.

LOCKED: R01–R16. Invariants: I01–I13. DIRECTION: P01–P08 retained as direction. DEFAULT: D01–D13 remain defaults; existing code is not an owner-approved replacement. OPEN: O01–O19 unresolved unless an actual accepted decision record is found. EXAMPLE: sample amounts, thresholds, IDs, JSON and SQL are illustrative and cannot become approved policy. Acceptance references include AC01/02/07/11–23/26–41/42–49/66–75 as inventory and future verification targets, not passing implementation claims.

Affected canonical concepts inspected: accounts, participants, Guild roles/tokens, terms, engagements/capacity, assets/obligations/claims, command receipts, jobs/outbox and audit. Actual equivalents and absent entities will be listed in the inventory. Development access supplies no customer, resource-grant or treasury authority. Shared-contract role ownership is AG03 with AG04 treasury, AG05 access/trust and AG10 documentation; named human approval owners are not yet established.

Task state: NOT_STARTED → IN_PROGRESS by the owner's “Start” instruction; no customer state transition or capacity acquisition. Repository inspection and local test fixtures only. New behavior, contract freezing, migrations/backfills, fixture implementation and versioned authorization belong to T002/T003/T004/T089 and their dependencies.

## Deliverables and handoff

- `T001-inventory.md`: source map, preservation register, permissions/state map, reuse gaps, verification and prioritized follow-up.
- `../../planning/task-evidence/T001.json`: all numbered criteria and actual evidence; no fabricated independent approval.
- Sanitized local verification artifacts and a reviewable PR referencing #43 without automatically closing it.

An inventory cannot settle unresolved business policy or authorize production. Existing live customer data and on-chain/provider state will not be read through undisclosed credentials. If no approved live snapshot is available, actual outstanding-obligation counts and policy distributions stay NOT VERIFIED and are handed to T003 as a pre-migration condition. E01 remains incomplete.
