# T005 — Independent dependency security and compatibility review

Reviewer: `/root/t001_independent_review (distinct Codex AG08 technical security/compatibility reviewer)`. Source reviewed: `36d99cfdd7755ac9c75d1007ff0b6c586c55ce00`, baseline `21f901b6815207c55fa461d7173177ede2788a2f`. Final documentation/evidence reviewed: `6d118c7d79104671e0ef266a26ddf9e52f22aa66`; source/test/lock/gate/allowlist are unchanged from the source candidate. This separate technical agent reviews only the bounded prerequisite repair; no full task, deployment, UAT, treasury or business approval is supplied.

**Bounded verdict: ACCEPT** for the compatible partial dependency repair and accurate final documentation. This verdict does not certify a clean audit or accept any complete task criterion. The dependency replacements pass their scoped local behavior checks; the initially missing test inventory has been corrected without weakening checks. **Whole T005 and T001 completion remain BLOCKED** on the remaining braces advisory and missing full-scope/final-candidate evidence.

## Material findings

1. **Resolved: CI inventory omission (C22/C16).** At source 36d99cf, the new suite ran under Vitest discovery but was missing from the matrix and epic ownership union: independent planning 26 pass/1 fail. At documentation 6d118c7, both matrix entries and CI guide explicitly register E11/T005 ownership. Independent recheck: 27 pass with unchanged assertion/discovery/gates.
2. **Audit failure remains (C14/C22/A01).** Independent `npm run audit:check` fails solely on high `braces` GHSA-vfj7-8cjw-p6xm. Installed path is Next ESLint config/plugin → fast-glob → micromatch → braces 3.0.3. The official advisory lists no patch and the registry reports latest 3.0.3. Its development-tool path does not approve a gate waiver. [Official braces advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).
3. **Resolved: initial typecheck provenance (C16).** `/private/tmp/raid-t005-typecheck.log` contains the pre-guard TS18048 failure. A fresh independent typecheck at 36d99cf passes. Final owner verification explicitly identifies that raw log as failure-only and records later guarded PASS separately.

## Inspected dependency and behavior changes

Lock inspection and `npm ls` independently confirm source-map-js 1.2.2, Sharp 0.35.5, bundled libvips package 1.3.4 and scoped Web3.js Jayson 5.0.0 override. stream-json 1.9.1/stream-chain are removed. Web3.js remains 1.99.0 and Next remains 16.3.6. No application commands, policies, schema, migrations, audit allowlist/evaluator or CI gate were changed.

