# T006/T007 first lock-protocol implementation — Claude handoff

**SELF-EVALUATED. Independent implementation acceptance pending. Stop after this bounded slice.** Author Codex; independent reviewer Claude. Owner explicitly authorized protocol implementation on reviewed baseline `2992a78cc77112569740abf0522d399994c77910`, with A1–A3. No application/schema/migration/configuration publication, branch change, commit, merge, push or gate enablement. No wallet-linking feature expansion. Existing dirty work and Claude's evidence/database are preserved.

## New GitHub reconciliation gate

The owner's subsequent read-only GitHub check found main at `148b95fe29dbc0069d1bd9393341fe99f59007f2`: **54 commits ahead**, no divergent local commits, **1,112 changed files**. Local HEAD and cached origin/main remain2992a78. Objects were read with `--no-write-fetch-head --no-tags --refmap=`; checkout, index and branch refs were preserved. The compare API's file listing was incomplete at its300-file limit; [full comparison](github-comparison.json) and [complete path list](github-full-files.txt) use actual Git trees.

Nine paths overlap tracked local changes: blueprint, CURRENT, wallet docs/example README, scenario/task registries, wallet-auth, identity-storage DB tests and wallet-credential tests. In particular:

- Upstream adds `walletChallengeMatchesOrigin` to legacy proof consumption. **This security fix is absent from the baseline-based candidate and must survive reconciliation.** Do not publish this candidate as a replacement for current main.
- Upstream adds three migrations and User FKs for RaiderPreferences, RaiderPreferenceVersion and GuildDraft. The candidate's schema-derived fence/inventory and22-migration test environment do not certify those new schemas.
- New onboarding/Guild consumers take raw User NO KEY UPDATE and Session SHARE locks; onboarding calls `ensureHumanParticipant`. They need explicit shared/prelocked contract composition and integration regressions before claiming a complete writer conversion on current main. See [consumer scan](github-new-lock-consumers.json) and [source diff](github-source.patch).
- Upstream changes AGENTS/CLAUDE/blueprint and CI/resource instructions. Reconcile those instructions with the owner's current preview-retention direction on an explicitly authorized integration step.

Do not rebase/merge/reset this checkout as part of review. The owner has authorized comparison, not integration. Claude may review this pinned baseline candidate now; integration/CI acceptance must use a separately reconciled exact source with all upstream fixes/invariants retained.

## Scope and decisions

Authority: approved [revised Claude report](../T006-identity-design-20261012-claude-review/REVISED-REPORT.md), [R1–R8 matrix](../T006-identity-design-20261012/R1-R8-decisions.md), [reconciled design](../T006-identity-design-20261012/design-reconciliation.md), [acceptance-before-code task](../../../docs/tasks/T006-lock-slice-20261012.md). R04/R13/R15/R16, D01/D13, I05/I06/I07/I10/I11/I13, AC01/02 partial, AC40/73–75; M1, AG03 author→AG08 reviewer. Full numbered T006/T007 criteria remain NOT VERIFIED; [coverage ledger](criterion-coverage.md) is not independent acceptance.

| Amendment | Decision and implementation | Evidence |
| --- | --- | --- |
| A1 | **ACCEPT.** Closed registry includes tracking/post/x-endpoint, fixed global keys, finance/reward/balance/wallet-subject/x-auth. Existing labels/seed0/bigint precision preserved. Blocking acquisition order is enforced by transaction-local phases; post IDs use code-unit sorting. Existing source-tracking rehome is an explicitly nonblocking try-lock exception. | Registry/helper, all inventoried acquisition paths, trigger equality DB test, AST fence; [inventory](lock-inventory.md). |
| A2 | **ACCEPT.** Real `allocateUsdcRaid` takes the complete sorted account set before allocation, transfer and credit bulk inserts, including non-credit recipients. Creator uses SHARE for its existing suspension predicate; recipient references use KEY SHARE. Creator restriction is re-read before settlement inserts. Merge emptiness is checked before strong roots, then guarded under roots. | X2 both orders use actual finance code; exact10M payout/settled reserve assertions; separate creator-status RED→GREEN; precheck denial before held strong root. |
| A3 | **ACCEPT.** Only merge User-delete23503/P2003 (or raw P2010.meta.code23503) becomes terminal account-not-empty Http409. No query after aborted delete, no retry or500. Other errors propagate. | Real PostgreSQL FK denial, rollback/no audit, default-three-attempt host proves one attempt, unrelated delete error object preserved. |

