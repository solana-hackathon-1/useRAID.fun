# Identity locking protocol v1

Status: implementation candidate, **SELF-EVALUATED; Claude's independent implementation review pending**. Approved design and A1–A3 authority are in [the review packet](../planning/task-evidence/T006-lock-slice-20261012/REVIEW-HANDOFF.md). This is the bounded locking slice of T006/T007, not wallet-linking delivery or release approval. R04/R13/R15/R16, D01/D13, I05/I06/I07/I10/I11/I13, AC01/02 partial, AC40/73–75 apply.

## Purpose and non-goals

Prevent the demonstrated child-before-root, User-lock-upgrade and unsorted multi-user FK cycles while preserving existing account authority, payouts and canonical participant history. Linking/folding stay disabled. Attribution, selective invalidation, SIWS destination Resources and real Phantom acceptance are separate gates. No schemas, migrations or deployed settings changed.

## Dependency and host contract

`src/identity-locks` depends on a supplied `LockTransaction`: PostgreSQL, READ COMMITTED, parameterized SQL on **one live connection and transaction**, no autocommit/multiplexing. The host owns begin/rollback/commit, DB clock and proof/provider verification, live authority checks, stable operation IDs, retry classification and deadlines. The package imports no ORM, app singleton, environment or framework.

The RAID host uses the cached Prisma identity port and `src/lib/identity-protocol.ts`; the same transaction must yield the same port object for composition. Every new transaction gets a new port. Standalone callers own the transaction and must roll it back on any error. Always construct resources with `lockResource`; its frozen descriptors and the closed registry are the supported contract.

Default layout is the full RAID identity schema. An independent minimal host may explicitly declare immutable `identityLayout` metadata: `xKeyColumn: null` only when no permanent-X module is installed, and a closed installed child-table inventory containing Participant/WalletIdentity/WalletLink for the link module. RAID never supplies the reduced layout. Such metadata is trusted host configuration, never request input or automatic schema discovery. Its scope must be independently checked against installed writers/authority hooks; a host using X/session authority must install and declare those children. Pure participant provisioning reads only User.id and Participant, so does not require User.suspended or the other modules. The example schemas themselves were not modified.

## Public interface

Version `LOCK_PROTOCOL_VERSION='v1'`; closed `RootMode`; `lockResource`, `advisoryKey`, `acquireAdvisories`, `acquireAccountRoots`, `acquireIdentityChildren`, `prepareModuleIdentity`, `sealIdentityLocks`, `requireIdentityLocks`, `endIdentityLocks`. `tryAdvisory` permits only the existing nonblocking tracking rehome probe. `IdentityLockCapability` is opaque and transaction-bound; a boolean, cast object or foreign capability is rejected. `IdentityStorage`/`IdentityLink` v1 inputs add optional `locks`; `lookupWalletLink` adds an optional third capability argument. Standalone behavior remains available.

## Entity and state ownership

Acquire advisory exclusions first, then the full sorted User set once, then ordered concrete child PKs: OAuthAttempt(stateHash), XAccount(userId), Session(tokenHash), WalletIdentity(address), Participant(id), WalletLink(id). Use JavaScript code-unit sorting, not database collation to determine acquisition. Owned arrays/maps are transaction-local. Snapshot changes require rollback/replanning; never append a User/key after roots, discover a stronger mode later, or upgrade a held lock. New User IDs are chosen before retries and declared absent; uniqueness subjects serialize creation before child FK writes.

| Planned effect/predicate                                              | Final User mode |
| --------------------------------------------------------------------- | --------------- |
| Delete User, first/change xId, merge key recipient                    | UPDATE          |
| Non-key User write; account-wide identity aggregate                   | NO KEY UPDATE   |
| Stable restriction/authority read through sign-in or session issuance | SHARE           |
| Pure existence/FK reference, no non-key authority predicate           | KEY SHARE       |

Wallet sign-in and X start use SHARE where read-only; Session replacement children use UPDATE upfront. Same-X reconnect omits xId assignment and uses NO KEY UPDATE. Fold plans allow both directions and preplan both candidate roots at UPDATE; standalone absorb uses UPDATE for drop and for keep only if it receives xId. Human provisioning alone uses KEY SHARE. Finance plans creator SHARE for the existing restriction predicate, recipients KEY SHARE, all in one sorted root set. The creator restriction is re-read under that root before settlement inserts.

