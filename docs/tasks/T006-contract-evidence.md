# T006 preflight execution evidence and handoff

Status: bounded pure code VERIFIED_IN_TEST locally; independent review and exact-head CI pending. Full T006 remains IN_PROGRESS / NOT VERIFIED. Baseline `54c9c5555e56ffce3da7e350744e036c46707c08`; acceptance-first commit `0fb8041`. [Module contract and usage](../raid-identity-preflight.md) · [Acceptance packet](T006-contract-plan.md) · [Full-task non-completion record](../../planning/task-evidence/T006-contract-verification.json).

## Actual test-first evidence

Environment: macOS local, Node v26.0.0, Vitest 4.1.11, TypeScript 5.9.3, Zod 4.6.5, bs58 6.0.0, tsx 4.23.15. Inputs/host observations are synthetic and explicitly do not verify signatures or persist state. Logs are ephemeral under `/tmp/raid-t006-contract`; sanitized observations and fingerprints are recorded here/JSON, not represented as retained remote CI artifacts.

| Phase/source                                             | Command, observed result and boundary                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RED `1f92fd3513daa203f7f0af83e8c0d42f0a8bbcf8`           | `npm test -- tests/identity-preflight.test.ts`: 47 executed behavior tests fail against an explicit unimplemented preflight shell. Expected participant-preserving proposal and typed deny reasons are absent; this is assertion failure, not an import failure. Shell is replaced in GREEN.                                                                               |
| GREEN `d82ef93546a3e2d19ef6b4f0ee3b8204aade953d`         | Same command: all 47 pass. TypeScript passes. Pure schemas/preflight return the existing participant/engagement and reject unsafe contexts.                                                                                                                                                                                                                                |
| Host RED `d6d19af8ae6e5ca9392d9b3ed5e60278471ec126`      | `npm test -- tests/identity-preflight-boundary.test.ts`: one consumer test fails because the documented host has not yet been supplied (ENOENT). This is packaging/consuming-example failure, not additional identity behavior proof.                                                                                                                                      |
| Ownership RED `dd71d93250a77a6a7be9a91bea29eae40aa179e8` | Identity suite: 47 pass, one new exact-subject observation test fails; old schema returns INVALID_COMMAND instead of representing and checking the observation as OWNERSHIP_UNKNOWN. A snapshot of an unclaimed different subject cannot be used as current subject authority.                                                                                             |
| GREEN `659b8ff4843f02297e6b46ef49036787d5894a4d`         | `npm test -- tests/identity-preflight.test.ts tests/identity-preflight-boundary.test.ts`: 49 pass, zero skips. Ownership observations become required subject-bound shapes; existing fixtures receive the required binding with no denial/preservation assertion weakened. Standalone example is supplied.                                                                 |
| REFACTOR `eb9ffb5cbcf33575c67ed99008754dcdaebd00e3`      | Shared subject-match helper removes duplicated comparison; fixture null/string types replace `as never`; all 49 new tests pass unchanged. New files enter the CI inventory without changing discovery/workflow or domain status. Selected existing regression command yields 209 pass across 13 suites, with one suite/34 existing database finance tests skipped locally. |

Regression command: `npm test -- tests/identity-preflight.test.ts tests/identity-preflight-boundary.test.ts tests/auth.test.ts tests/auth-routes.test.ts tests/wallet-routes.test.ts tests/x-oauth.test.ts tests/x-oauth-routes.test.ts tests/rewards-finance.test.ts tests/shared-contracts.test.ts tests/shared-contracts-boundary.test.ts tests/raid-fixtures.test.ts tests/raid-fixtures-boundary.test.ts tests/raid-evidence.test.ts tests/docs-links.test.ts`. This mixed local run does not supply the skipped real database evidence. No fresh database/schema/migration command was executed in this slice.

