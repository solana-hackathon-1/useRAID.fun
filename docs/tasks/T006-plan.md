# T006 readiness acceptance packet

Defined before compatibility inspection and verification, 8 October 2026. Baseline: `09b7706235e7dd412eb0f707e4f1d7a6ddcbb096`, accepted T004 evidence head. Role: AG03 with AG01/AG10 documentation duties. Milestone: M1 readiness; this bounded deliverable is documentation only. Full [T006 / issue #48](https://github.com/solana-hackathon-1/useRAID.fun/issues/48) implementation remains NOT VERIFIED.

User outcome: identify the safe identity implementation boundary and exact prerequisites without executing migrations, backfills, deployed audits, account mutations or provider effects. T002 contracts and T003/T004 technical acceptance are planning/test-support evidence, not deployed persistence authority.

## Acceptance defined before execution

1. Inspect actual account, wallet/provider subject, session, merge/delete and money-reference code, schema, migrations and relevant tests. Record concrete file references and distinguish existing behavior from intended canonical behavior.
2. Map T006-A01/A02/W01–W03 and all C01–C22 criteria to requirements, entities, permitted/rejected actors, transitions, meaningful future tests and current gaps. Preserve R04/R12/R13/R15/R16; I01/I07/I10/I13; AC01/73/74/75 and related D13, I03–I11, AC02/40/49/68/69. No requirement changes or new production policy.
3. Specify stable identity, collision, recovery/merge and deletion compatibility; preserve old account IDs, proof provenance, capacity, financial claims and payout authority. Never infer current verified links from historical addresses or turn legacy campaign enrollment into accepted work.
4. Carry T003 section 3 prerequisites forward verbatim in effect: named authorized custodian, approved consistent deployed snapshot, deployed source/config/schema/migration/trigger/policy parity, obligation/custody reconciliation and isolated restore/durability evidence. Missing evidence blocks dependent persistence execution.
5. Define the next genuine failing-test-first slice and R15/R16 host/adapter/consuming-example contracts; execute relevant existing nonproduction regressions and planning/document/link checks. Report exact results, environment and exclusions. Do not invent RED/GREEN for documentation.
6. Record all criterion dispositions honestly. Run the completion packet validator; absence of implementation/independent review must reject full T006 completion. Deliver a handoff with remaining evidence and a bounded next step. No self-review, UAT, business, release, merge or project-status approval.

## Initial scope map

Canonical entities: accounts/auth_sessions/identity_links/wallet_links/participants; related terms/consents/engagements/commitments/claims/audit/receipts/outbox. Existing candidates to inspect: `prisma/schema.prisma`, applied migrations, `src/lib/{auth,wallet-auth,account-merge,x-oauth}.ts`, wallet/auth routes, `src/contracts/entities.ts`, auth/wallet/provider DB tests. Identity proof grants login/link authority only; Guild roles, grants and beneficiary changes require their own authorization.

Shared ownership: AG03 identity/work; AG04 treasury; AG05 private permissions/evaluation; AG09 deployed audit/restore; AG10 documented contracts. This packet assigns no real operating custodian. O11 identity/provider/retention policy and related custody/finality decisions remain OPEN where applicable. Existing implementation is evidence to inspect, not declared compliant.

Owned outputs: this acceptance packet, `T006-readiness.md`, `T006-handoff.md` and a non-completion verification record. No runtime/schema/API/event/dependency changes are planned. Independent review and exact-head CI remain unverified until actually obtained. Future implementation must read installed Next.js guides before code edits and preserve all applied migrations.