## Permissions and trust boundary

Observations before acquisition are planning hints. Re-read ownership, permanent keys, restrictions, retained attempts, sessions and proof lifetime after waits; use `clock_timestamp()` in a separate statement. Anonymous OAuth attempts are supported. Old-session deletion is limited to the resolved own account and prelocked concrete PK. Operator suspension retains the existing request-authentication contract and all-session invalidation, with target root before children. This slice does not certify every unrelated operator permission interleaving.

The mutation facade rejects stronger effects without adequate roots, child writes without declared child coverage/strength, User ID changes, nested relation writes, unplanned subjects/X keys and broad mutations lacking an own root. Module authority hooks are trusted read-only observers of prelocked resources; they cannot acquire later resources or perform provider/network calls. The host must not bypass the SQL/Prisma boundary using unreviewed extensions, reflection, other languages or external database writers.

## Configuration names

No new deployment configuration. `WALLET_LINKS_ENABLED` and `ACCOUNT_FOLDS_ENABLED` remain default-off and were explicitly false in the author preview. Existing isolated DB fixtures temporarily exercise gated code; they do not enable any web/worker deployment. Test-only `RUN_DB_TESTS`, `DATABASE_URL`, `STUDIO_SANDBOX`, `NEXT_DIST_DIR`, `APP_URL`/`NEXT_PUBLIC_APP_URL` identify disposable storage and development preview. No credential values belong in handoffs.

## Transaction, retry and sanitized errors

Registry order: global(729102/729103/729104, sorted), finance, reward, x-endpoint, tracking, post, balance, wallet-subject, x-auth; IDs sorted within each class. Required finance path is 729103 → tracking → sorted balances → sorted roots. The existing tracking rehome try-lock never waits and is the explicit lower-class exception; subsequent blocking post locks remain sorted. Fixed keys and existing label bytes/seed0 are preserved.

The key builder asks PostgreSQL for `hashtextextended(label,0)::text`, preserving signed bigint precision. Both exclusivity triggers are tested against it. Reject detectable within-plan/held-key aliases and fixed-key aliases. **No collision-free guarantee across different plans** is claimed; rare undetected aliases and unique-index/trigger waits remain independent-review/load risks.

`runCommandTransaction` defaults to three fresh whole-transaction attempts within 15 seconds, short bounded jitter between attempts, and transaction maxWait/timeout capped by remaining budget. Retry only PLAN_CHANGED and typed deadlock/serialization conflicts (40P01/40001/P2034). Known storage/link RETRY_TRANSACTION codes participate. Unique/proof/expiry/restriction denials and unrelated errors are not retried. Stable token/account/request identities remain outside retries; provider exchange remains outside callback retries. Rollback includes nonce claims, session replacement, credential changes and audit. Unknown commit outcomes are not blindly retried; durable command-receipt composition/reconciliation remains a later verification gate.

A2 unlocked activity-free precheck runs before strong merge roots, then guarded emptiness is rechecked. A3 catches only User-delete FK violation (23503/P2003 or raw P2010.meta.code=23503): terminal HttpError409 account-not-empty, no query after the aborted delete, no retry. Other delete errors propagate unchanged. This is not a catch-all database denial.

## Substitution and versioning

Standalone module calls acquire their own prefix; already-locked composition supplies the same live port's capability with final account modes, full subject coverage and adequate child locks. Inner modules validate and skip acquisition. They cannot extend/upgrade that plan. Repeated aggregate calls in one transaction require explicit prelocked composition, not a second standalone invocation. A second transaction needs a fresh port/capability. Fake ports must implement the expanded SQL read/key/transaction-ID contract; unit fixtures are not PostgreSQL safety evidence.

Mixed legacy/new writers are not certified. Drain or isolate old writers, verify all instances/fixtures/worker versions and keep folds/linking off until independent finance/identity/rollout review. No schema migration or new version deployment is part of this candidate.

## Observability