The creator SHARE/recheck enforces the existing eligibility predicate: suspension committed before root acquisition defers settlement; finance acquiring SHARE first settles unchanged and suspension waits. No payout arithmetic, amounts, allocation ordering, recipients or transfer outcomes for a stable eligible fixture were edited. Independently verify this linearization against the intended finance contract.

## Final protocol and boundaries

`src/identity-locks` has a PostgreSQL READ COMMITTED injected SQL port, closed classes/modes, ordered roots/children and opaque transaction-bound capabilities. The Prisma host has one cached port per transaction and a checked mutation facade. User ID changes/nested writes, insufficient modes, unplanned subjects/keys, stale/foreign capabilities and late roots/upgrades are rejected.

SHARE serializes read-only sign-in/session issuance against suspension; NO KEY UPDATE handles non-key updates/aggregates; UPDATE is preplanned for key changes/deletion. Same-X refresh omits xId assignment. Both fold candidates are preplanned strong when both directions are permitted. Wallet-address locks cover old/new/moved addresses before roots. Children order: OAuthAttempt→XAccount→Session→WalletIdentity→Participant→WalletLink, then code-unit PK order. Session replacement/attempt consumption children use their final UPDATE mode upfront. Fresh ownership, status, claimed attempt/session authority and proof expiry are checked after waits using a separate DB-clock statement.

Writers converted together: wallet sign-in/link/rotation and the existing gated additional-link composer; X start/completion/disconnect; absorb; suspension target; sandbox User/X/primary/session creation; public Participant/WalletLink modules. Exact-PK logout/attempt claim/discard remain explicitly bounded autocommit leaves. Cleanup batches select materialized ordered PKs with LIMIT100/FOR UPDATE SKIP LOCKED, maximum10 batches and between-batch1s budget; worker `<` and X-start `<=` boundaries remain.

Standalone calls own fresh transactions. Prelocked module calls supply the same live port's opaque `locks`, validate root/subject/child coverage and acquire nothing further. Reduced minimal-host layouts are explicitly injected trusted schema metadata; RAID uses the complete layout. Copied host dependencies and consuming examples are updated. [Module contract](../../../docs/raid-identity-locks.md) contains dependencies, versioning, host authority, retry and recovery limits.

Retries: default3 fresh transactions/15s budget, bounded jitter and remaining-budget maxWait/timeout. Only replan and typed40P01/40001/P2034 conflicts retry. Proof/expiry/restriction/FK/unique denials do not. Tokens/new account/request IDs are stable across attempts; X provider exchange is outside completion retries. Unknown commit outcomes are not blindly retried. Durable receipt/reconciliation composition remains unverified.

AST fence runs in both tests and lint. It follows Prisma types/import symbols through direct/aliased/destructured writers, rejects nested/raw/type-erased bypasses, detects raw advisory acquisition, freezes the User-FK/unique-key inventory and fingerprints exact trusted leaf/SQL/multi-user functions. It is an architectural guard, not protection against malicious reflection, external DB writers or unreviewed migrations. Claude must inspect the allowlist fingerprints and their actual guards; updating a manifest alone is not review.

## Test-first and verification record

Disposable author storage: PostgreSQL16.15, container `raid-lock-slice-20261012`, loopback64231, tmpfs. Main test DB `useraid_test`; separate preview DB `useraid_studio_test`. Original22 migrations applied. Claude64121 and prior author64083 were not stopped/modified.

