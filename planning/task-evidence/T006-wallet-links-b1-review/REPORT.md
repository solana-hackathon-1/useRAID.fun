# T006 B1 independent review (Claude, non-author)

Date: 2026-10-10. Verdict: **ACCEPTED WITH CONDITIONS**. Reviewed tree: uncommitted working tree on main 66d6a3a, copied to /tmp/raid-b1-claude-review-20261010/src (main checkout not modified; git status unchanged).

Independence note: the same-model session that took over on 2026-10-10 performed verification and minor edits (prettier, CI matrix). This review was run as a separate instance and re-derived all results below; author logs were not relied upon.

## Commands and results (all executed by me)

- tsc_noEmit: exit 0
- focused_7_suites: 124 passed / 0 failed / 0 skipped (wallet-link-credentials 28, wallet-auth-isolation-db 2, wallet-session-authority 11, wallet-auth-db 25, x-oauth-db 16, identity-link-boundary 5, identity-link-db 37)
- full_npm_test: 84 files, 1069 passed, 0 failed, 0 errors, 0 skipped (vitest run, RUN_DB_TESTS=true)
- prettier_check_owned: clean
- eslint_owned: clean (no output)
- git_diff_check: clean
- example_host: own npm install + generate + 4 migrations on own DB useraid_wallet_links_host_test: JSON line with all 14 flags true (incl. internalCredentialContext, revokedReserved)
- migrations_applied: 22 (_prisma_migrations count 22)

Commands: `npm ci --ignore-scripts`, `prisma generate`, `prisma migrate deploy` (22 migrations) on my own container; `npx tsc --noEmit`; `npx vitest run <7 focused files>`; `npx vitest run` (full); prettier --check and eslint on owned files; consumer: `cp -RL examples/wallet-links`, `npm install`, `npm run generate/migrate/start`. DB env: DATABASE_URL=<own container, db useraid_test> RUN_DB_TESTS=true NODE_ENV=test DEMO_MODE=false. NOT RUN: browser suites, Docker image build, production build, local CI aggregate, completion validator (out of scope of this review).

## Scope check

- schema_or_migration_edits: none (git diff HEAD --stat -- prisma empty)
- blueprint_edits: none; blueprint sha256 equals recorded 0a1a299e...
- routes_ui_flags: none added (no wallet_links_enabled / link-additional in src; src/app and src/components untouched)
- client_asserted_authority: none found; revoke/resolve take host-supplied observations (documented) and walletSessionAuthority requires authenticated===resolved===previous.userId, via==='x', unexpired

## TDD evidence honesty

- T007 red.xml (22 tests, 4 failures, assertion messages `expected 'x' to be 'wallet'` / foreign session null) and red-source snapshot (wallet-auth.ts = HEAD plus vocabulary + READ COMMITTED, with the old findUnique/deleteMany session logic) are consistent with a genuine RED; green.xml 22/0; refactor.xml 36/0. The three concurrent-session race tests were added after GREEN (no RED claimed); my mutations M12/M17/M33 show they are not vacuous (killed).
- T006 red.xml: 22/22 failures from executable stubs (NO_ERROR vs expected codes, `not-implemented`); precision-red and purpose-red are single real assertion failures; rotation-red `NO_ERROR` vs `P2002`. I independently reproduced the rotation RED by removing explicit READ COMMITTED (M05: 2 failures under repeatable read and serializable). M06/M07 likewise kill the verify/X-connection isolation removal.
- Hash binding is weak: see finding 4 (manifests predate the final tree).

## Findings (no blocking findings)

1. **medium** `src/identity-link/index.ts:105-112` - validPort's READ_COMMITTED check is not covered for the ABSENT path (mutation M26 survives).
   - Scenario: Remove the isolation clause: tests still pass because findHumanParticipant (identity-storage) re-checks isolation, but resolveWalletCredential on an ABSENT address never calls it, so a SERIALIZABLE/REPEATABLE READ port returns {source:'ABSENT'} from a snapshot observation; the module's documented per-statement-snapshot reliance is unprotected for exactly the case that lets a host provision a user.
   - Test-first fix: Add a fake-port test: resolveWalletCredential(ABSENT world, tx with isolation SERIALIZABLE) must fail STORAGE_CONTRACT (and same for revoke) before any SQL; RED by deleting the clause.