Malformed indexed section offsets are rejected while ordinary mapping still resolves. The native SVG test checks librsvg patch version and a valid red-pixel rasterization: reviewer macOS arm64 installation is Sharp 0.35.5/libvips 8.18.7/librsvg 2.63.2. The exact 6d118c7 Linux CI run also passes all 11 dependency cases, including native version/rasterization; Docker build/runtime smoke passes. These checks verify installed libraries and ordinary behavior, not an RCE exploit or blanket deployed/global-library assurance. The official patch sources support these versions. [Source-map-js advisory](https://github.com/advisories/GHSA-68fv-2mgg-jv7q), [Sharp advisory](https://github.com/advisories/GHSA-wq5f-xc86-pv6w).

The chunked parser test preserves own prototype-key data and exact string amounts without creating inherited permissions. Web3.js actually imports `jayson/lib/client/browser`, whose HTTP parser uses ordinary JSON.parse; it does not call parseStream. The test is a library-parser safety regression, not proof that the former Solana HTTP path was exploitable. The removed JSONC advisory likewise does not imply the consumed ordinary HTTP parser was vulnerable. [Stream-json JSONC advisory](https://github.com/advisories/GHSA-hqr4-qq8f-hg3x), [assembler advisory](https://github.com/advisories/GHSA-mjw6-4jj6-33hc).

## Major compatibility and host boundary

- Actual source Connection consumers are server-side HTTP RPC; no direct production Jayson TCP/TLS consumer was found. Positive/error Connection fixtures retain endpoint, finalized params, JSON-RPC correlation and one successful dispatch. One dispatch is fixture-specific: the unchanged Web3.js 429 retry loop can issue repeated transport requests.
- Jayson 5 requires Node≥20; repository Node≥22.12 and CI/Docker Node 22 satisfy it. Browser ID generation needs native crypto.randomUUID/getRandomValues or a host generator. Missing crypto fails explicitly. Reviewer-only checks verify that rejection and custom/caller IDs.
- TCP/TLS now require a configured delimiter, newline by default. Concatenated JSON without delimiters is incompatible; unterminated frames fail. The parser buffers/re-scans until delimiter without a new input-size cap, so untrusted TCP/TLS exposure requires host limits. This is not a general drop-in compatibility claim. [Official Jayson 5 contract](https://raw.githubusercontent.com/tedeh/jayson/v5.0.0/README.md).
- RPC IDs are transport correlation, not financial semantic IDs. Existing FinancialTx/claim/ledger keys, signatures, asset/network/provider authority and accepted history remain authoritative. No live provider switch, payout replay, pending-operation drain or restore proof was performed.

R15/R16 gaps in legacy global domain/provider coupling remain. This patch does not create a reusable domain module, independent consuming RAID host or stable provider-port system. No new provider choice, commercial hosting decision, business policy or live gate is approved.

## Genuine TDD and actual verification

Plan commit e035410 precedes RED 44561a7. RED adds tests before dependency edits: **11 tests, seven intended failures and four baseline passes** (five invalid offsets, native decoder version, prototype inheritance). GREEN f75fcec preserves assertions and adds an explicit missing-decoder error for typing; REFACTOR 36d99cf extracts only response-fixture duplication. Both targeted reports contain **14 passes**: 11 dependency cases plus three audit-evaluator cases. Raw result digests are in the JSON report; RED was inspected historically, not rerun against altered dependencies.

- Own `npx vitest run tests/dependency-security.test.ts tests/audit-check.test.ts`: 14 passed.
- Own fresh `npm run typecheck`: passed.
- Own documentation/environment tests: 52 passed; both review artifacts formatted and nested relative link resolves.
- Own `npm run audit:check`: failed on braces only.
- Own Python planning-contract suite: initial 26 passed/1 failed on CI inventory omission; final documentation 6d118c7 rerun 27 passed.
- Reviewer-only seven deterministic no-network checks: missing crypto, custom/caller IDs, malformed HTTP response, HTTP batch correlation/single dispatch, missing delimiter rejection and two framed values all pass. They are supplemental review probes, not implementation TDD or live evidence.
- Provided regression JSON independently parsed: 293 passed/241 skipped/0 failed, 534 total. Owner attributes this execution to GREEN f75fcec; reviewer checked raw counts/digest rather than independently recreating that historical run. Those local database skips remain unverified.
- `npm ls`, registry read, lock/version comparison, `git show`/test diff, unchanged-scope diff and whitespace check inspected. No installs, application edits or provider/network effects were performed by reviewer.

## Completed exact-candidate CI amendment

Independently queried [push run 37598806670](https://github.com/solana-hackathon-1/useRAID.fun/actions/runs/37598806670), fetched its logs and downloaded its test artifact. Head and all six checkout logs are exactly `6d118c7d79104671e0ef266a26ddf9e52f22aa66`. Planning-contracts, static, test, docker and browser jobs **SUCCESS**; dependency-security and ci-gate **FAILURE**, solely the unallowlisted braces advisory. The aggregate gate correctly rejects that failure.

JUnit artifact 11471179360 contains 54 suites and 534 passed, zero failed/errors/skipped; the dependency suite's 11 tests pass on Linux. Independently downloaded XML SHA256 is `320bd9d79a5a4aeb4cf63de04cb4b55482154b5ef2a9e98a50ad731b95ad7f8d`; remote archive digest is recorded separately in JSON. These isolated real-database tests address the prior local DB skips for this executed suite, not every canonical domain criterion or live provider gate.

Browser logs: demo 49 passed/1 skipped, Studio 44 passed/0 skipped, live fixture suite 38 passed/6 skipped: **131 passed, seven skipped**. Successful browser status does not validate skipped paths or certify real external-provider/chain, UAT or release gates. No result from this run applies to subsequent evidence/review metadata commits. The bounded verdict remains ACCEPT and whole-task verdict remains BLOCKED.

## Core criterion observations and remaining scope

| Criterion       | Scoped observation; no whole-task acceptance                                                                                                                                                                                            |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C01             | Bounded prerequisite security repair plan is distinct from wider T005 hosting/history/options assignment; full scope incomplete.                                                                                                        |
| C02             | No mainnet/gate/authority policy change; remaining security blocker retained, O18 unresolved.                                                                                                                                           |
| C08/C10/C12     | No monetary/schema/permission command edits; RPC transport IDs are not semantic payout/claim IDs. Exact CI existing isolated real-DB suite passes; full domain/program/provider/recovery proof is not supplied.                         |
| C14             | Patch behavior/consumed-API tests pass locally; security audit still fails, so entire criterion not accepted.                                                                                                                           |
| C16             | Historical raw results checked with digests; local skips remain visible. Final documentation 6d118c7 reviewed; exact CI 534 pass/0 skip and browser 131 pass/7 skip verified; later metadata checks not inferred.                       |
| C19             | Genuine local failing-first evidence supports this changed dependency slice; this is implementation work, not a non-code exception.                                                                                                     |
| C20             | Consumed SDK replacement tested at deterministic HTTP boundary with explicit major limits; not full stable domain-port/provider substitution or live gate compliance.                                                                   |
| C21             | No reusable new module extracted. Same-change dependency/host/limitations and deterministic runnable consumer documentation reviewed; no independent RAID host/feature compliance claimed.                                              |
| C22             | Planning omission resolved with E11/T005 registration and 27 pass; remaining audit blocks completion; new test is discovered by existing Vitest wildcard. Exact 6d118c7 security and aggregate fail; browser 7 skips remain unverified. |
| A01             | Four original nonallowlisted issues reduced through patches/removal; precise braces upstream blocker remains. Wider Actions/Cloudflare root-cause evidence belongs to owner full packet.                                                |
| A02/W01/W02/W03 | Whole T005 hosting path/history/environment/O18 acceptance is not assessed or approved by this scoped security review.                                                                                                                  |

Owner packet at reviewed documentation 6d118c7 correctly contained 26 NOT VERIFIED and 1 FAIL (C22), with no whole-task criterion reviewers and CI pending at authoring time. The subsequent exact-SHA CI is recorded above; this historical packet snapshot and validator rejection are not claims that jobs remain unrun. Independent completion-validator execution at that snapshot rejected missing reviewer, pending CI and those criteria. This bounded review does not promote any of the 27 dispositions. Historical startup wording is qualified as CLI inference, Pages logs/settings remain unverified and O18 remains OPEN. T005 also owns Actions startup/Cloudflare failures, hosting topology/environment/O18 options and chosen-path checks. This dependency slice cannot close that assignment or satisfy T001 C22 while audit fails. T001 PR #172 stays docs-only; no graph/Done/Ready change is authorized by this review.

Next: preserve the braces blocker and all whole-task pending/failing dispositions, retain browser skips and exact-SHA CI provenance, and complete Actions/Pages/hosting/O18 and sequencing work before whole-task acceptance. No earlier local or remote check is promoted to the final documentation candidate.

Machine-readable scoped report: [T005-security-review.json](../../planning/task-evidence/T005-security-review.json).
