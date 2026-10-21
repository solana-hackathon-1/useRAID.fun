# Independent Codex review handoff — local main reconciliation

Author: Codex. Status: **SELF-EVALUATED; independent acceptance NOT VERIFIED**. No reviewer launched/messaged. Owner restricted the task to backup, nine-file reconciliation and verification. Do not commit/push/merge/deploy, update the board, continue T006, expand the architecture, implement the parked protocol or enable unfinished identity functionality. The current user instruction supersedes broad staging authority in imported history.

Read [REPORT.md](REPORT.md) for the nine-file matrix, both sides retained, test results and exact unresolved blockers. Read CURRENT/MEMORY and current instructions, then blueprint00–04/13, affected identity/security/concurrency contracts,33.12/34/35/39/40. Verify actual state rather than assuming older evidence applies.

## Exact source and recovery

- Original branch/main HEAD: `2992a78cc77112569740abf0522d399994c77910`; actual index empty; HEAD unchanged.67 incoming commits are represented as working-tree source, not a Git merge.
- Pinned incoming main: `a2085ff90f08bfe25cc4438ee2a86e625285a9df`. Newer remote changes after this pin are not reviewed by this packet.
- Canonical blueprint SHA256: `e9b82f347d826720ebd278692ad2c2790b13e5733350596ec609e26a459a9e0c`; both current planning fingerprints match.
- Recoverable complete checkout: `/Users/dushyant/Documents/useRAID-reconciliation-backup-20261014T013027Z/working-tree`, with metadata/diffs/manifests beside it. Local configuration stays in that private local backup, excluded from review patches.
- Tested isolated source: `/Users/dushyant/Documents/useRAID-reconciliation-backup-20261014T013027Z/verification-source`; manifest `/Users/dushyant/Documents/useRAID-reconciliation-backup-20261014T013027Z/verification-source-manifest.json`. Application/test bytes match the live reconciled tree; final CURRENT/report/packet additions are documentation-only and recorded separately. Dependencies were reused from this host and Prisma generated for the combined schema. Runtime versions in `runtime-versions.json` (Node26, hosted CI22 difference).
- [Nine-file/current-reference diff](nine-file-reconciliation.patch) distinguishes authored reconciliation from preserved local implementation.
- [Complete parked-work diff against pinned main](combined-vs-origin-main.patch), [stat](combined-vs-origin-main.stat), [paths](combined-vs-origin-main.paths), [metadata](review-patch-metadata.json). It includes pre-existing local identity implementation/evidence; those are not new task implementation. Excludes unrelated WARP/nested worktrees/private env/caches and the separate packet itself.
- `git apply --check` against the pinned archived main source passed. An external review index was used; actual index and branch unchanged.

## Review in order

1. Verify preservation-final/source/recovery identities, complete backup and zero unrelated source mismatch. Check final patch digest; distinguish original dirty work, imported main, nine reconciliation edits and two current-reference document edits. Check both histories and all owner decision bodies, unique sections/IDs05/06 plus aliases, and final fingerprints.
2. Inspect origin-binding helper and its consumption predicate before mutation. Confirm exact signed host including port and URI scheme/origin are checked; valid path-only configuration changes stay compatible. Preserve signature,digest,purpose,expiry,single-use,current-session/suspension,network and sanitized error protections. Against original dirty auth, only the upstream import and origin predicate were added.
3. Inspect the two test combinations: stronger blocker+statement predicate and all existing root/concurrency/rollback/credential/monetary assertions retained. Verify original diagnostics, corrected fixture network and reuse boundaries, not just deduplicated totals.
4. Independently validate that neither strict-true identity switch, HTTP route/UI wiring nor deployment/local configuration was enabled. Default-off test and source checks pass; test-only synthetic opt-ins are separate from application enablement.
5. Reproduce meaningful focused/DB checks on a **new independently owned PG16 fixture** with27 migrations and a synthetic useraid_test URL. Do not reuse/truncate author/Claude/preview databases. Do not use real credentials or providers. Mainnet is the default fixture expected by existing linked-wallet tests; network-specific tests explicitly exercise both supported networks. Tests may opt in synthetic folds/linking; that does not enable the application.
6. Independently disposition unresolved blockers without silently converting writers, adding protocol classes, updating allowlists or weakening assertions: new User-FK inventory and skills advisory calls; missing raider-preferences example dependency/full TypeScript; missing3 test-inventory entries; retained historic-log whitespace. Passing selected schedules cannot prove complete compatibility of new upstream consumers. Any repair beyond this reconciliation needs a separate bounded authorization.
7. Record review verdict, exact source/environment/UTC/tests, skipped checks and criterion limitations. **No independent review, representative UAT, full T006/T007 acceptance or production gate is supplied by author verification.** Stop and return findings; wait for explicit publishing authority after independent acceptance.

## Reproduction and existing results

The executed runner is `/Users/dushyant/Documents/useRAID-reconciliation-backup-20261014T013027Z/verify.py`; first devnet runner and failed logs preserved as `verify-first.py`/focused-tests.log/XML. The runner records synthetic environment/selection in this packet; its original author DB is stopped, so do not run against the old URL without provisioning a new owned fixture. Copy the command/selection with your own URL/port and capture fresh results.

```sh
RUN_DB_TESTS=true DEMO_MODE=false WALLET_LINKS_ENABLED=false ACCOUNT_FOLDS_ENABLED=false \
USDC_NETWORK=mainnet DATABASE_URL="$REVIEW_DB_URL" npm test -- \
  tests/auth*.test.ts tests/wallet*.test.ts tests/identity*.test.ts tests/x-oauth*.test.ts \
  tests/lock-observation.test.ts
npm run lint
node node_modules/next/dist/bin/next typegen
npm run typecheck
python3 -m unittest discover -s tests -p 'test_raid_*.py'
```

Use an isolated source/cache for typegen so existing previews/generated work remain intact. Exact executed commands and47-test corrective rerun are in command JSONs. Current evidence:442 unique focused tests,441 PASS/1 architecture FAIL/0 skipped;4/4 origin DB and10/10 concurrency schedules pass;47/47 corrected-network tests;27 migration/bootstrap and schema drift pass;ESLint0 errors/27 warnings but lint fence fails;full TypeScript4 errors, application/test subset passes;planning51/52;scope formatting/diff-check pass;full patch applies to pinned main. Broad whitespace warnings only affect original raw evidence. Aggregate is **not green**.

## Resource boundary

Author-owned `raid-reconciliation-20261014`/9e7c1ad48025,loopback62468 was stopped and is exited. Tmpfs data is gone; do not infer restart restores fixtures. No volumes/images removed. All12 original running containers and existing owner preview PID78070/127.0.0.1:3087 are preserved. No preview/browser/UAT claim from this reconciliation. Review owns/cleans only its new fixture. Backup and evidence stay available.