2. **medium** `docs/raid-wallet-links.md (lock-race paragraph); src/identity-link/index.ts:398-404` - Documented 'PRIMARY observation rechecks ownership after account lock and fails closed if a merge changed it' is untested (mutation M13 survives) and likely unreachable.
   - Scenario: Legacy absorbAccount re-points WalletIdentity.userId without the subject lock, but always deletes the dropped account; resolve's lock on the dropped (observed) account then returns ACCOUNT_NOT_FOUND or blocks the delete, so the second observation can never see a different owner via merge. The claim is untested, so a future change could remove it or rely on it silently.
   - Test-first fix: Write a real PostgreSQL race test (merge holding the userId update, resolver waiting) to either demonstrate the branch is reachable or reword the doc and delete the dead check. Also test the opposite order (resolver holds drop-account lock, merge delete blocks, and a session created by the host in that tx is cascaded away) to document the host consequence.
3. **medium** `src/lib/wallet-session-authority.ts; src/lib/wallet-auth.ts:140-157; docs/` - R16/same-change documentation gap: the new wallet-session-authority module and the changed verifyWalletChallenge session semantics are documented only in CURRENT.md.
   - Scenario: No docs/ page or example names walletSessionAuthority, its v1 trusted-host observation contract, the behavior changes (expired X session no longer renews X authority; a cookie session owned by another account is no longer deleted or borrowed; folding the current X account into the wallet owner yields a 'wallet' session), or the host obligation. A reusing host or B2 author cannot learn the contract; AC74 consuming example does not exercise it.
   - Test-first fix: Add a short section to docs/raid-wallet-links.md (or a session-authority doc) with purpose/non-goals, contract, behavior changes and tests; extend or reference a consuming fixture.
4. **low** `planning/task-evidence/T006-wallet-links-b1/source-manifest.json; T006-wallet-links-b1-resume/source-manifest.json; docs/ai-handoff/CURRENT.md` - Evidence manifests are stale relative to the final tree.
   - Scenario: sha256 in both manifests mismatch current src/lib/wallet-auth.ts (T007 change landed later), tests/wallet-link-credentials.test.ts, docs and planning/raid-ci-matrix.json; the resume verification (83 suites/1051) predates T007 (now 84/1069); CURRENT.md records test hash 4f2209f2 but the file is d09ce71f (post-prettier, acknowledged); docs/tasks/T006-wallet-links-b1.md still says 26 credential tests (now 28). A reader cannot bind the accepted results to one source.
   - Test-first fix: Regenerate a single final source manifest and verification record at the review-accepted tree; keep historical records annotated.
5. **low** `src/lib/wallet-auth.ts:35` - Object.hasOwn guard for unsupported purposes is not pinned for prototype keys (mutation M11 survives).
   - Scenario: Replacing it with `purpose in STATEMENTS` still passes tests; a purpose such as 'toString' would then embed function source in a persisted challenge. Current route only passes 'rotate'|undefined, so it is defense-in-depth only.
   - Test-first fix: Add a test that 'toString', 'constructor' and '__proto__' reject with 400 and persist nothing.
6. **low** `src/identity-link/index.ts:456-465` - Revoke UPDATE predicate accountId=$2 is redundant (mutation M01 survives, equivalent given prior locked ownership check).
   - Scenario: None observable; defense-in-depth is not exercised by any test.
   - Test-first fix: Either keep and document as defense-in-depth or add an adapter test whose fake returns a foreign-row UPDATE result to prove STORAGE_CONTRACT.
7. **low** `src/identity-link/index.ts:358-382,407-413` - resolveWalletCredential returns the caller-supplied networkIdentity for a legacy PRIMARY without verifying it.
   - Scenario: A PRIMARY (null network column) resolves for any network in walletNetworks, e.g. 'devnet', so the returned context claims a network never bound to that credential. Safe only because proof/network binding is T007.
   - Test-first fix: Document explicitly (done partly) and add a B2/T007 test that sign-in proof network equals the configured network before a session is created.
8. **low** `src/identity-link/index.ts:423-478` - Revoke trusts host-supplied session and clock objects and blocks a suspended account from revoking its own leaked additional wallet.
   - Scenario: The module cannot verify a DB Session row; a naive B2 route that builds the observation from request data would authorize revoke. ACCOUNT_RESTRICTED also prevents a restricted owner from revoking a compromised credential (tension with 28.4 safe-access intent).
   - Test-first fix: B2 must read the Session row in the same transaction, use a server clock, write audit and invalidate sessions; record a decision on restricted-account revoke.
