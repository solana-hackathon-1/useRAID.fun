# RAID synthetic fixtures and scenario evidence (T004 v1)

Purpose: reproducible local inputs for canonical §32.4 adverse cases, plus a validated evidence format and a complete [scenario plan](../planning/raid-scenarios.json). This M0 test-support module satisfies R16/AC74 for its own boundary and I13/AC75 for honest verification. It does not implement work, identity, grants, settlement, adapters or any acceptance scenario. The plan covers AC01–75; the historical T004-A02/backlog count of 72 is stale and retained as a recorded conflict.

Implementation source is [`tests/fixtures/raid/index.ts`](../tests/fixtures/raid/index.ts). Imports point at the canonical T002 contracts through `tests/fixtures/contracts`; the link is not a divergent specification or schema. Production `src`, seed and migration paths do not import this module. Docker excludes tests. All observations, IDs, names, wallets, amounts, provider scripts and history are synthetic. No live credentials, private customer material or real reputation/traffic/funding records are inputs or outputs.

## Interface and host dependencies

Dependency direction: consuming test host → fixture/evidence barrel → T002 contracts + Zod/bs58. The host supplies its own actual command implementation, authorized test environment, clock and evidence storage when it executes scenarios. T004 has no clock, repository, session, provider client, database singleton, network operation or hidden configuration.