Separate JUnit new-test run (`--reporter=default --reporter=junit --outputFile=/tmp/raid-t006-contract/preflight.xml`): 49 testcases, zero failures/errors, no skipped testcase. SHA-256 `90d86c8b91fbda94b26b719c65cd91754d287b8e27fe74e0dc05ecf99e14c6e6`. The test-case absence of skips was checked separately from an optional aggregate XML attribute.

Other executed checks: 27 planning/validator regressions pass after inventory update; TypeScript passes; lint exits zero with 24 existing warnings and no new-module warning. Initial planning run correctly failed on two omitted new inventory entries; those were added under E01/E02 while existing full-domain gaps stayed visible. Initial standalone typecheck failed because its copied dependency path was absent in the repo example; links to canonical source fixed that packaging issue. An initial package-version probe hit bs58's intentionally unexported package.json subpath; direct package-file metadata resolved it. None is counted as an identity behavior PASS.

## Independently installed host, not independent approval

Copied only `src/identity`, `src/contracts`, host.ts and the declared package.json to `/tmp/raid-t006-contract/independent-host`, outside the app. Installed pinned dependencies with `--ignore-scripts --no-audit --no-fund`, an isolated cache and empty distinct user/global npm config files, then ran the host with only PATH in the environment. Seven dependency packages installed; no repo node_modules link or RAID app configuration was supplied to this separate installation.

The first install command used `/dev/null` for both npm config roles and was rejected before resolving configuration. Distinct empty files fixed that setup; the actual install/run then passed. After refactor the two source directories were recopied and the installed host rerun successfully. Output:

```json
{
  "version": "v1",
  "simulation": true,
  "executionEnabled": false,
  "sameParticipant": true,
  "capacityRetained": true,
  "subjectSupplierReplacementStable": true,
  "collisionBlocked": true,
  "replayBlocked": true,
  "removalBlocked": true,
  "unknownInventoryBlocked": true,
  "revokedLinkBlocked": true
}
```

These booleans follow executed assertions. Supplier replacement is deterministic fixture observation replacement only, not commercial provider substitution, signed-login replay prevention or database uniqueness. The CI consumer test copies sources outside the app but supplies the declared existing test runtime by an explicit node_modules link; it is separate from this fresh package installation. Neither run constitutes independent code review or business/UAT approval.

## Scope, retained gaps and next step

New code lives in `src/identity/{index,contracts,preflight}.ts`; behavior/consumption tests, explicit synthetic host, module docs, task packet/evidence and CI inventory accompany it. Existing auth/wallet/provider services/routes, shared contracts, applied migrations/schema, account/claim/payment records and workflows are unchanged. No module is wired into the app and no new stored account-linked right exists. Removal preflight always blocks; it is not a production blanket prohibition or a reviewed recovery policy. OPEN O11 and financial/operating authority choices stay unresolved.

All 27 full T006 criteria stay NOT VERIFIED in the attached record. Local unit decisions do not prove AC01 at actual storage, I01 constraints/races, full R15 auth adapter substitution, full R16 auth host, AC68/G10, public UI or live migration readiness. Independent reviewer is not supplied for this new code; original readiness/rehearsal review applies only to its original source. Completion validator results and final documentation checks are recorded in the JSON follow-up, preserving rejection of incomplete scope.

Next: review this proposed public preflight/observation boundary, then select the actual isolated persistence target and named authorized owner. Establish the T003 target-specific entry evidence before dependent execution. Deliver restrictive participant/rights references and shared merge/deletion guards before the first new linked row; write real PostgreSQL RED for busy second-wallet linking, simultaneous subject collision, two-active merge rejection and merge/delete versus newly created rights. Preserve original history, accepted terms, exact amounts, beneficiaries and semantic receipts. Incorporate actual signature/session/nonce adapters and a complete auth consuming host with independent review. The local helper remains disabled from application use until those boundaries are implemented.

Rollback removes unused module/example/tests/docs and inventory entries; no state rollback is required. No merge, deployment, issue closure, UAT or release approval is requested or claimed.