9. **low** `next-env.d.ts` - Generated next-env.d.ts churn is part of the working-tree manifest.
   - Scenario: The path changes (.next/types -> .next/dev/types) from a dev server run; unrelated to B1 and would pollute a delivery.
   - Test-first fix: Exclude or restore before delivery (owner action).
10. **low** `tests/wallet-link-credentials.test.ts:340; tests/wallet-auth-isolation-db.test.ts; examples/wallet-links/README.md; docs/raid-wallet-links.md` - Cosmetic/hygiene.
   - Scenario: Test title mentions a malformed trusted session that the DB test does not exercise; README B1 paragraph sits above the title; doc output list reads '`alternatePort` `sanitizedFailure`' without separator; isolation tests ALTER DATABASE default_transaction_isolation and rely on finally{} restore plus vitest fileParallelism=false, so a killed process leaves the test DB at a non-default isolation.
   - Test-first fix: Rename/split test, fix wording, keep CI serial and document the ALTER DATABASE side effect.

## Adversarial review notes

- Lock order: resolve/revoke/link take subject advisory lock then User row FOR NO KEY UPDATE; rotateWallet takes balance advisory lock then the trigger's subject lock and only KEY SHARE on User (compatible with NO KEY UPDATE), so I found no new cycle; deadlocks would surface as 40P01 -> RETRY_TRANSACTION. Resolve vs revoke both orders and the account-lock order are proven with real pg_blocking_pids (killed by M08/M14). Resolve/revoke vs legacy merge is not tested (finding 2).
- Authority: walletSessionAuthority returns 'x' only if authenticated===resolved===previous.userId, via==='x', finite clock and strictly-future expiry; unknown via, foreign, missing context, equality and NaN default to 'wallet' (M03/M04/M16/M19 killed). The DELETE...RETURNING is scoped by userId, so a foreign cookie session is neither deleted nor borrowed (M12 killed); race tests for revoked/expired/downgraded concurrent sessions kill M17.
- No fail-open path found: malformed rows, wrong isolation (except the ABSENT gap), unsupported network, suspended, revoked, mapping mismatch all fail closed. Errors carry code only; missing and foreign revoke targets are both IDENTITY_CONFLICT (M22 killed); opaque storage errors do not leak the address/account (tested).
- Tests vs HEAD: `git diff HEAD -- tests` is additive only (new cases, two listed files, two new flags); no assertion weakened or removed.
- Behavior changes worth recording: wallet sign-in no longer deletes a session cookie owned by another account; expired X sessions no longer renew X authority; X-account folded into the wallet owner receives a 'wallet' session.

## Mutation table