| Public interface                          | Contract                                                                                                                                                                                                                                                          |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createSyntheticFixtures()`               | New deterministic deeply frozen v1 bundle on each invocation. Literal `simulation: true` and TEST ONLY label; inert data, no persistence or side effects.                                                                                                         |
| `SyntheticFixtures` / `FIXTURE_IDS`       | Typed return shape and allowed scenario fixture references. IDs use `test-only-`; assets use full T002 identity with synthetic network and deterministic non-secret 32-byte mint/program addresses.                                                               |
| `EvidenceRecordSchema` / `EvidenceRecord` | Strict v1 record: scenario AC01–75, candidate SHA, simulation, assurance, environment, tester/owner, expected/observed/result, timestamp and evidence reference. Rejects unknown fields, unsupported production kind, invalid SHA and unexecuted PASS/FAIL.       |
| `validateScenarioPlan(value)`             | Validates exactly 75 unique IDs, planned roles, fixture references, prerequisites, NOT VERIFIED status and each scenario's required assurance layers. Does not execute a scenario or certify canonical text; repository tests compare exact text and source hash. |
| `ENVIRONMENTS` / `REQUIRED_ENVIRONMENTS`  | Explicit minimum test layers; additional tests may be required by the actual selected contract/provider. No live operating gate is satisfied by this matrix.                                                                                                      |

`FIXTURE_STRUCTURE` means inspection of test inputs only; it can run in UNIT or INDEPENDENT_HOST. `SCENARIO_BEHAVIOR` is an executed synthetic path with every listed required environment. For combined cases, `environment.kind` plus optional `environment.coveredKinds` must include all required layers before an executed record passes validation. Every record includes `environment.network` and `environment.providerVersion`; use explicit `none` when absent. Validation checks the record's structure, not the truth of execution. Independent review must inspect actual evidence. No aggregate scenario PASS or UAT/release/business approval is generated. All scenario-plan results remain NOT VERIFIED.

PASS/FAIL requires a UTC execution timestamp and an evidence reference. NOT VERIFIED/BLOCKED/SKIPPED may have null timestamp/reference, with a clear observed explanation. Fields `expected`, `observed` and `evidenceRef` must contain sanitized summaries/references only. Do not store private payloads or credentials, or log rejected Zod input. The schema has no secret scanner; the consuming test owner/reviewer is responsible for sanitization. Zod throws validation errors; hosts should expose a fixed validation failure without the rejected input. A scenario failure with only some tested layers should be recorded as a blocked incomplete scenario with the lower-layer defect reference, until the full scenario has been exercised.

## Fixture relationships and state boundaries

Newcomer orientation has no verified skill. The assessed frontend specialist has A frontend evidence, no Solana skill and no Guild relationship/resource grant. The wealthy E claimed-skill account cannot buy assessed rank. Busy contributor has one canonical HUMAN participant, two linked synthetic wallets, one UNDER_REVIEW engagement and one matching commitment; finite accepted terms/roster/rewards/policies are frozen. These are states to load into a future authorized host, not evidence that linking, capacity or terms enforcement exists.

Two proposed Parties share the busy contributor. They are competing admission inputs, not simultaneous accepted assignments. Two registered agents share the individual operator whose human participant joins their separate proposed Party; that Party references one engagement, matching the default pilot's distinct-engagement accounting. Transactional participant/operator/Party reservation behavior still belongs to T019/T020 and requires real DB tests.

Guild facts cover new, reliable synthetic and unresolved-case histories. Public Guild DTOs exclude the private canary. Same-symbol assets use different mints; a different network changes their identity and a registry revision does not. The reward bundle has one VERIFIED synthetic funding leg and one REQUIRED leg with zero credited units. All amounts are nonnegative integer strings, including zero, consistent with §16.3. No receipt or ticker proves live funding, custody, decimals, solvency or a payment.

Access inputs preserve a pre-existing independent provider right and overlapping source/target grant reasons. Source desired REVOKED with observed ACTIVE models failed cleanup; the newer ACTIVE grant has a later generation. Expiry is not provider revocation. The valid nonwinner retains qualification and no automatic reliability fault. Duplicate deliveries and a rebuilt signature share one immutable semantic operation, asset, beneficiary and terms reference. Five provider scripts describe late binding, failed revocation, duplicate callback, interrupted payout and malicious instructions. Scripts are inert observations, not callable adapters or protected-resource effects. Actual compensation/reconciliation/authorization remains feature-owned.

Allowed actor/action/resource/state: local developer or test host reads/constructs frozen test data at any fixture state. No customer actor gains any read/write permission. There is no public endpoint, authentication service, grant provisioning, rank mutation, signing, funds transfer or new domain transition. Unauthenticated, wrong-Guild, holder-only, self-review, expired-grant and restricted actors are planned negative cases for the relevant actual domain tasks; fixture inspection does not prove their denial. Work/payment/access/run states remain separate.

## Independently runnable consuming host

[`examples/raid-fixtures/host.ts`](../examples/raid-fixtures/host.ts) imports only the public fixture and T002 contracts barrels and the declared scenario JSON. [`package.json`](../examples/raid-fixtures/package.json) pins Zod, bs58 and tsx; Node ≥22.12.0. Repository links point to canonical implementation/data. From the repo: `cd examples/raid-fixtures && npm start` uses installed root dependencies. A clean standalone host needs no RAID database/config/provider environment:

```sh
mkdir /tmp/raid-fixtures-host
cp -R tests/fixtures/raid /tmp/raid-fixtures-host/fixtures
cp -R src/contracts /tmp/raid-fixtures-host/contracts
cp planning/raid-scenarios.json /tmp/raid-fixtures-host/
cp examples/raid-fixtures/host.ts examples/raid-fixtures/package.json /tmp/raid-fixtures-host/
cd /tmp/raid-fixtures-host
npm install --ignore-scripts --no-audit --no-fund
npm start
```

Output: `simulation: true`, 75 planned and zero verified scenarios, distinct same-symbol keys, fixture-only assurance, and rejection of unexecuted PASS. The sample repeated-`a` SHA/time is expressly illustrative, never release evidence. CI copies the source and example outside the app and supplies the declared installed dependency runtime; local delivery also runs a independently installed host. No packages or customer data are published.

## Verification, compatibility and operations

Run `npx vitest run tests/raid-fixtures.test.ts tests/raid-evidence.test.ts tests/raid-fixtures-boundary.test.ts`; normal `npm test` discovers these through `tests/**/*.test.ts`. Tests check structural relations, exact canonical scenario text, invalid evidence, assurance layers and an external consuming host. Genuine RED, GREEN and regression commands/SHAs/results belong to the [task handoff](tasks/T004-handoff.md) and verification packet. Real-DB/browser regressions preserve legacy behavior; they do not execute the 75 new-domain scenarios. No meaningful database/program race, live provider, private download, restore or user UAT is claimed from inert fixtures.

Version v1 owns only the fixture bundle/evidence/plan schemas. Required-field or meaning changes require versioned consumer/test/doc updates; do not edit T002 schemas to fit fixtures. No migrations or backfill; no deployed obligation audit. There are no retries, cancellations, durable jobs, provider swaps, queues or health services inside T004. R15/AC73 actual adapter substitution remains feature-owned; replacing one observation data set does not prove a provider contract. Consumer migration/drain/rollback must preserve old semantic IDs/terms/assets/authority/receipts.

Rollback removes the local test-support files, example and plan; no customer state changes. Consumers must not seed production or expose fabricated history/funds. Any future DB seeder must use an isolated authorized test database and its own guard/cleanup contract. G01–G10 and OPEN O01–O19 remain dependent live gates, with named live owners/restore/custody still unverified. Maintainer: Codex AG03/AG10; planned scenario roles do not appoint live custodians. Independent reviewer and exact technical acceptance are recorded separately in the task packet. Next: T006 readiness and identity compatibility review; deployed snapshot/restore evidence remains required before persistence/migration execution.