| Phase/check | Actual result/artifact |
| --- | --- |
| Initial baseline harness attempts | Preserved separately in red-harness-first/red-before-tightening logs/XML; void-return SQL and incomplete waiter/victim assertions corrected before counting genuine RED. |
| Baseline application RED | **7 executed/7 failed**, unchanged application at2992a78: X1 both orders, actual finance X2 both orders, restriction/sign-in race, early nonempty denial, real23503. [red.log](red.log), [XML](red.xml). |
| Baseline AST RED | Legacy writers rejected, [architecture-red.log](architecture-red.log). |
| Initial protocol GREEN | 7/7, [green-first.log](green-first.log). |
| Additional proof-lifetime RED | Expired challenge still issued a session while root-waiting, [expiry-red.log](expiry-red.log); post-wait clock check fixed, [expiry-green.log](expiry-green.log). |
| Additional finance-status RED | 2/2 meaningful failures before creator-strength/recheck changes, [finance-status-red-confirmed.log](finance-status-red-confirmed.log). |
| Deliberate fence mutation | Unconverted source writer rejected, exit1 [fence-deliberate-red.log](fence-deliberate-red.log); owned probe removed, restored exit0 [fence-restored-green.log](fence-restored-green.log); six bypass styles checked. |
| Final affected DB/unit/consumer suites | **48 suites/677 tests PASS**, [candidate-final.log](candidate-final.log), [XML](candidate-final.xml); no skipped cases in this run. Tests include X1/X2 with transaction retries disabled, both queue orders, retained callback/merge cases, real finance values, trigger keys, capability contracts, bounded rollback/retry, cleanup catalog/batches and copied consumers. |
| Typecheck | `next typegen` then `tsc --noEmit`: exit0, [typegen.log](typegen.log), [typecheck-candidate.log](typecheck-candidate.log). Initial typecheck failed on a stale ignored validator referencing removed creator route; regenerated from local candidate. Incoming next-env bytes restored. Ignored prior types backed up in /tmp. |
| Lint/fence | `npm run lint`: exit0, zero errors/363 warnings, [lint-candidate.log](lint-candidate.log). Existing warnings/worktree copies retained; three introduced unused symbols removed. |
| Diff/preservation | Index empty; owned changes unstaged; schema/migrations/deployed config unchanged. Incoming docs/planning and original Claude evidence preserved; [source identity](source-identity.json), [files changed](FILES-CHANGED.md). |

Failures remain in db-first/db-second/unit-first/second/affected-first/second and other intermediate logs. Some expectations assumed old blocking locations; changed barriers observe the new actual waits while preserving authority, exact monetary and rollback assertions. Repeated standalone fake-port calls now represent separate transactions or explicit capabilities. The authority-hook contract now permits planning/pre-lock reads before the hook and domain reads after it.

`candidate-interrupted.log/XML` records a2739.67s run with39 failures (timeouts/expired fixtures plus one fixture-count error). This was not reported green or discarded. Timing interruption/expiry was observed; its exact OS cause is not proven. A temporary task-owned sleep inhibitor was used for the fresh47.20s passing run and ended with it. A test incorrectly counted the pre-existing funding deposit, then used a nonexistent raidId field on transfers; preserved diagnostics precede correction to settlement transfer kinds. Assertions still require no settlement and exact retained balances/payouts.

Production build, hosted CI, live X/provider/Phantom, mobile UAT, load/fairness and multi-instance/mixed-version tests were not run. No claim that all possible PostgreSQL interleavings are proven. Completion validators deliberately fail while full criteria/CI/independent evidence are NOT VERIFIED; see completion logs/JSON.

## Preview and resource ownership