Retain operation outcome, retry reason/count, SQLSTATE, backend blocker graph and bounded timing without signed messages, token hashes or provider credentials. Current proof logs use synthetic fixture IDs and statement shapes. Monitor queued suspension starvation under SHARE, lock wait tails, retry exhaustion and cleanup age/backlog before enabling new behavior. Load/fairness and all finance interleavings are NOT VERIFIED.

## Failure and recovery runbook

Expired Session/OAuthAttempt/WalletChallenge sweeps use their own leaf transaction statements: materialized sorted selection, LIMIT100, FOR UPDATE SKIP LOCKED, at most ten batches and a one-second between-batch budget. Worker `<` and X-start `<=` expiry boundaries are retained. No later root/advisory mutation follows a leaf. Exact-PK logout/attempt-claim/discard are named leaf exceptions. A catalog regression rejects new incoming FKs or delete-side user triggers on cleanup tables. SKIP LOCKED does not skip DDL/relation locks; the loop budget does not guarantee a hard statement deadline.

Do not acknowledge identity success before commit. Replan on observed set/mode changes; fail after bounded exhaustion. Do not retry terminal FK non-emptiness or discard historic participant/financial rows. Stop only task-owned resources; never reset the reviewer's database. Gate rollback remains default-off and full release rollback/O11 are NOT VERIFIED.

## Run the standalone consuming host

Existing `examples/identity-storage`, `examples/wallet-links` and `examples/command-receipts` copy canonical modules via symlinks; use `cp -RL`, declared package dependencies and an explicitly disposable local database. New identity-locks/error-contract dependencies are included in those copies. The copied consumers and independent injected SQL port run in the DB-backed boundary suite. `tests/identity-locks-db.test.ts` verifies already-locked participant/link composition on a real transaction with unchanged participant provenance. Standalone and prelocked examples prove interface/transaction consumption, not provider substitution or representative UAT.

Run `npm run identity:check` and the packet's affected tests with RUN_DB_TESTS=true against disposable PostgreSQL16. `npm run lint` includes the AST fence; `npm test` includes its positive and negative controls. Regenerate local route types with `next typegen` before typecheck if they are stale.

## Fence registry for non-identity domain advisory locks

The AST fence (`npm run identity:check`, implementation `scripts/identity-architecture.ts`, manifest `planning/identity-writer-fence.json`) rejects any `pg_advisory_xact_lock` outside `src/identity-locks`. Skill/practice storage modules take per-catalog and per-submission domain locks with `hashtextextended($1, <seed>)`. Those are not identity resources. The manifest `trustedAdvisoryFunctions` registry exempts a function only when its AST hash matches the reviewed one and every call uses a seed in the reserved domain range 12012–12099, so a domain lock can never alias the identity key space (seed-0 labels, fixed 729102–729104). One registered exception uses seed 0: `lockFundingReference` in `src/work-loop/amendment-storage.ts` takes exactly `hashtextextended('raid:funding-reference:'||$1,0)`, the same key as the database funding-serialization triggers (migration `202610270002`), so application and trigger writers serialize; the `raid:funding-reference:` prefix is not an identity class, and the fence accepts only that exact shape with a matching hash. Both shapes must be the entire SQL literal: a second lock in the same string, or the shape appearing only in a comment beside another lock, is rejected. Editing a registered function changes its hash and forces re-review; regenerate the entry only after reviewing the new body. These modules lock User rows (sorted, NO KEY UPDATE) before their own advisory locks and never acquire identity-class advisories, so they do not join the identity lock order. Cross-domain deadlock freedom between skill writers is not certified here. The fence helper lives under `scripts/` because production-visible code must not import the excluded `tests/` tree.

## Limitations

[Exact-source evidence and independent review instructions](../planning/task-evidence/T006-lock-slice-20261012/REVIEW-HANDOFF.md) govern this candidate. Full T006/T007 numbered criteria, hosted CI, representative UAT, capacity/history integration, all finance/campaign races, load/multi-instance behavior, mixed-version drain, recovery and release approval remain NOT VERIFIED. No WALLET_LINKS/ACCOUNT_FOLDS enablement, deployment or Git publication occurred.
