# T006/T007 continuation — current-source identity protocol preparation

Status: **REVIEW PREPARATION READY / SELF-EVALUATED; independent design review pending Claude.** Owner resumed remaining T006/T007 identity features on 12 October 2026. One active writer, Codex; no delegation or Git publication authority inferred.

## Acceptance defined before execution

This bounded prerequisite prepares an amended lock protocol and reproducible evidence for Claude's independent challenge. The previous owner-required architecture gate in [the protocol proposal](T006-identity-lock-protocol-design.md) and its external REVIEW-HANDOFF requires a design verdict before production implementation. No verdict exists; the former Codex review stopped at its checkpoint. This continuation does not treat that checkpoint as acceptance. No production code, schema, migration, feature gate, session policy or money transition changes in this prerequisite.

1. Reconcile the proposal with current main `2992a78cc77112569740abf0522d399994c77910`, including released linked-wallet sign-in, first-X binding, disabled folds, SIWS network binding and removed creator approval.
2. Retain the original proposal and prior rejection evidence; identify incorrect ordering, implicit lock upgrades and unproven claims explicitly.
3. Exercise the known attempt graph on a new disposable PostgreSQL target with actual backend/blocker observations and unchanged outcome assertions. Record failures as failures; distinguish isolated fold-enabled probes from currently disabled application paths.
4. Exercise proposed database primitives independently of application implementation, including skipped locked rows and unique-key lock strength. Passing primitive experiments do not prove the global protocol.
5. Supply a complete amended writer matrix, root/subject selection and revalidation rules, adverse implementation test plan, unresolved owner choices and a focused Claude review brief with exact-source hashes.
6. Run document/link checks and full-task completion validators, retaining missing independent/full-task evidence as NOT VERIFIED. Record timed author evaluation and preservation of original source and resources.

## Contract map

M1 / AG03 author preparation for AG08 independent challenge. R04/R13/R15/R16; D01/D13; I05/I06/I07/I10/I11/I13; AC01/AC02 partial, AC40, AC73–AC75. Read blueprint §§00–04/07/13/16.13/24/25/27–28/30/32–35/39–40 and accepted DEC-2026-10-09-01, DEC-2026-10-10-01/02, DEC-2026-10-11-03, DEC-2026-10-12-02.

Affected records reviewed: User, OAuthAttempt, Session, XAccount, WalletIdentity, WalletChallenge, immutable Participant, WalletLink and ModerationEvent. Permissions remain authenticated self-account and fresh wallet proof; additional linking also requires the caller's own live X-authority session and connected X row. Owner selected credential-specific session invalidation (DEC-2026-10-12-05) and visible destination account ID plus connected X handle (DEC-2026-10-12-06). Suspended-account revoke and rollout of existing unattributed sessions remain unresolved. No capacity store is implemented by this task; identity must preserve its canonical participant and all historical claims.

Current production source reviewed: `src/lib/{account-merge,x-oauth,wallet-auth,worker-jobs,identity-storage-adapter,usdc,studio-sandbox}.ts`, identity-link/storage modules, admin/auth routes and actual Prisma schema/migrations. Financial writers and FK/unique/trigger locks belong in the compatibility inventory. No external X, chain, registry or staging calls are needed for these synthetic experiments.

## Evidence and handoff

The [Claude handoff](../../planning/task-evidence/T006-identity-design-20261012/REVIEW-HANDOFF.md) and [amended protocol](T006-identity-lock-protocol-20261012.md) are ready for independent design challenge. Author results: three actual current-source deadlocks reproduced with unchanged outcome assertions; one destination-binding test fails on both required visible fields; six SQL primitive checks pass; nine baseline identity/docs files pass all205 tests; all48 planning checks pass, with a final5-test fingerprint requirement rerun passing after the last blueprint wording correction. Scoped probe types and lint pass; formatting/diff checks pass. Source hashes prove no application, schema, migration or existing test change; expected linked blueprint/scenario aliases follow their declared canonical files.

Evidence is retained under `planning/task-evidence/T006-identity-design-20261012/`, including source manifest, timed self-evaluation, actual JUnit/logs and honest T006/T007 nonacceptance packets. Both completion validators exit1 for the missing independent reviewer/non-code review and all27 full-task criteria remaining NOT VERIFIED. Initial external-config and Node-type-root setup failures, original broad-filter runs and three inherited lint warnings are retained/disclosed; they are not semantic RED. No GREEN/REFACTOR application implementation is claimed by passing primitive/baseline checks.

No changed browser behavior: a new dev preview/production build/browser suite is not applicable to this design-only prerequisite and was not run. Real Phantom/X/chain, UAT, hosted CI, migration implementation/drift and release gates were not run. Application implementation remains pending the independently reviewed proposal. All prior unfinished obligations/evidence stay visible in CURRENT.md.

Ordered next work: Claude's design verdict on LP01–LP08 and the writer/host/provenance matrix; then coherent test-first protocol implementation and independent code review; then signed destination serialization and additive credential-attribution/selective-revoke composition, with rollout/suspended-revoke decisions and fresh review. Linking/folds stay off throughout; no commit/push/merge without explicit owner authority.