Reachable [development preview](http://localhost:3087/studio-test), refreshed current candidate at /creator, synthetic Creator sign-in via POST/api/studio/sandbox200 and Creator Studio200. Browser shows local fixture/no-real-funds banner and1000 test USDC. [Screenshot](preview.png), [server log](preview-server.log). This is NODE_ENV=development, STUDIO_SANDBOX=true, distinct studio DB, .next-studio output, both identity gates false. It is not production-build evidence, real X login, Phantom consent or UAT.

Retain preview for owner inspection per local workflow memory. Owned listening server PID78070, exec session47341; stop only it with `kill 78070` after confirming ownership/port3087. Its DB is in the owned container, so retain that dependency with the preview. When preview is no longer needed, `docker rm -f raid-lock-slice-20261012` removes only this disposable tmpfs resource. Evidence files remain. Never stop the Claude review container or unrelated services. No active sleep inhibitor remains.

## Claude's independent review, in order

1. Read CURRENT/MEMORY, local instructions, approved reports and this packet. Check main/HEAD/index/dirty work, every source hash and preserved original evidence. Review author-owned files only with incoming work distinguished. Do not infer new-source CI/acceptance from older artifacts.
2. Disposition A1–A3 and challenge final mode/effect planning, capability/standalone composition, complete old/new wallet keys, both fold directions, child order and the nonblocking rehome exception. Verify the descriptor/layout host assumptions and rare key-alias boundary.
3. Use a **new owned disposable PostgreSQL16 database**, all migrations for the source under review. Do not reset/truncate the author preview or Claude's existing database without coordination. Independently run X1/X2 both orders with retries disabled, collect full SQLSTATE/backend traces and preserve final ownership/session/nonce/audit/monetary assertions. Verify real `allocateUsdcRaid`, not synthetic SQL alone; challenge both creator-status cases and10M amounts.
4. Verify A3 real User-delete FK denial is terminal409, one host attempt/no audit/complete rollback; unrelated database error object remains unchanged. Challenge finance-created references between optimistic emptiness and strong roots.
5. Run mutation controls: direct/alias/destructured/nested/raw/type-erased writer, a new User FK/key, wrong/foreign/stale/underpowered capability, User-lock upgrade, missing moved wallet subject, reversed/missing finance root, lower blocking class, removed SKIP LOCKED/limit and callback retry masking. Inspect exact trusted-function manifest bodies. Restore only owned probes.
6. Run affected suites with `RUN_DB_TESTS=true DATABASE_URL="$REVIEW_DB_URL"` and the test selection below; lint/fence; route typegen/typecheck; copied standalone and prelocked consumers. Preserve command output, clocks, versions, dependency/source identity and all failures. Avoid arbitrary repetition of already exact-source passing evidence.
7. Independently classify the54 upstream commits/new migrations/consumers and origin binding. The existing local FK fence must fail on newly added User references until a reviewed conversion/classification exists. No direct overlay or weakened assertion/allowlist to make latest main green. Owner authorization and a separately tested reconciliation are required before integration.
8. Record independent findings/evidence/status in a new review artifact, update CURRENT preserving this packet, and hand back. No deployment/push/merge/gate enablement is implied by acceptance.

```sh
RUN_DB_TESTS=true DATABASE_URL="$REVIEW_DB_URL" npm test -- \
  tests/identity*.test.ts tests/wallet*.test.ts tests/x-oauth*.test.ts \
  tests/studio*.test.ts tests/worker-db.test.ts tests/tracking*.test.ts \
  tests/rewards*.test.ts tests/command-receipts*.test.ts tests/usdc*.test.ts
npm run identity:check
npm run lint
node node_modules/next/dist/bin/next typegen
npm run typecheck
```

The author selection also included campaign/queue/pump/provider patterns when present; zsh NULL_GLOB avoids passing absent patterns. Exact selection/results are in candidate-final artifacts. Sleep/time stability matters for short-lived fixtures; do not weaken expiry assertions.

## Outstanding gates and risks

Full finance/campaign creation/removal vs actual merge in both directions, rights/history JSON references, fairness/starvation, large session aggregates/backlogs, unknown commit reconciliation, external/legacy writers and mixed versions remain NOT VERIFIED. X2's competing transaction takes real strong roots; it is not a complete live merge/account-empty finance matrix. Operator request-authorization interleavings beyond target suspension and arbitrary reflection outside the typed boundary are not certified.

Before additional linking: verify wallet attribution on every writer/instance; environment-specific zero-link history or forced reauthentication/complete seven-day last-legacy-issuance drain, all TTL/renewal paths and no laundering. Implement selective same-link session invalidation with audit/composite ownership binding in a separate reviewed slice. No attribution schema/backfill was added here.

SIWS Resources must bind canonical destination account and validated X-handle snapshot to exact stored bytes and current own X authority, with target-less pending challenges denied. No such consent implementation was added here. **Real Phantom rendering of both Resources and the earlier staging invalid-format/devnet-network fix remain NOT VERIFIED.** Grammar and local synthetic sign-in do not close those gates. Full T006/T007 review, capacity/history integration, O11/recovery, representative UAT, business approval and G01–G10 remain open.