| ID | File | Mutation | Result |
|---|---|---|---|
| M01 | src/identity-link/index.ts | revoke UPDATE drops accountId predicate | SURVIVED (tests 28, failures 0) |
| M02 | src/identity-link/index.ts | revoke session expiry <= flipped to < | KILLED (tests 28, failures 1) |
| M03 | src/lib/wallet-session-authority.ts | drop previous.via === 'x' | KILLED (tests 36, failures 2) |
| M04 | src/lib/wallet-session-authority.ts | authority expiry > flipped to >= | KILLED (tests 36, failures 1) |
| M05 | src/lib/wallet-auth.ts | rotateWallet loses explicit ReadCommitted | KILLED (tests 28, failures 2) |
| M06 | src/lib/wallet-auth.ts | verifyWalletChallenge loses explicit ReadCommitted | KILLED (tests 2, failures 2) |
| M07 | src/lib/x-oauth.ts | completeConnection loses explicit ReadCommitted | KILLED (tests 2, failures 2) |
| M08 | src/identity-link/index.ts | revoke skips account lock | KILLED (tests 28, failures 2) |
| M09 | src/identity-link/index.ts | allow PRIMARY revoke (drop PRIMARY_WALLET_PROTECTED) | KILLED (tests 28, failures 1) |
| M10 | src/identity-link/index.ts | drop session account equality | KILLED (tests 28, failures 1) |
| M11 | src/lib/wallet-auth.ts | createWalletChallenge Object.hasOwn -> 'in' (prototype keys) | SURVIVED (tests 53, failures 0) |
| M12 | src/lib/wallet-auth.ts | session DELETE drops userId filter | KILLED (tests 25, failures 1) |
| M13 | src/identity-link/index.ts | resolve drops post-lock owner re-observation check | SURVIVED (tests 65, failures 0) |
| M14 | src/identity-link/index.ts | resolve skips subject advisory lock | KILLED (tests 28, failures 1) |
| M15 | src/identity-link/index.ts | revoke accepts non-ACTIVE session state | KILLED (tests 28, failures 1) |
| M16 | src/lib/wallet-session-authority.ts | drop authenticatedAccountId===resolved | KILLED (tests 36, failures 2) |
| M17 | src/lib/wallet-auth.ts | replace atomic DELETE..RETURNING with read-then-deleteMany (old racy form) | KILLED (tests 25, failures 3) |
| M18 | src/identity-link/index.ts | lockedAccount ignores suspended | KILLED (tests 28, failures 1) |
| M19 | src/lib/wallet-session-authority.ts | drop previous.userId===resolved | KILLED (tests 36, failures 1) |
| M20 | src/identity-link/index.ts | ALREADY_REVOKED returns fresh timestamp instead of original | KILLED (tests 28, failures 1) |
| M21 | src/identity-link/index.ts | credentialMapping skips participant equality for LINK | KILLED (tests 28, failures 1) |
| M22 | src/identity-link/index.ts | revoke: foreign owner returns distinct code | KILLED (tests 28, failures 1) |
| M23 | src/identity-link/index.ts | credentialSubject drops walletNetworks membership check | KILLED (tests 28, failures 2) |
| M26 | src/identity-link/index.ts | validPort drops isolation check | SURVIVED (tests 28, failures 0) |
| M27 | src/lib/wallet-auth.ts | createWalletChallenge drops unsupported-purpose rejection | KILLED (tests 28, failures 1) |
| M28 | src/identity-link/index.ts | resolve drops IDENTITY_REVOKED | KILLED (tests 28, failures 3) |
| M29 | src/lib/wallet-challenge-contract.ts | SIWS_CHAIN_ID changed to devnet | KILLED (tests 77, failures 4) |
| M30 | src/lib/wallet-challenge-contract.ts | signin statement text changed | KILLED (tests 28, failures 1) |
| M31 | src/identity-link/index.ts | revoke ignores suspended owner (already M18-like but revoke path only): lockedAccount in revoke replaced by lock w/o suspended | KILLED (tests 28, failures 1) |
| M32 | src/identity-link/index.ts | revoke: requestId unvalidated | KILLED (tests 28, failures 1) |
| M33 | src/lib/wallet-auth.ts | expired previous X session still honoured (now frozen in the past) | KILLED (tests 25, failures 1) |

Killed 27/31; survivors M01, M11, M13, M26 (M01 equivalent). A first pass ran DB tests as skipped due to an env-parsing bug in my runner; M05-M08,M11-M13,M17 and M01 were rerun with RUN_DB_TESTS=true and only the rerun results are reported. M01 is an equivalent mutant. Each file was restored from the original bytes and its sha256 verified after every mutation; after the whole campaign the focused suites passed 124/124 again and all changed files are cmp-identical to the main checkout.

## Conditions for acceptance

1. Close findings 1-3 test-first (ABSENT-path isolation test; merge-race test or doc/dead-code correction; session-authority documentation).
2. Regenerate one final source manifest/verification record for the final tree (finding 4).
3. Keep B2 obligations visible: DB-read session, server clock, durable audit, session invalidation, flag default off, T007 network binding (findings 7-8).
4. Exclude next-env.d.ts from delivery.

## Resources created

- /tmp/raid-b1-claude-review-20261010/ (src copy, node_modules, logs, mut/, consumer/)
- docker container raid-b1-claude-review-db (postgres 16 pinned image ed134ce8..., tmpfs, 127.0.0.1:58334, password in /tmp/raid-b1-claude-review-20261010/.pw mode 600), databases useraid_test and useraid_wallet_links_host_test
- /tmp/wa.orig, /tmp/idx.orig, /tmp/dbg.test.ts, /tmp/dbg.out (scratch)
