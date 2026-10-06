# RAID detailed task contracts and completion review

[Canonical blueprint](../RAID_AGENT_BLUEPRINT.md) · [Project](https://github.com/orgs/solana-hackathon-1/projects/1) · [System/subsection ownership](raid-blueprint-project-map.md) · [UAT scripts](raid-uat-plan.md)

These task packets turn canonical requirements into review obligations; they do not replace or amend the blueprint. Each of the 165 issues includes its own requirement statements, numbered implementation/test criteria, relevant system subsections, dependencies and evidence checklist. The JSON register records the blueprint SHA-256 so reviewers can detect outdated packets. Reconcile changed source requirements before implementation.

## Review rules

Every criterion starts **NOT VERIFIED**. The implementation owner fills the evidence matrix; the reviewer checks the result against the canonical source and actual code/migrations. A claim of completion without these records is rejected at review. A developer cannot approve their own UAT, business decision or financial authority merely by editing a field.

Documentation and GitHub fields do not technically prevent a privileged user from closing an issue. These rules define valid completion; repository permissions, protected branches and required checks determine technical enforcement. No stronger protection is claimed by this documentation change.

| Evidence result | Meaning                                                        | Completion effect                                                                    |
| --------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| NOT VERIFIED    | No applicable executed result yet                              | Prevents Done                                                                        |
| PASS            | Observed result matches criterion at the named SHA/environment | Eligible for review; does not grant production authority                             |
| FAIL            | Observed behavior violates the criterion                       | Prevents Done; link defect and retest                                                |
| BLOCKED         | Dependency, policy, environment or provider capability missing | Prevents Done for dependent scope                                                    |
| NOT APPLICABLE  | Reviewer accepts a specific boundary-based rationale           | Only excludes that criterion for this bounded task; never waives a product invariant |

## Required criterion evidence

For every task-specific criterion record: criterion ID; canonical reference; current repository fact; entity/API/event touched; allowed and rejected actors; before/after state; test preconditions/action/expected result; actual observed result; evidence link; candidate SHA; environment and version; reviewer; disposition. Missing details are NOT VERIFIED. Keep private data and secrets out of reports.

## Common implementation contracts

### C01 — scope

State the observable user outcome, assigned milestone, in-scope commands and explicit adjacent work excluded. Compare the actual baseline to the desired behavior; identify existing working behavior that must survive.

### C02 — authority

List every applicable LOCKED, DIRECTION, DEFAULT, OPEN and EXAMPLE reference separately. Keep unresolved dependent production actions disabled. A recorded owner decision must identify who accepted it, date, changed contract and effect on old accepted work.

### C03 — entities

List affected canonical entities, concrete tables/models, identifiers, foreign keys, tenant scope, uniqueness and immutable fields. Identify the shared contract owner and reuse existing contracts. Do not assert the intended blueprint tables already exist.

### C04 — permissions

Provide an actor × action × resource × state matrix for every changed read/write. Cover unauthenticated, wrong Guild, token-holder-only, self-review, expired/revoked grant and restricted account cases. Deny at the server/resource boundary; include direct API/download tests.

### C05 — transitions

Provide before-state, command, authorized actor, terms/submission version, precondition, atomic mutation, after-state and rejected alternatives. Keep listing, offer, work, access, funding, settlement, dispute and run states separate. Specify finite deadlines and material cancellation/timeout paths.

### C06 — identity-capacity

Use canonical participant identity across linked wallets and Guilds. Identify whether this action consumes capacity under section 13. Prove database uniqueness, all-or-none Party reservations, same-engagement operator accounting, current eligibility rechecks, lock order and engagement-scoped release where touched.

### C07 — terms-consent

Identify exact immutable terms, roster, payout split, beneficiary, rubric and submission version. Test stale version and unauthorized amendment. Material accepted-work changes require affected consent, valid additional funding and audit; defaults cannot rewrite old agreements.

### C08 — money

Declare whether financial obligations are touched. If so specify network/kind/mint/program/decimals, integer base units, verified funds, reserves, allocations, fees, claims, refunds and conservation per asset. Verify actual effects/finality and beneficiary authority; transaction submission and ticker text prove nothing.

### C09 — privacy-access

Enumerate public and private DTOs, HTML hydration, metadata, search, previews, artifacts, logs and notification fields. Test absence of private bytes and effective scoped provider access. Distinguish desired from observed grants; preserve independent rights and surface failed revocation.

### C10 — idempotency

Specify command identity, request digest, immutable receipt, semantic external operation and outbox/inbox deduplication. Same key plus different payload must conflict. Retry or rebuilt transaction cannot repeat business effects. Preserve intent across process crashes.

### C11 — concurrency

Name every competing command and linearization boundary. Exercise meaningful independent transactions/provider boundaries for applicable acceptance, refund, claim/appeal, Party, Challenge handoff, delayed cleanup and stale job races. Record winning state and losing response; in-memory mocks do not prove database/program races.

### C12 — external-recovery

List every provider/program effect, authority, generation, timeout, partial success, stale success and compensation path. Do not hold database locks during provider/LLM/wallet/finality waits. Reconcile before retrying an unknown outcome; stale success cannot reopen work or grant access.

### C13 — experience

Cover loading, empty, unknown/stale, validation failure, conflict, permission denied, rejected signature, pending/failed/partial effect, cancellation and recovery states where applicable. Verify keyboard/focus, mobile, draft preservation, exact amounts and intelligible eligibility reasons.

### C14 — security

Identify applicable input validation, session/nonce/CSRF/origin, rate limit, upload quarantine, SSRF/redirect, secrets, malicious build and prompt-injection boundaries. Untrusted code and model output cannot inherit credentials, grant permissions, self-approve or expand spending.

### C15 — operations

Record feature flags at server and UI, monitoring, named case owner, incident/runbook and feature-specific G01–G10 evidence. Disabling new work must preserve old claims, cancellation, dispute and access cleanup. Define migration/backfill, verified backup/restore and rollback constraints.

### C16 — verification

For each requirement and criterion provide setup/fixtures, exact action, expected result, observed result, command/test, SHA, environment/network/provider version and sanitized evidence. Record failed, blocked or not-run checks accurately; compiler success is insufficient.

### C17 — uat

For affected user-facing release scope identify representative journey, tester, candidate environment/SHA, expected results, defect disposition/retest and separate business sign-off. QA, UAT and release approval cannot be inferred from each other.

### C18 — handoff

Record actual files, schema/API/event changes, tests executed/results, unresolved risks, authority/privacy/money effects, migration/rollback limits, reviewer and exact next bounded task. Unimplemented criteria cannot disappear through issue closure or epic roll-up.

## State changes on the board

Ready requires verified hard predecessors, bounded scope, a named implementation owner, accepted shared contracts and usable test fixtures/environment. In Progress requires the issue packet to be populated with repository facts. In Review requires a linked implementation PR, completed criterion evidence and accurate remaining gaps. Done requires reviewed applicable criteria, exact acceptance results, required UAT/sign-off, migration/recovery evidence and a handoff. An epic cannot be Done while its included children or required release evidence remain incomplete.

A decision issue needs a section 40.4 owner decision record; a gate issue needs feature-specific operational evidence and authorized release review. A release-gate approval applies only to its actual feature, asset, network, provider/program version and environment. A passed test-network task is not a production approval.

Splitting scope requires recording the original criterion, moved child issue, dependency and remaining parent gap. Removing a requirement, relabeling a test optional, weakening an assertion, increasing a budget or changing a DEFAULT silently cannot count as completion. The active owner may change requirements through the canonical change-management process; previous accepted customer terms remain protected.

## System-by-system review scope

Each numbered subsection is a review unit. Open its canonical link and demonstrate every material rule, table constraint, transition, adverse case and authority boundary relevant to the task. The issue owns its assigned slice; the domain epic remains responsible for unimplemented system criteria. Requirements are not satisfied by merely reading their source.

### System 00 — Agent entry point

Canonical contract: [section 00](../RAID_AGENT_BLUEPRINT.md#00-agent-entry-point). Accountable work: [T001](https://github.com/solana-hackathon-1/useRAID.fun/issues/43), [T002](https://github.com/solana-hackathon-1/useRAID.fun/issues/44), [T096](https://github.com/solana-hackathon-1/useRAID.fun/issues/166).

- **00.1 — What this file is for**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#001-what-this-file-is-for); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T001, T002, T096.
- **00.2 — First actions for every development agent**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#002-first-actions-for-every-development-agent); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T001, T002, T096.
- **00.3 — If your context window is small**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#003-if-your-context-window-is-small); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T001, T002, T096.
- **00.4 — How to make decisions**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#004-how-to-make-decisions); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T001, T002, T096.
- **00.5 — Ten implementation rules to remember**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#005-ten-implementation-rules-to-remember); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T001, T002, T096.

### System 01 — Evidence and authority

Canonical contract: [section 01](../RAID_AGENT_BLUEPRINT.md#01-evidence-and-authority). Accountable work: [T001](https://github.com/solana-hackathon-1/useRAID.fun/issues/43), [T096](https://github.com/solana-hackathon-1/useRAID.fun/issues/166).

- **01.1 — What was actually available**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#011-what-was-actually-available); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T001, T096.
- **01.2 — Product evidence register**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#012-product-evidence-register); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T001, T096.
- **01.3 — Corrections to earlier suggestions**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#013-corrections-to-earlier-suggestions); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T001, T096.

### System 02 — Decision register

Canonical contract: [section 02](../RAID_AGENT_BLUEPRINT.md#02-decision-register). Accountable work: [E23](https://github.com/solana-hackathon-1/useRAID.fun/issues/158), [T096](https://github.com/solana-hackathon-1/useRAID.fun/issues/166).

- **02.1 — Locked product requirements**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#021-locked-product-requirements); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: E23, T096.
- **02.2 — Carried-forward product direction**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#022-carried-forward-product-direction); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: E23, T096.
- **02.3 — Defaults adopted for the initial engineering specification**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#023-defaults-adopted-for-the-initial-engineering-specification); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: E23, T096.
- **02.4 — Non-negotiable engineering invariants**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#024-non-negotiable-engineering-invariants); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: E23, T096.

### System 03 — Vocabulary

Canonical contract: [section 03](../RAID_AGENT_BLUEPRINT.md#03-vocabulary). Accountable work: [T002](https://github.com/solana-hackathon-1/useRAID.fun/issues/44).

### System 04 — Product map

Canonical contract: [section 04](../RAID_AGENT_BLUEPRINT.md#04-product-map). Accountable work: [T044](https://github.com/solana-hackathon-1/useRAID.fun/issues/86), [T049](https://github.com/solana-hackathon-1/useRAID.fun/issues/91), [T087](https://github.com/solana-hackathon-1/useRAID.fun/issues/129).

- **04.1 — Core promise**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#041-core-promise); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T044, T049, T087.
- **04.2 — End-to-end loop**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#042-end-to-end-loop); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T044, T049, T087.
- **04.3 — Separate dimensions in the model**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#043-separate-dimensions-in-the-model); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T044, T049, T087.
- **04.4 — What the first useful product must prove**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#044-what-the-first-useful-product-must-prove); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T044, T049, T087.

### System 05 — Launchpad

Canonical contract: [section 05](../RAID_AGENT_BLUEPRINT.md#05-launchpad). Accountable work: [T010](https://github.com/solana-hackathon-1/useRAID.fun/issues/52), [T026](https://github.com/solana-hackathon-1/useRAID.fun/issues/68), [T027](https://github.com/solana-hackathon-1/useRAID.fun/issues/69), [T028](https://github.com/solana-hackathon-1/useRAID.fun/issues/70), [G01](https://github.com/solana-hackathon-1/useRAID.fun/issues/131), [O01](https://github.com/solana-hackathon-1/useRAID.fun/issues/24), [O02](https://github.com/solana-hackathon-1/useRAID.fun/issues/25).

- **05.1 — Scope**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#051-scope); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T010, T026, T027, T028, G01, O01, O02.
- **05.2 — Founder launch flow**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#052-founder-launch-flow); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T010, T026, T027, T028, G01, O01, O02.
- **05.3 — Launch state model**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#053-launch-state-model); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T010, T026, T027, T028, G01, O01, O02.
- **05.4 — Launch adapter contract**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#054-launch-adapter-contract); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T010, T026, T027, T028, G01, O01, O02.
- **05.5 — Existing project onboarding**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#055-existing-project-onboarding); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T010, T009.
- **05.6 — Mainnet release gate**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#056-mainnet-release-gate); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: G01, G05.

### System 06 — Guilds and membership

Canonical contract: [section 06](../RAID_AGENT_BLUEPRINT.md#06-guilds-and-membership). Accountable work: [T009](https://github.com/solana-hackathon-1/useRAID.fun/issues/51), [T010](https://github.com/solana-hackathon-1/useRAID.fun/issues/52), [T011](https://github.com/solana-hackathon-1/useRAID.fun/issues/53).

- **06.1 — Guild profile**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#061-guild-profile); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T009, T010, T011.
- **06.2 — Founder authority**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#062-founder-authority); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T009, T010, T011.
- **06.3 — Holder membership**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#063-holder-membership); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T011.
- **06.4 — Membership is separate from work permissions**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#064-membership-is-separate-from-work-permissions); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T009, T010, T011.

### System 07 — Identity and onboarding

Canonical contract: [section 07](../RAID_AGENT_BLUEPRINT.md#07-identity-and-onboarding). Accountable work: [T006](https://github.com/solana-hackathon-1/useRAID.fun/issues/48), [T007](https://github.com/solana-hackathon-1/useRAID.fun/issues/49), [T008](https://github.com/solana-hackathon-1/useRAID.fun/issues/50), [T014](https://github.com/solana-hackathon-1/useRAID.fun/issues/56), [T061](https://github.com/solana-hackathon-1/useRAID.fun/issues/103), [T090](https://github.com/solana-hackathon-1/useRAID.fun/issues/160).

- **07.1 — Account model**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#071-account-model); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T006, T007, T008, T014, T061, T090.
- **07.2 — Wallet authentication**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#072-wallet-authentication); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T007.
- **07.3 — New human onboarding**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#073-new-human-onboarding); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T006, T007, T008, T014, T061, T090.
- **07.4 — Evidence types**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#074-evidence-types); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T090, T013.
- **07.5 — Anti-spam and duplicate accounts**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#075-anti-spam-and-duplicate-accounts); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T014, T090.

### System 08 — Skills and ranks

Canonical contract: [section 08](../RAID_AGENT_BLUEPRINT.md#08-skills-and-ranks). Accountable work: [T012](https://github.com/solana-hackathon-1/useRAID.fun/issues/54), [T013](https://github.com/solana-hackathon-1/useRAID.fun/issues/55), [T014](https://github.com/solana-hackathon-1/useRAID.fun/issues/56), [T061](https://github.com/solana-hackathon-1/useRAID.fun/issues/103), [T072](https://github.com/solana-hackathon-1/useRAID.fun/issues/114).

- **08.1 — Rank ladder**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#081-rank-ladder); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T012, T013, T014, T061, T072.
- **08.2 — Canonical skill record**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#082-canonical-skill-record); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T012, T013, T014, T061, T072.
- **08.3 — Trial design**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#083-trial-design); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T013.
- **08.4 — Example skill trials**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#084-example-skill-trials); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T012, T013, T014, T061, T072.
- **08.5 — Admission by skill**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#085-admission-by-skill); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T012, T013, T014, T061, T072.
- **08.6 — Progression and reassessment**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#086-progression-and-reassessment); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T012, T013, T014, T061, T072.

### System 09 — Reputation and Guild Trust

Canonical contract: [section 09](../RAID_AGENT_BLUEPRINT.md#09-reputation-and-guild-trust). Accountable work: [T041](https://github.com/solana-hackathon-1/useRAID.fun/issues/83), [T072](https://github.com/solana-hackathon-1/useRAID.fun/issues/114), [T088](https://github.com/solana-hackathon-1/useRAID.fun/issues/130).

- **09.1 — Three records, three questions**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#091-three-records-three-questions); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T041, T072, T088.
- **09.2 — Display facts before a precise score**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#092-display-facts-before-a-precise-score); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T041, T072, T088.
- **09.3 — Metric definitions**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#093-metric-definitions); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T041, T072, T088.
- **09.4 — Reputation events**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#094-reputation-events); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T041, T072, T088.
- **09.5 — Guild reputation**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#095-guild-reputation); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T041, T072, T088.
- **09.6 — Guild Trust**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#096-guild-trust); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T041, T072, T088.
- **09.7 — Gaming, fairness, and appeals**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#097-gaming-fairness-and-appeals); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T072, T088.

### System 10 — Visibility and code access

Canonical contract: [section 10](../RAID_AGENT_BLUEPRINT.md#10-visibility-and-code-access). Accountable work: [T053](https://github.com/solana-hackathon-1/useRAID.fun/issues/95), [T054](https://github.com/solana-hackathon-1/useRAID.fun/issues/96), [T055](https://github.com/solana-hackathon-1/useRAID.fun/issues/97), [T091](https://github.com/solana-hackathon-1/useRAID.fun/issues/161), [G06](https://github.com/solana-hackathon-1/useRAID.fun/issues/136).

- **10.1 — Four visibility choices**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#101-four-visibility-choices); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T053, T054, T055, T091, G06.
- **10.2 — Confidential admission**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#102-confidential-admission); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T053, T054, T055, T091, G06.
- **10.3 — Access grant record**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#103-access-grant-record); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T053, T054, T055, T091, G06.
- **10.4 — GitHub boundaries**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#104-github-boundaries); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T054, G06.
- **10.5 — Revocation is a workflow**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#105-revocation-is-a-workflow); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T055, T081.
- **10.6 — Safe code execution and CI**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#106-safe-code-execution-and-ci); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T055, T091, T063.

### System 11 — Creating and recommending a Raid

Canonical contract: [section 11](../RAID_AGENT_BLUEPRINT.md#11-creating-and-recommending-a-raid). Accountable work: [T016](https://github.com/solana-hackathon-1/useRAID.fun/issues/58), [T017](https://github.com/solana-hackathon-1/useRAID.fun/issues/59), [T018](https://github.com/solana-hackathon-1/useRAID.fun/issues/60), [T025](https://github.com/solana-hackathon-1/useRAID.fun/issues/67).

- **11.1 — Founder creation flow**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#111-founder-creation-flow); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T016, T017, T018, T025.
- **11.2 — Required publication fields**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#112-required-publication-fields); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T016, T017, T018, T025.
- **11.3 — Recommendation engine**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#113-recommendation-engine); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T017.
- **11.4 — Recommendation behavior**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#114-recommendation-behavior); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T016, T017, T018, T025.
- **11.5 — Terms changes**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#115-terms-changes); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T025.

### System 12 — Normal Raid lifecycle

Canonical contract: [section 12](../RAID_AGENT_BLUEPRINT.md#12-normal-raid-lifecycle). Accountable work: [T020](https://github.com/solana-hackathon-1/useRAID.fun/issues/62), [T021](https://github.com/solana-hackathon-1/useRAID.fun/issues/63), [T023](https://github.com/solana-hackathon-1/useRAID.fun/issues/65), [T024](https://github.com/solana-hackathon-1/useRAID.fun/issues/66), [T025](https://github.com/solana-hackathon-1/useRAID.fun/issues/67).

- **12.1 — Work state machine**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#121-work-state-machine); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T020, T021, T023, T024, T025.
- **12.2 — Canonical states and effects**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#122-canonical-states-and-effects); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T020, T021, T023, T024, T025.
- **12.3 — Acceptance command**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#123-acceptance-command); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T020, T021, T023, T024, T025.
- **12.4 — Submission**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#124-submission); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T020, T021, T023, T024, T025.
- **12.5 — Withdrawal, timeout, and closure**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#125-withdrawal-timeout-and-closure); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T020, T021, T023, T024, T025.

### System 13 — One active Raid

Canonical contract: [section 13](../RAID_AGENT_BLUEPRINT.md#13-one-active-raid). Accountable work: [T020](https://github.com/solana-hackathon-1/useRAID.fun/issues/62), [T024](https://github.com/solana-hackathon-1/useRAID.fun/issues/66), [T032](https://github.com/solana-hackathon-1/useRAID.fun/issues/74), [T057](https://github.com/solana-hackathon-1/useRAID.fun/issues/99), [T059](https://github.com/solana-hackathon-1/useRAID.fun/issues/101), [T062](https://github.com/solana-hackathon-1/useRAID.fun/issues/104).

- **13.1 — Exact product rule**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#131-exact-product-rule); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T020, T024, T032, T057, T059, T062.
- **13.2 — Database enforcement**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#132-database-enforcement); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T020, T079.
- **13.3 — Atomic acceptance algorithm**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#133-atomic-acceptance-algorithm); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T020, T021.
- **13.4 — Required race behavior**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#134-required-race-behavior); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T079, T082, T084.
- **13.5 — Closure and stale workers**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#135-closure-and-stale-workers); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T024, T038.
- **13.6 — AI and operator limits**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#136-ai-and-operator-limits); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T062, T084, O15.

### System 14 — Parties

Canonical contract: [section 14](../RAID_AGENT_BLUEPRINT.md#14-parties). Accountable work: [T056](https://github.com/solana-hackathon-1/useRAID.fun/issues/98), [T057](https://github.com/solana-hackathon-1/useRAID.fun/issues/99), [T082](https://github.com/solana-hackathon-1/useRAID.fun/issues/124).

- **14.1 — Why Parties exist**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#141-why-parties-exist); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T056, T057, T082.
- **14.2 — Party record**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#142-party-record); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T056, T057, T082.
- **14.3 — Acceptance and reward allocation**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#143-acceptance-and-reward-allocation); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T056, T057, T033.
- **14.4 — Skill coverage and evaluation**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#144-skill-coverage-and-evaluation); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T056, T057, T082.
- **14.5 — Member changes and conflicts**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#145-member-changes-and-conflicts); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T056, T057, T082.

### System 15 — Guild Challenges

Canonical contract: [section 15](../RAID_AGENT_BLUEPRINT.md#15-guild-challenges). Accountable work: [T058](https://github.com/solana-hackathon-1/useRAID.fun/issues/100), [T059](https://github.com/solana-hackathon-1/useRAID.fun/issues/101), [T067](https://github.com/solana-hackathon-1/useRAID.fun/issues/109), [T082](https://github.com/solana-hackathon-1/useRAID.fun/issues/124), [O10](https://github.com/solana-hackathon-1/useRAID.fun/issues/33).

- **15.1 — Two explicit formats**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#151-two-explicit-formats); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T058, T059, T067, T082, O10.
- **15.2 — Selection Challenge flow**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#152-selection-challenge-flow); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T058, T059, T067, T082, O10.
- **15.3 — Selection-to-main Raid handoff**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#153-selection-to-main-raid-handoff); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T059, T082.
- **15.4 — Prize Competition**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#154-prize-competition); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T067, O10.
- **15.5 — Judging**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#155-judging); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T058, T059, T067, T082, O10.
- **15.6 — Confidential competitions and rights**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#156-confidential-competitions-and-rights); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T054, T058, T067.
- **15.7 — Capacity and reputation**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#157-capacity-and-reputation); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T058, T059, T067, T082, O10.

### System 16 — Rewards and escrow

Canonical contract: [section 16](../RAID_AGENT_BLUEPRINT.md#16-rewards-and-escrow). Accountable work: [T029](https://github.com/solana-hackathon-1/useRAID.fun/issues/71), [T030](https://github.com/solana-hackathon-1/useRAID.fun/issues/72), [T031](https://github.com/solana-hackathon-1/useRAID.fun/issues/73), [T032](https://github.com/solana-hackathon-1/useRAID.fun/issues/74), [T033](https://github.com/solana-hackathon-1/useRAID.fun/issues/75), [T034](https://github.com/solana-hackathon-1/useRAID.fun/issues/76), [T036](https://github.com/solana-hackathon-1/useRAID.fun/issues/78), [T080](https://github.com/solana-hackathon-1/useRAID.fun/issues/122), [T093](https://github.com/solana-hackathon-1/useRAID.fun/issues/163).

- **16.1 — Five independent budgets**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#161-five-independent-budgets); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T093, T094.
- **16.2 — Exact asset identity**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#162-exact-asset-identity); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T029.
- **16.3 — Amount representation**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#163-amount-representation); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T029, T080.
- **16.4 — Reward bundles and net amounts**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#164-reward-bundles-and-net-amounts); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T029, T030, T031, T032, T033, T034, T036, T080, T093.
- **16.5 — Supported asset policy**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#165-supported-asset-policy); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T029, T069, O07, G04.
- **16.6 — Custody and authority decision**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#166-custody-and-authority-decision); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T030, O05, G02.
- **16.7 — Agreement and program sketch**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#167-agreement-and-program-sketch); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T029, T030, T031, T032, T033, T034, T036, T080, T093.
- **16.8 — Acceptance/refund race**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#168-acceptancerefund-race); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T032, T080.
- **16.9 — Separate state dimensions**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#169-separate-state-dimensions); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T029, T030, T031, T032, T033, T034, T036, T080, T093.
- **16.10 — Conservation rules**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#1610-conservation-rules); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T031, T033, T080, T093.
- **16.11 — Funding verification**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#1611-funding-verification); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T031.
- **16.12 — Retries and partial settlement**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#1612-retries-and-partial-settlement); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T033, T038, T080.
- **16.13 — Wallet rotation and payout recovery**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#1613-wallet-rotation-and-payout-recovery); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T036.

### System 17 — Reviews and disputes

Canonical contract: [section 17](../RAID_AGENT_BLUEPRINT.md#17-reviews-and-disputes). Accountable work: [T023](https://github.com/solana-hackathon-1/useRAID.fun/issues/65), [T024](https://github.com/solana-hackathon-1/useRAID.fun/issues/66), [T035](https://github.com/solana-hackathon-1/useRAID.fun/issues/77), [T036](https://github.com/solana-hackathon-1/useRAID.fun/issues/78), [O06](https://github.com/solana-hackathon-1/useRAID.fun/issues/29), [G03](https://github.com/solana-hackathon-1/useRAID.fun/issues/133).

- **17.1 — Review contract**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#171-review-contract); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T023, T024, T035, T036, O06, G03.
- **17.2 — What starts a dispute**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#172-what-starts-a-dispute); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T023, T024, T035, T036, O06, G03.
- **17.3 — Resolution outcomes**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#173-resolution-outcomes); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T023, T024, T035, T036, O06, G03.
- **17.4 — Appeals and reputation**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#174-appeals-and-reputation); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T035, T088, G03.
- **17.5 — Prevent indefinite work locks**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#175-prevent-indefinite-work-locks); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T024, T040.

### System 18 — Feed and sponsored placement

Canonical contract: [section 18](../RAID_AGENT_BLUEPRINT.md#18-feed-and-sponsored-placement). Accountable work: [T042](https://github.com/solana-hackathon-1/useRAID.fun/issues/84), [T060](https://github.com/solana-hackathon-1/useRAID.fun/issues/102), [T068](https://github.com/solana-hackathon-1/useRAID.fun/issues/110), [T097](https://github.com/solana-hackathon-1/useRAID.fun/issues/167), [G09](https://github.com/solana-hackathon-1/useRAID.fun/issues/139).

- **18.1 — Homepage and discovery**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#181-homepage-and-discovery); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T097, T015.
- **18.2 — Organic ordering**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#182-organic-ordering); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T097.
- **18.3 — Sponsored inventory**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#183-sponsored-inventory); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T060, G09.
- **18.4 — Bidding mode**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#184-bidding-mode); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T068, O17.
- **18.5 — Promotion lifecycle**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#185-promotion-lifecycle); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T042, T060, T068, T097, G09.
- **18.6 — Notification behavior**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#186-notification-behavior); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T042.

### System 19 — AI agents

Canonical contract: [section 19](../RAID_AGENT_BLUEPRINT.md#19-ai-agents). Accountable work: [T061](https://github.com/solana-hackathon-1/useRAID.fun/issues/103), [T062](https://github.com/solana-hackathon-1/useRAID.fun/issues/104), [T063](https://github.com/solana-hackathon-1/useRAID.fun/issues/105), [T064](https://github.com/solana-hackathon-1/useRAID.fun/issues/106), [T065](https://github.com/solana-hackathon-1/useRAID.fun/issues/107), [T066](https://github.com/solana-hackathon-1/useRAID.fun/issues/108), [T084](https://github.com/solana-hackathon-1/useRAID.fun/issues/126), [T094](https://github.com/solana-hackathon-1/useRAID.fun/issues/164), [G07](https://github.com/solana-hackathon-1/useRAID.fun/issues/137).

- **19.1 — Product role**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#191-product-role); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T061, T062, T063, T064, T065, T066, T084, T094, G07.
- **19.2 — Agent registration**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#192-agent-registration); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T061.
- **19.3 — Rank and routing**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#193-rank-and-routing); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T061, T066.
- **19.4 — Runtime state machine**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#194-runtime-state-machine); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T061, T062, T063, T064, T065, T066, T084, T094, G07.
- **19.5 — Tool authority**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#195-tool-authority); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T063.
- **19.6 — Confidential material and prompt injection**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#196-confidential-material-and-prompt-injection); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T063, T091.
- **19.7 — Spend control and economics**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#197-spend-control-and-economics); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T064, T094.
- **19.8 — Verification and failure**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#198-verification-and-failure); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T065, T066.
- **19.9 — Initial build boundary**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#199-initial-build-boundary); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T061, T062, T063, T064, T065, T066, T084, T094, G07.

### System 20 — AI influencers

Canonical contract: [section 20](../RAID_AGENT_BLUEPRINT.md#20-ai-influencers). Accountable work: [T070](https://github.com/solana-hackathon-1/useRAID.fun/issues/112), [T071](https://github.com/solana-hackathon-1/useRAID.fun/issues/113), [T085](https://github.com/solana-hackathon-1/useRAID.fun/issues/127), [T095](https://github.com/solana-hackathon-1/useRAID.fun/issues/165), [O16](https://github.com/solana-hackathon-1/useRAID.fun/issues/39), [G08](https://github.com/solana-hackathon-1/useRAID.fun/issues/138).

- **20.1 — What this participant is**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#201-what-this-participant-is); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T070, T071, T085, T095, O16, G08.
- **20.2 — Credibility and scope**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#202-credibility-and-scope); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T070, T071, T085, T095, O16, G08.
- **20.3 — Recommended reward structure**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#203-recommended-reward-structure); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T070, T071, T085, T095, O16, G08.
- **20.4 — Publishing workflow**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#204-publishing-workflow); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T070, T085.
- **20.5 — Capacity and product staging**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#205-capacity-and-product-staging); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T095, T024.

### System 21 — Ongoing Roles

Canonical contract: [section 21](../RAID_AGENT_BLUEPRINT.md#21-ongoing-roles). Accountable work: [T073](https://github.com/solana-hackathon-1/useRAID.fun/issues/115), [T086](https://github.com/solana-hackathon-1/useRAID.fun/issues/128), [O19](https://github.com/solana-hackathon-1/useRAID.fun/issues/42).

- **21.1 — Purpose**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#211-purpose); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T073, T086, O19.
- **21.2 — Respect capacity**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#212-respect-capacity); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T073, T086.
- **21.3 — Renewal and closure**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#213-renewal-and-closure); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T073, T086, O19.

### System 22 — Token economy

Canonical contract: [section 22](../RAID_AGENT_BLUEPRINT.md#22-token-economy). Accountable work: [T074](https://github.com/solana-hackathon-1/useRAID.fun/issues/116), [T075](https://github.com/solana-hackathon-1/useRAID.fun/issues/117), [T093](https://github.com/solana-hackathon-1/useRAID.fun/issues/163), [O03](https://github.com/solana-hackathon-1/useRAID.fun/issues/26), [O04](https://github.com/solana-hackathon-1/useRAID.fun/issues/27).

- **22.1 — Three asset relationships**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#221-three-asset-relationships); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T074, T075, T093, O03, O04.
- **22.2 — Rank and license policy**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#222-rank-and-license-policy); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T074, O04.
- **22.3 — Prospective revenue**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#223-prospective-revenue); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T074, T075, T093, O03, O04.
- **22.4 — Beta and token launch**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#224-beta-and-token-launch); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T075, O03.
- **22.5 — Project treasury behavior**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#225-project-treasury-behavior); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T093.

### System 23 — Screens and user experience

Canonical contract: [section 23](../RAID_AGENT_BLUEPRINT.md#23-screens-and-user-experience). Accountable work: [U001](https://github.com/solana-hackathon-1/useRAID.fun/issues/142), [U002](https://github.com/solana-hackathon-1/useRAID.fun/issues/143), [U003](https://github.com/solana-hackathon-1/useRAID.fun/issues/144), [U004](https://github.com/solana-hackathon-1/useRAID.fun/issues/145), [U005](https://github.com/solana-hackathon-1/useRAID.fun/issues/146), [U006](https://github.com/solana-hackathon-1/useRAID.fun/issues/147), [U007](https://github.com/solana-hackathon-1/useRAID.fun/issues/148), [U008](https://github.com/solana-hackathon-1/useRAID.fun/issues/149), [U009](https://github.com/solana-hackathon-1/useRAID.fun/issues/150), [U010](https://github.com/solana-hackathon-1/useRAID.fun/issues/151), [U011](https://github.com/solana-hackathon-1/useRAID.fun/issues/152), [U012](https://github.com/solana-hackathon-1/useRAID.fun/issues/153), [U013](https://github.com/solana-hackathon-1/useRAID.fun/issues/154), [U014](https://github.com/solana-hackathon-1/useRAID.fun/issues/155), [U015](https://github.com/solana-hackathon-1/useRAID.fun/issues/156), [U016](https://github.com/solana-hackathon-1/useRAID.fun/issues/157).

- **23.1 — Design direction**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#231-design-direction); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: U001, U002, U003, U004, U005, U006, U007, U008, U009, U010, U011, U012, U013, U014, U015, U016.
- **23.2 — Screen contract**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#232-screen-contract); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: U001, U002, U003, U004, U005, U006, U007, U008, U009, U010, U011, U012, U013, U014, U015, U016.
- **23.3 — Suggested navigation**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#233-suggested-navigation); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: U001, U002, U003, U004, U005, U006, U007, U008, U009, U010, U011, U012, U013, U014, U015, U016.
- **23.4 — Eligibility presentation**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#234-eligibility-presentation); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: U001, U002, U003, U004, U005, U006, U007, U008, U009, U010, U011, U012, U013, U014, U015, U016.
- **23.5 — Financial interaction**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#235-financial-interaction); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: U001, U002, U003, U004, U005, U006, U007, U008, U009, U010, U011, U012, U013, U014, U015, U016.
- **23.6 — Private information**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#236-private-information); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: U001, U002, U003, U004, U005, U006, U007, U008, U009, U010, U011, U012, U013, U014, U015, U016.
- **23.7 — Accessibility and scanning**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#237-accessibility-and-scanning); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T045, U001, U002, U003, U004, U005, U006, U007, U008, U009, U010, U011, U012, U013, U014, U015, U016.
- **23.8 — Mandatory non-happy states**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#238-mandatory-non-happy-states); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: U001, U002, U003, U004, U005, U006, U007, U008, U009, U010, U011, U012, U013, U014, U015, U016.

### System 24 — System architecture

Canonical contract: [section 24](../RAID_AGENT_BLUEPRINT.md#24-system-architecture). Accountable work: [T002](https://github.com/solana-hackathon-1/useRAID.fun/issues/44), [T005](https://github.com/solana-hackathon-1/useRAID.fun/issues/47), [T037](https://github.com/solana-hackathon-1/useRAID.fun/issues/79), [T039](https://github.com/solana-hackathon-1/useRAID.fun/issues/81), [T063](https://github.com/solana-hackathon-1/useRAID.fun/issues/105), [O18](https://github.com/solana-hackathon-1/useRAID.fun/issues/41).

- **24.1 — Recommended stack and why**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#241-recommended-stack-and-why); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T002, T005, T037, T039, T063, O18.
- **24.2 — Topology**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#242-topology); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T002, T005, T037, T039, T063, O18.
- **24.3 — Domain ownership**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#243-domain-ownership); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T002, T005, T037, T039, T063, O18.
- **24.4 — Source of truth**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#244-source-of-truth); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T002, T039.
- **24.5 — Suggested repository boundaries**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#245-suggested-repository-boundaries); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T002, T005, T037, T039, T063, O18.

### System 25 — Domain and data model

Canonical contract: [section 25](../RAID_AGENT_BLUEPRINT.md#25-domain-and-data-model). Accountable work: [T002](https://github.com/solana-hackathon-1/useRAID.fun/issues/44), [T003](https://github.com/solana-hackathon-1/useRAID.fun/issues/45), [T009](https://github.com/solana-hackathon-1/useRAID.fun/issues/51), [T012](https://github.com/solana-hackathon-1/useRAID.fun/issues/54), [T016](https://github.com/solana-hackathon-1/useRAID.fun/issues/58), [T020](https://github.com/solana-hackathon-1/useRAID.fun/issues/62), [T029](https://github.com/solana-hackathon-1/useRAID.fun/issues/71), [T053](https://github.com/solana-hackathon-1/useRAID.fun/issues/95), [T056](https://github.com/solana-hackathon-1/useRAID.fun/issues/98), [T058](https://github.com/solana-hackathon-1/useRAID.fun/issues/100), [T061](https://github.com/solana-hackathon-1/useRAID.fun/issues/103), [T092](https://github.com/solana-hackathon-1/useRAID.fun/issues/162).

- **25.1 — Modeling conventions**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#251-modeling-conventions); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T002, T003, T009, T012, T016, T020, T029, T053, T056, T058, T061, T092.
- **25.2 — Identity and Guild entities**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#252-identity-and-guild-entities); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T002, T003, T009, T012, T016, T020, T029, T053, T056, T058, T061, T092.
- **25.3 — Skills and trust entities**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#253-skills-and-trust-entities); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T002, T003, T009, T012, T016, T020, T029, T053, T056, T058, T061, T092.
- **25.4 — Work entities**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#254-work-entities); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T002, T003, T009, T012, T016, T020, T029, T053, T056, T058, T061, T092.
- **25.5 — Challenge, finance, and access entities**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#255-challenge-finance-and-access-entities); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T002, T003, T009, T012, T016, T020, T029, T053, T056, T058, T061, T092.
- **25.6 — Discovery, execution, and operational entities**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#256-discovery-execution-and-operational-entities); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T002, T003, T009, T012, T016, T020, T029, T053, T056, T058, T061, T092.
- **25.7 — Separate state machines**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#257-separate-state-machines); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T002, T003, T009, T012, T016, T020, T029, T053, T056, T058, T061, T092.
- **25.8 — Constraints and deletion**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#258-constraints-and-deletion); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T003, T092.

### System 26 — API contracts

Canonical contract: [section 26](../RAID_AGENT_BLUEPRINT.md#26-api-contracts). Accountable work: [T002](https://github.com/solana-hackathon-1/useRAID.fun/issues/44), [T019](https://github.com/solana-hackathon-1/useRAID.fun/issues/61), [T089](https://github.com/solana-hackathon-1/useRAID.fun/issues/159).

- **26.1 — Common conventions**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#261-common-conventions); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T089.
- **26.2 — Endpoint families**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#262-endpoint-families); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T089, E23.
- **26.3 — Eligibility response example**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#263-eligibility-response-example); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T002, T019, T089.
- **26.4 — Error envelope and statuses**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#264-error-envelope-and-statuses); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T002, T019, T089.
- **26.5 — Public and private API shapes**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#265-public-and-private-api-shapes); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T015, T053, T089.

### System 27 — Events and background jobs

Canonical contract: [section 27](../RAID_AGENT_BLUEPRINT.md#27-events-and-background-jobs). Accountable work: [T019](https://github.com/solana-hackathon-1/useRAID.fun/issues/61), [T024](https://github.com/solana-hackathon-1/useRAID.fun/issues/66), [T028](https://github.com/solana-hackathon-1/useRAID.fun/issues/70), [T033](https://github.com/solana-hackathon-1/useRAID.fun/issues/75), [T038](https://github.com/solana-hackathon-1/useRAID.fun/issues/80), [T042](https://github.com/solana-hackathon-1/useRAID.fun/issues/84), [T054](https://github.com/solana-hackathon-1/useRAID.fun/issues/96), [T070](https://github.com/solana-hackathon-1/useRAID.fun/issues/112).

- **27.1 — Event envelope**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#271-event-envelope); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T019, T024, T028, T033, T038, T042, T054, T070.
- **27.2 — Event families**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#272-event-families); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T019, T024, T028, T033, T038, T042, T054, T070.
- **27.3 — Outbox/inbox behavior**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#273-outboxinbox-behavior); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T019, T038.
- **27.4 — Essential jobs**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#274-essential-jobs); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T019, T024, T028, T033, T038, T042, T054, T070.
- **27.5 — Deduplication keys**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#275-deduplication-keys); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T019, T038.

### System 28 — Permissions and security

Canonical contract: [section 28](../RAID_AGENT_BLUEPRINT.md#28-permissions-and-security). Accountable work: [T007](https://github.com/solana-hackathon-1/useRAID.fun/issues/49), [T014](https://github.com/solana-hackathon-1/useRAID.fun/issues/56), [T035](https://github.com/solana-hackathon-1/useRAID.fun/issues/77), [T053](https://github.com/solana-hackathon-1/useRAID.fun/issues/95), [T055](https://github.com/solana-hackathon-1/useRAID.fun/issues/97), [T063](https://github.com/solana-hackathon-1/useRAID.fun/issues/105), [T090](https://github.com/solana-hackathon-1/useRAID.fun/issues/160), [T091](https://github.com/solana-hackathon-1/useRAID.fun/issues/161).

- **28.1 — Authorization model**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#281-authorization-model); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T007, T014, T035, T053, T055, T063, T090, T091.
- **28.2 — High-risk boundaries**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#282-high-risk-boundaries); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T007, T014, T035, T053, T055, T063, T090, T091.
- **28.3 — Web and integration security**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#283-web-and-integration-security); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T091.
- **28.4 — Threat containment versus final judgment**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#284-threat-containment-versus-final-judgment); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T035, T040.
- **28.5 — Confidentiality limits**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#285-confidentiality-limits); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T007, T014, T035, T053, T055, T063, T090, T091.

### System 29 — Configuration and administration

Canonical contract: [section 29](../RAID_AGENT_BLUEPRINT.md#29-configuration-and-administration). Accountable work: [T037](https://github.com/solana-hackathon-1/useRAID.fun/issues/79), [T093](https://github.com/solana-hackathon-1/useRAID.fun/issues/163), [O08](https://github.com/solana-hackathon-1/useRAID.fun/issues/31).

- **29.1 — Editable business configuration**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#291-editable-business-configuration); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T037, T093, O08.
- **29.2 — Configuration boundaries**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#292-configuration-boundaries); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T037, T093, O08.
- **29.3 — Feature flags**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#293-feature-flags); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T037, T093, O08.
- **29.4 — Admin audit and safe changes**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#294-admin-audit-and-safe-changes); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T037.

### System 30 — Operations and recovery

Canonical contract: [section 30](../RAID_AGENT_BLUEPRINT.md#30-operations-and-recovery). Accountable work: [T005](https://github.com/solana-hackathon-1/useRAID.fun/issues/47), [T034](https://github.com/solana-hackathon-1/useRAID.fun/issues/76), [T038](https://github.com/solana-hackathon-1/useRAID.fun/issues/80), [T039](https://github.com/solana-hackathon-1/useRAID.fun/issues/81), [T040](https://github.com/solana-hackathon-1/useRAID.fun/issues/82), [T046](https://github.com/solana-hackathon-1/useRAID.fun/issues/88), [T092](https://github.com/solana-hackathon-1/useRAID.fun/issues/162), [G10](https://github.com/solana-hackathon-1/useRAID.fun/issues/140).

- **30.1 — Environments**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#301-environments); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T005, T034, T038, T039, T040, T046, T092, G10.
- **30.2 — Operational ownership**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#302-operational-ownership); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T005, T034, T038, T039, T040, T046, T092, G10.
- **30.3 — Monitored signals**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#303-monitored-signals); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T005, T034, T038, T039, T040, T046, T092, G10.
- **30.4 — Incident playbooks**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#304-incident-playbooks); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T005, T034, T038, T039, T040, T046, T092, G10.
- **30.5 — Backups and restore**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#305-backups-and-restore); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T039, T046, T087.
- **30.6 — Deployment and rollback**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#306-deployment-and-rollback); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T003, T040.

### System 31 — Metrics

Canonical contract: [section 31](../RAID_AGENT_BLUEPRINT.md#31-metrics). Accountable work: [T041](https://github.com/solana-hackathon-1/useRAID.fun/issues/83), [T043](https://github.com/solana-hackathon-1/useRAID.fun/issues/85), [T071](https://github.com/solana-hackathon-1/useRAID.fun/issues/113), [T072](https://github.com/solana-hackathon-1/useRAID.fun/issues/114).

- **31.1 — Product success**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#311-product-success); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T041, T043, T071, T072.
- **31.2 — Reporting integrity**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#312-reporting-integrity); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T043, T071.
- **31.3 — Quality and fairness checks**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#313-quality-and-fairness-checks); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T041, T043, T071, T072.

### System 32 — Testing strategy

Canonical contract: [section 32](../RAID_AGENT_BLUEPRINT.md#32-testing-strategy). Accountable work: [T004](https://github.com/solana-hackathon-1/useRAID.fun/issues/46), [T078](https://github.com/solana-hackathon-1/useRAID.fun/issues/120), [T079](https://github.com/solana-hackathon-1/useRAID.fun/issues/121), [T080](https://github.com/solana-hackathon-1/useRAID.fun/issues/122), [T081](https://github.com/solana-hackathon-1/useRAID.fun/issues/123), [T082](https://github.com/solana-hackathon-1/useRAID.fun/issues/124), [T083](https://github.com/solana-hackathon-1/useRAID.fun/issues/125), [T084](https://github.com/solana-hackathon-1/useRAID.fun/issues/126), [T085](https://github.com/solana-hackathon-1/useRAID.fun/issues/127), [T086](https://github.com/solana-hackathon-1/useRAID.fun/issues/128), [T087](https://github.com/solana-hackathon-1/useRAID.fun/issues/129), [T088](https://github.com/solana-hackathon-1/useRAID.fun/issues/130).

- **32.1 — Test what can fail materially**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#321-test-what-can-fail-materially); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T004, T078, T079, T080, T081, T082, T083, T084, T085, T086, T087, T088.
- **32.2 — Real concurrency tests**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#322-real-concurrency-tests); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T079, T082, T084.
- **32.3 — Financial property tests**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#323-financial-property-tests); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T080.
- **32.4 — Fixture design**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#324-fixture-design); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T004.
- **32.5 — Release evidence**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#325-release-evidence); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T004, T078, T079, T080, T081, T082, T083, T084, T085, T086, T087, T088.

### System 33 — Agent work contracts

Canonical contract: [section 33](../RAID_AGENT_BLUEPRINT.md#33-agent-work-contracts). Accountable work: [T002](https://github.com/solana-hackathon-1/useRAID.fun/issues/44), [T004](https://github.com/solana-hackathon-1/useRAID.fun/issues/46), [T096](https://github.com/solana-hackathon-1/useRAID.fun/issues/166).

- **33.1 — Shared operating agreement**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#331-shared-operating-agreement); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T002, T004, T096.
- **33.2 — Agent roster**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#332-agent-roster); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T002, T004, T096.
- **33.3 — AG01 — Product and orchestration**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#333-ag01--product-and-orchestration); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T002, T004, T096.
- **33.4 — AG02 — Frontend and experience**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#334-ag02--frontend-and-experience); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T002, T004, T096.
- **33.5 — AG03 — Backend and domain**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#335-ag03--backend-and-domain); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T002, T004, T096.
- **33.6 — AG04 — Solana and treasury**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#336-ag04--solana-and-treasury); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T002, T004, T096.
- **33.7 — AG05 — Trust and private access**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#337-ag05--trust-and-private-access); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T002, T004, T096.
- **33.8 — AG06 — AI execution**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#338-ag06--ai-execution); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T002, T004, T096.
- **33.9 — AG07 — Discovery and distribution**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#339-ag07--discovery-and-distribution); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T002, T004, T096.
- **33.10 — AG08 — QA and security**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#3310-ag08--qa-and-security); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T002, T004, T096.
- **33.11 — AG09 — Operations and release**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#3311-ag09--operations-and-release); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T002, T004, T096.
- **33.12 — AG10 — Documentation and integration**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#3312-ag10--documentation-and-integration); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T002, T004, T096.

### System 34 — Build sequence

Canonical contract: [section 34](../RAID_AGENT_BLUEPRINT.md#34-build-sequence). Accountable work: [T096](https://github.com/solana-hackathon-1/useRAID.fun/issues/166), [T047](https://github.com/solana-hackathon-1/useRAID.fun/issues/89), [T051](https://github.com/solana-hackathon-1/useRAID.fun/issues/93), [T077](https://github.com/solana-hackathon-1/useRAID.fun/issues/119), [G01](https://github.com/solana-hackathon-1/useRAID.fun/issues/131), [G02](https://github.com/solana-hackathon-1/useRAID.fun/issues/132), [G03](https://github.com/solana-hackathon-1/useRAID.fun/issues/133), [G04](https://github.com/solana-hackathon-1/useRAID.fun/issues/134), [G05](https://github.com/solana-hackathon-1/useRAID.fun/issues/135), [G06](https://github.com/solana-hackathon-1/useRAID.fun/issues/136), [G07](https://github.com/solana-hackathon-1/useRAID.fun/issues/137), [G08](https://github.com/solana-hackathon-1/useRAID.fun/issues/138), [G09](https://github.com/solana-hackathon-1/useRAID.fun/issues/139), [G10](https://github.com/solana-hackathon-1/useRAID.fun/issues/140).

- **34.1 — Delivery principle**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#341-delivery-principle); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T096, T047, T051, T077, G01, G02, G03, G04, G05, G06, G07, G08, G09, G10.
- **34.2 — Version labels**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#342-version-labels); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T096, T047, T051, T077, G01, G02, G03, G04, G05, G06, G07, G08, G09, G10.
- **34.3 — First implementation assignment**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#343-first-implementation-assignment); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T096, T047, T051, T077, G01, G02, G03, G04, G05, G06, G07, G08, G09, G10.
- **34.4 — Required production gates**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#344-required-production-gates); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: G01, G02, G03, G04, G05, G06, G07, G08, G09, G10.

### System 35 — Acceptance scenarios

Canonical contract: [section 35](../RAID_AGENT_BLUEPRINT.md#35-acceptance-scenarios). Accountable work: [T078](https://github.com/solana-hackathon-1/useRAID.fun/issues/120), [T079](https://github.com/solana-hackathon-1/useRAID.fun/issues/121), [T080](https://github.com/solana-hackathon-1/useRAID.fun/issues/122), [T081](https://github.com/solana-hackathon-1/useRAID.fun/issues/123), [T082](https://github.com/solana-hackathon-1/useRAID.fun/issues/124), [T083](https://github.com/solana-hackathon-1/useRAID.fun/issues/125), [T084](https://github.com/solana-hackathon-1/useRAID.fun/issues/126), [T085](https://github.com/solana-hackathon-1/useRAID.fun/issues/127), [T086](https://github.com/solana-hackathon-1/useRAID.fun/issues/128), [T087](https://github.com/solana-hackathon-1/useRAID.fun/issues/129), [T088](https://github.com/solana-hackathon-1/useRAID.fun/issues/130).

- **35.1 — Identity, skills, and trust**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#351-identity-skills-and-trust); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T078, T079, T080, T081, T082, T083, T084, T085, T086, T087, T088.
- **35.2 — Capacity and work lifecycle**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#352-capacity-and-work-lifecycle); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T078, T079, T080, T081, T082, T083, T084, T085, T086, T087, T088.
- **35.3 — Money and chain**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#353-money-and-chain); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T078, T079, T080, T081, T082, T083, T084, T085, T086, T087, T088.
- **35.4 — Privacy and code**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#354-privacy-and-code); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T078, T079, T080, T081, T082, T083, T084, T085, T086, T087, T088.
- **35.5 — Challenges, Parties, sponsorship, and AI**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#355-challenges-parties-sponsorship-and-ai); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T078, T079, T080, T081, T082, T083, T084, T085, T086, T087, T088.
- **35.6 — End-to-end and recovery**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#356-end-to-end-and-recovery); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T078, T079, T080, T081, T082, T083, T084, T085, T086, T087, T088.

### System 36 — Worked examples

Canonical contract: [section 36](../RAID_AGENT_BLUEPRINT.md#36-worked-examples). Accountable work: [T044](https://github.com/solana-hackathon-1/useRAID.fun/issues/86), [T054](https://github.com/solana-hackathon-1/useRAID.fun/issues/96), [T059](https://github.com/solana-hackathon-1/useRAID.fun/issues/101), [T069](https://github.com/solana-hackathon-1/useRAID.fun/issues/111), [T066](https://github.com/solana-hackathon-1/useRAID.fun/issues/108).

- **36.1 — Beginner completes a first public Raid**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#361-beginner-completes-a-first-public-raid); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T044, T054, T059, T069, T066.
- **36.2 — Experienced developer joins a confidential Guild task**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#362-experienced-developer-joins-a-confidential-guild-task); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T044, T054, T059, T069, T066.
- **36.3 — Selection Challenge chooses a Party**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#363-selection-challenge-chooses-a-party); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T044, T054, T059, T069, T066.
- **36.4 — Mixed reward with a blocked leg**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#364-mixed-reward-with-a-blocked-leg); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T044, T054, T059, T069, T066.
- **36.5 — Managed AI task reaches its cap**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#365-managed-ai-task-reaches-its-cap); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T044, T054, T059, T069, T066.

### System 37 — What agents must not infer

Canonical contract: [section 37](../RAID_AGENT_BLUEPRINT.md#37-what-agents-must-not-infer). Accountable work: [T096](https://github.com/solana-hackathon-1/useRAID.fun/issues/166), [T001](https://github.com/solana-hackathon-1/useRAID.fun/issues/43), [E23](https://github.com/solana-hackathon-1/useRAID.fun/issues/158).

### System 38 — Open decisions

Canonical contract: [section 38](../RAID_AGENT_BLUEPRINT.md#38-open-decisions). Accountable work: [O01](https://github.com/solana-hackathon-1/useRAID.fun/issues/24), [O02](https://github.com/solana-hackathon-1/useRAID.fun/issues/25), [O03](https://github.com/solana-hackathon-1/useRAID.fun/issues/26), [O04](https://github.com/solana-hackathon-1/useRAID.fun/issues/27), [O05](https://github.com/solana-hackathon-1/useRAID.fun/issues/28), [O06](https://github.com/solana-hackathon-1/useRAID.fun/issues/29), [O07](https://github.com/solana-hackathon-1/useRAID.fun/issues/30), [O08](https://github.com/solana-hackathon-1/useRAID.fun/issues/31), [O09](https://github.com/solana-hackathon-1/useRAID.fun/issues/32), [O10](https://github.com/solana-hackathon-1/useRAID.fun/issues/33), [O11](https://github.com/solana-hackathon-1/useRAID.fun/issues/34), [O12](https://github.com/solana-hackathon-1/useRAID.fun/issues/35), [O13](https://github.com/solana-hackathon-1/useRAID.fun/issues/36), [O14](https://github.com/solana-hackathon-1/useRAID.fun/issues/37), [O15](https://github.com/solana-hackathon-1/useRAID.fun/issues/38), [O16](https://github.com/solana-hackathon-1/useRAID.fun/issues/39), [O17](https://github.com/solana-hackathon-1/useRAID.fun/issues/40), [O18](https://github.com/solana-hackathon-1/useRAID.fun/issues/41), [O19](https://github.com/solana-hackathon-1/useRAID.fun/issues/42).

### System 39 — Definition of done

Canonical contract: [section 39](../RAID_AGENT_BLUEPRINT.md#39-definition-of-done). Accountable work: [T096](https://github.com/solana-hackathon-1/useRAID.fun/issues/166), [T047](https://github.com/solana-hackathon-1/useRAID.fun/issues/89), [T051](https://github.com/solana-hackathon-1/useRAID.fun/issues/93), [T077](https://github.com/solana-hackathon-1/useRAID.fun/issues/119).

- **39.1 — A feature is complete when**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#391-a-feature-is-complete-when); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T096, T047, T051, T077.
- **39.2 — A task handoff is complete when**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#392-a-task-handoff-is-complete-when); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T096, T047, T051, T077.
- **39.3 — Whole-product implementation status**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#393-whole-product-implementation-status); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T096.

### System 40 — Handoff templates

Canonical contract: [section 40](../RAID_AGENT_BLUEPRINT.md#40-handoff-templates). Accountable work: [T002](https://github.com/solana-hackathon-1/useRAID.fun/issues/44), [T004](https://github.com/solana-hackathon-1/useRAID.fun/issues/46), [T096](https://github.com/solana-hackathon-1/useRAID.fun/issues/166).

- **40.1 — Starter instruction for a new development agent**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#401-starter-instruction-for-a-new-development-agent); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T002, T004, T096.
- **40.2 — Bounded task packet**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#402-bounded-task-packet); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T002, T004, T096.
- **40.3 — Completion report**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#403-completion-report); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T002, T004, T096.
- **40.4 — Decision record**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#404-decision-record); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T002, T004, T096.
- **40.5 — Change-management rule**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#405-change-management-rule); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T002, T004, T096.

### System 41 — Sources

Canonical contract: [section 41](../RAID_AGENT_BLUEPRINT.md#41-sources). Accountable work: [T001](https://github.com/solana-hackathon-1/useRAID.fun/issues/43), [T096](https://github.com/solana-hackathon-1/useRAID.fun/issues/166), [T026](https://github.com/solana-hackathon-1/useRAID.fun/issues/68), [T030](https://github.com/solana-hackathon-1/useRAID.fun/issues/72), [T090](https://github.com/solana-hackathon-1/useRAID.fun/issues/160).

- **41.1 — Product source**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#411-product-source); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T001, T096, T026, T030, T090.
- **41.2 — Primary technical references**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#412-primary-technical-references); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T001, T096, T026, T030, T090.
- **41.3 — Final implementation reminder**: verify the complete [canonical contract](../RAID_AGENT_BLUEPRINT.md#413-final-implementation-reminder); record applicable entities, actor authority, state/effect invariants, negative/recovery tests and reviewed evidence in the assigned task. Owners: T001, T096, T026, T030, T090.

## Completion packet validator

Run `python3 scripts/verify-raid-completion.py T001 path/to/report.json` using the exact issue ID. The validator fails for changed blueprint source, absent criteria, unexecuted/failed/blocked results, unknown criteria, missing evidence metadata and self-approved review/exclusion. Its exit code checks packet completeness, not the truth of reports or GitHub permissions. A reviewer must inspect actual evidence and confirm any NOT APPLICABLE rationale against the task boundary; it cannot waive a mandatory applicable invariant.

The JSON report requires `task_id`, `implementer`, independent `reviewer`, `handoff`, `migration_rollback`, `dependency_evidence`, `open_decisions`, `release_gate_disposition` and a `criteria` object keyed by every criterion ID from [the task registry](../planning/raid-task-contracts.json). Where a report-level subject has no effect, provide an explicit rationale rather than omitting it.

PASS criterion records require `result`, `canonical_reference`, `repository_facts`, `entities`, `permissions`, `state_transitions`, `setup`, `action`, `expected`, `observed`, `evidence_url`, full 40-character commit `sha`, `environment` and independent `reviewer`. NOT APPLICABLE records require `result`, boundary-specific `rationale`, `canonical_reference` and independent `reviewer`. No criterion is initialized as PASS.

## Explicit domain bindings

These are intended review boundaries, not claims that these entities or behaviors already exist in the repository. Apply only the task’s assigned slice; its epic retains the remaining system requirements.

### E01 — Shared contracts and architecture

**Affected canonical records:** accounts, participants, terms_versions, engagements, active_commitments, assets, command_receipts, outbox_events, audit_events.

**Permission contract:** Domain owners define commands; operations have scoped repair authority; development access does not imply customer or treasury authority.

**State/effect contract:** Additive migration/backfill; immutable terms and semantic IDs survive rollback/restore; constraints and outbox are established before dependent slices.

**Required adverse evidence:** Legacy obligations survive migration; crash after external success; restore with missing recent acceptance; same idempotency key with altered request.

### E02 — Identity and authentication

**Affected canonical records:** accounts, auth_sessions, identity_links, wallet_links, participants.

**Permission contract:** Account subject must prove wallet/provider control and link intent; one wallet proof never redirects another account’s outstanding claim.

**State/effect contract:** One-use nonce/session, verified/revoked wallet links and stable canonical participant; rotation preserves history/capacity.

**Required adverse evidence:** Nonce replay/domain substitution; second wallet while busy; identity collision; removed wallet with unpaid claim; stale provider evidence.

### E03 — Guild authority and membership

**Affected canonical records:** guilds, guild_role_grants, guild_tokens, membership_observations, guild_preferences.

**Permission contract:** Founder authority is verified/delegated; holding tokens supplies eligibility only, never administration, treasury or code permission.

**State/effect contract:** Pending token relationship becomes verified only from real evidence; holder observations distinguish current, stale and unknown.

**Required adverse evidence:** Holder direct-admin/download attack; RPC outage; wrong network/mint; existing-project authority proof; profile updates limited to authorized fields.

### E04 — Skills and assessments

**Affected canonical records:** skills, skill_claims, skill_assessments, trial_definitions, trial_attempts.

**Permission contract:** Participant claims are distinct from authorized assessment; relevant skill/rubric determines rank; purchased tokens or model price cannot grant it.

**State/effect contract:** Versioned assessment and retained history; reassessment/revocation are explicit; public/sanitized orientation does not consume paid-work capacity.

**Required adverse evidence:** Wrong skill family despite high headline rank; experienced newcomer assessment; reused trial; false evidence; buying tokens leaves skill eligibility unchanged.

### E05 — Raid terms and recommendations

**Affected canonical records:** raids, raid_slots, terms_versions, applications, offers, reward_obligations.

**Permission contract:** Founder publishes within Guild scope; recommendations propose bounded drafts; executor accepts exact terms; affected actors consent to material amendments.

**State/effect contract:** DRAFT/FUNDING_PENDING/OPEN remain listing states; terms frozen on acceptance; offers do not reserve work; current funding and eligibility rechecked.

**Required adverse evidence:** Missing required publication fields; unilateral scope/reward/deadline changes; stale draft/quote/offer; unknown price; unsupported reward composition.

### E06 — Atomic engagement capacity

**Affected canonical records:** engagements, engagement_members, active_commitments, operator_commitments, offers, raid_slots.

**Permission contract:** Canonical acceptance command authorizes each participant, consent, source vacancy, current restrictions and operator cap.

**State/effect contract:** Accept transaction locks source/operators/participants in stable order; creates ACCESS_PENDING plus all reservations or rolls back; StartEngagement rechecks binding and grants.

**Required adverse evidence:** Two accepts for one participant; two applicants for one slot; busy Party member; Challenge versus Raid; stale cleanup; same-engagement operator members.

### E07 — Delivery, review and bounded closure

**Affected canonical records:** submissions, reviews, engagements, terms_versions, disputes, active_commitments.

**Permission contract:** Assigned executor submits own exact version; separately authorized reviewer decides against accepted criteria; no self-approval or unilateral rewrite.

**State/effect contract:** IN_PROGRESS/SUBMITTED/UNDER_REVIEW/REVISION_REQUESTED retain capacity; terminal operational outcome releases matching engagement independently of money.

**Required adverse evidence:** Silent reviewer; no submission; revision duty; payment pending after acceptance; replacement; attempted reopening while worker already has new engagement.

### E08 — Launch route and existing project

**Affected canonical records:** launch_intents, guilds, guild_tokens, chain_operations, transaction_attempts.

**Permission contract:** Verified founder authorizes a specific intent/protocol/parameters; selected program/provider and fee authority require recorded decisions and G01 evidence.

**State/effect contract:** DRAFT/READY_FOR_SIGNATURE/SUBMITTED/CONFIRMED_PENDING_FINALITY/LIVE/ACTION_REQUIRED/FAILED/CANCELLED report actual artifacts; existing onboarding is labeled separately.

**Required adverse evidence:** Rejected signature; expired quote; submitted transaction never finalizes; partial route success; duplicate intent retry; wrong mint/program; mock mainnet config.

### E09 — Escrow, assets and settlement

**Affected canonical records:** assets, reward_obligations, escrow_agreements, funding_observations, settlement_allocations, claims, ledger_entries, chain_operations, transaction_attempts.

**Permission contract:** Funder, allowed beneficiaries, allocation authority and claim authority follow accepted terms and chosen escrow contract; client signatures alone prove no funding.

**State/effect contract:** Agreement/funding/claim/attempt states separate; verified credit bounds paid+refunded+remaining per asset; protected committed reserves cannot be withdrawn as uncommitted funds.

**Required adverse evidence:** Partial multi-asset deposit; same ticker different mint; refund/binding race; duplicate webhook; rebuilt claim signature; frozen transfer; partial Party payout; asset-policy change.

### E10 — Disputes, finality and claims

**Affected canonical records:** disputes, reviews, settlement_allocations, claims, reputation_events, restriction_cases.

**Permission contract:** Declared case authority and permitted appeal process decide evidence; neither silence nor suspicion invents fault, payout authority or confiscation.

**State/effect contract:** Operational closure, case lifecycle, final decision/appeal window, hold and claimability remain separate; corrections preserve attributable history.

**Required adverse evidence:** Appeal at claimability boundary; unauthorized beneficiary change; reversed finding; restricted account unpaid claim; finite work closure during unresolved money.

### E11 — Operations, administration and recovery

**Affected canonical records:** configuration_versions, audit_events, outbox_events, webhook_inbox, job_attempts, command_receipts.

**Permission contract:** Scoped support/access/finance/product permissions; named case/release owner; audited configuration changes; no arbitrary force-paid or erase-history action.

**State/effect contract:** Flags block new server commands while preserving old claims/reconciliation; backup/restore recovers terms/consents/semantic IDs/capacity before writes resume.

**Required adverse evidence:** Worker crash; lost snapshot interval; repeated outbox/inbox; failed provider; stale grant job; unavailable safe recovery; rollback after irreversible external effect.

### E12 — Internal alpha

**Affected canonical records:** Candidate fixtures, scenario evidence, existing domain aggregates and defect records.

**Permission contract:** Internal representative testers and reviewers exercise approved nonproduction scope; simulated effects stay labeled; no invented tester result.

**State/effect contract:** Entry evidence → observed journeys → defects → fixes/retest → recorded stage decision; failing invariant keeps affected capability unavailable.

**Required adverse evidence:** All applicable core negative/race/recovery scenarios; accessible wallet rejection/retry; actual candidate SHA and environment; blocker disposition.

### E13 — Closed/public beta and release

**Affected canonical records:** Cohort/support records, candidate evidence, feature flags, issue defects and operational gates.

**Permission contract:** Project owner and affected release reviewers approve bounded enabled scope after applicable terms, money, access and operations evidence.

**State/effect contract:** Closed-beta feedback/retest precedes conditional public beta; independent feature pilots need their own gates; calendar completion cannot promote a stage.

**Required adverse evidence:** Representative end-to-end failures; incident support ownership; beta defect regression; unpassed gate; permitted limited release; rollback/disabled-action cleanup.

### E14 — Discovery, notifications and metrics

**Affected canonical records:** Public raid projections, notifications, notification_preferences, reputation_projections, metrics.

**Permission contract:** Server eligibility and visibility constrain listings; marketing consent is separate from holder membership; public reporting cannot expose private identifiers/bytes.

**State/effect contract:** Funded/open discovery and explicit sortable criteria; unavailable valuation remains unknown; attributed events build reproducible denominators/confidence.

**Required adverse evidence:** Private payload/search/preview leak; wrong-skill eligibility; incomparable token sorting; stale membership; duplicate notification; paid placement affects no earned credibility.

### E15 — Private resources and effective grants

**Affected canonical records:** raid_private_briefs, resources, access_grants, engagement_members, audit_events.

**Permission contract:** Explicit resource/purpose/scope/duration grant plus current task authority; rank, token balance and repository branch protections do not create confidentiality.

**State/effect contract:** Desired grant state and observed provider rights reconciled by generation; independent rights preserved; expired/revoked access cleaned up with incidents visible.

**Required adverse evidence:** Guessed object/download; high-rank holder denied; folder secrecy claim rejected; stale grant revive attempt; failed revoke; source grant removal preserves valid target grant.

### E16 — Parties and shared execution

**Affected canonical records:** parties, party_members, engagement_members, active_commitments, operator_commitments, terms_versions, claims.

**Permission contract:** Every member consents to accepted roster, responsibility and payout split; leader cannot change beneficiary allocation without affected accepted amendment.

**State/effect contract:** Atomic reservation of all members; accepted roster snapshots survive profile edits; replacement/closure/handoff use canonical locks and consent.

**Required adverse evidence:** Busy member aborts all; unauthorized split edit; operator aliases; shared same-engagement operator reservation; partial asset/member settlement; member replacement.

### E17 — Selection and prize Challenges

**Affected canonical records:** challenges, challenge_entries, judge_assignments, judging_scores, award_allocations, engagements, terms_versions.

**Permission contract:** Mode, judging rubric, compensation/rights and conflicts disclosed; judge cannot decide own submission; winner separately accepts main funded work.

**State/effect contract:** APPLICATIONS_OPEN/BUILDING/JUDGING/DECIDED/CLOSED do not equal main work; handoff atomically transfers current capacity and preserves source compensation.

**Required adverse evidence:** Nonwinner not branded unreliable; changed weights denied; maximum prototype+prize liability funded; winner declines; handoff race; target binding fails; nonwinner private-code rights.

### E18 — Sponsored placement and auctions

**Affected canonical records:** promotion_inventory, promotion_orders, promotion_bids, promotion_delivery, ledger_entries, assets.

**Permission contract:** Sponsor buys disclosed visibility only; organic trust/skills/judging unaffected; later bid policy requires owner decision and funded inventory authority.

**State/effect contract:** Funded order/reservation → delivered attributable placement → charged/reconciled result; losing/undelivered capacity released/refunded per accepted terms.

**Required adverse evidence:** Missing Sponsored label; unfunded reservation; losing bid; duplicate billing; placement cannot be delivered; delivery/refund reconciliation; paid trust manipulation.

### E19 — Managed AI runtime and economics

**Affected canonical records:** agent_profiles, participants, agent_runs, run_tool_calls, budget_reservations, usage_ledger, operator_commitments.

**Permission contract:** Policy-enforcing service validates scoped tools/grants/budget outside the model; no self-review, withdrawal, autonomous permission escalation or spend increase.

**State/effect contract:** PLANNED/BUDGET_RESERVED/QUEUED/RUNNING/SUBMITTED with cancellation/failure; run state separate from work/review/billing; total retries/subagents respect common budget.

**Required adverse evidence:** Prompt injection; private egress; model/config alias identity; operator conflict; spend cap across retries; unused budget refund; failed cancellation cannot strand capacity.

### E20 — Influencer evidence and publication

**Affected canonical records:** Identity links, approved channel resources, submissions, semantic publication operations, provider receipts, metric evidence.

**Permission contract:** Verified channel controller and content approver explicitly authorize external publication; manual evidence and automated publication capabilities are distinguished.

**State/effect contract:** Draft/content approval/version → authorized publish intent → provider observed receipt → attributable metrics; unknown timeout reconciles before retry; takedown policy explicit.

**Required adverse evidence:** Timeout after provider success; duplicate publish; changed draft after approval; unsupported current API; fabricated metrics; channel ownership loss; own output acceptance.

### E21 — Reputation, Roles and optional token economy

**Affected canonical records:** reputation_events, reputation_projections, guild_relationships, engagement/Role periods, assets, budget and configuration records.

**Permission contract:** Rank/reliability/Guild Trust separate; score policy corrections attributable; license/tokenomics/organization scaling remain conditional until owner decisions.

**State/effect contract:** Active Role duty consumes canonical capacity; renewal/amendment and closure preserve claims; token availability cannot create rank or extra work slots.

**Required adverse evidence:** Reciprocal farming; changed scoring confidence; reversed appeal; ongoing second job under Role title; paid license masquerading as qualification; treasury budgets conflated.

### E22 — Representative UAT and business acceptance

**Affected canonical records:** U001–U016 scenario packets, real candidate data, defect/evidence/retest/sign-off records.

**Permission contract:** Named representative tester executes; independent business reviewer signs actual enabled-scope result; developer cannot create a fictitious approval.

**State/effect contract:** Not started → readiness → execution → observed pass/fail → retest → sign-off; failed critical journey blocks dependent stage; QA and release gate stay separate.

**Required adverse evidence:** All 16 screen contracts; loading/empty/stale/denied states; keyboard/mobile; exact amount and rejected signature; no private leakage; unfinished prerequisite or unresolved gate.

### E23 — Whole-product traceability

**Affected canonical records:** All 42 system boundaries, 219 subsections, R/P/D/I/AC/O/G groups, native epics/children and evidence register.

**Permission contract:** Product owner controls recorded policy; domain owners implement bounded contracts; independent reviewers verify evidence; no agent may manufacture approvals.

**State/effect contract:** Track actual NOT_STARTED/IN_PROGRESS/IMPLEMENTED_UNVERIFIED/VERIFIED_IN_TEST/PILOT_ENABLED/PRODUCTION_ENABLED evidence; project fields are planning until proven.

**Required adverse evidence:** Missing subsection/requirement owner; closed child with no evidence; removed criterion; weaker assertion; unresolved production gate; claimed complete product with unimplemented domain.

## Mandatory test-driven development

Every implementation issue follows RED → GREEN → REFACTOR for each changed behavior. Define the canonical expected result and write the meaningful test before implementation. RED records the test command, exact failure, baseline SHA and why it fails for the intended reason. GREEN records the same test passing after the bounded implementation. REFACTOR records relevant regression results after cleanup. Use actual database/program boundaries for material concurrency and financial behavior; an in-memory substitute cannot prove them.

Tests are reviewed against requirements independently of the implementation. Do not weaken assertions, omit adverse cases, delete a failing test, increase time/budget limits or change the expected policy just to obtain green. Existing passing behavior needs a recorded baseline; changed or missing behavior needs its own genuine red test. Every defect fix starts with a reproducing failing regression test. Emergency live containment remains subject to authorized incident procedures; it does not excuse an untested permanent fix.

The completion report for every Task requires a `tdd` object containing `red`, `green` and `refactor` records. RED needs `command`, `sha`, `evidence_url`, `expected_failure`, `observed_failure` and `result: FAIL`. GREEN and REFACTOR need `command`, `sha`, `evidence_url`, `observed` and `result: PASS`. An implementation report missing any phase is rejected. Acceptance criteria for decision/docs/UAT-only work are defined before execution; a coding cycle is not invented for a non-code deliverable. If a Task has no implementation change, supply `tdd.non_code_rationale`, independent `tdd.reviewer` and `tdd.acceptance_defined_before_execution`; the reviewer must verify this boundary.

## New owner-required system criteria

- **02.5 — Accepted owner changes:** [decision register](../RAID_AGENT_BLUEPRINT.md#025-accepted-owner-changes--6-october-2026) records TDD and replaceable/reusable features; source requirements and existing accepted work remain protected.
- **24.6 — Replaceable integrations:** [adapter contract](../RAID_AGENT_BLUEPRINT.md#246-replaceable-integration-contract) and task criterion C20 require stable ports, capability/typed-error contract tests, pinned in-flight effects and safe switch/recovery evidence.
- **24.7 — Owned feature reuse:** [module contract](../RAID_AGENT_BLUEPRINT.md#247-reusable-module-and-documentation-contract) and criterion C21 require documented independently consumable features, including authentication. Use [the complete feature/provider matrix](raid-module-reuse.md).

The dedicated `planning-contracts` CI job runs the requirement/packet and completion-validator tests. It detects stale blueprint hashes and missing mandatory criteria and validates rejection of malformed/incomplete/self-reviewed/TDD evidence packets. It does not inspect the truth of remote evidence or remove GitHub user permissions.

## C22 — Required CI evidence

Every issue includes its feature test layers and named CI checks. Wire actual new tests into discovery and record candidate SHA, check results, artifacts, executed/skipped counts and remaining gaps. Read [the CI matrix and automatic status guide](raid-ci-plan.md). Missing or skipped applicable checks prevent valid completion; broad suite success cannot substitute for absent feature tests.
