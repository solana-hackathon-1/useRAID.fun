# RAID development and testing phases

[Two-week sprint and alpha/beta plan](raid-sprint-plan.md) · [Timeline and delivery assumptions](raid-delivery-timeline.md) · [Complete requirement and acceptance coverage](raid-delivery-coverage.md) · [Canonical blueprint](../RAID_AGENT_BLUEPRINT.md)

**Prepared:** 6 October 2026. **Status:** proposed delivery schedule; phase completion requires evidence. **Canonical milestone IDs:** M0–M8 from blueprint section 34. Roles AG01–AG10 refer to section 33 responsibilities, not ten required hires or active agents. D1–D80 are working days from the illustrative 7 October kickoff, excluding weekends only. Each phase includes development and testing; test windows overlap development deliberately.

The user outcome for this document set is a complete, accelerated, GitHub-readable implementation plan. It maps blueprint sections 33–35 and 39–40 to tasks and evidence without changing LOCKED requirements, DEFAULT policy, OPEN decisions, authority, or production state. Existing paths below are inspection/reuse targets, not proof they satisfy the new domain. New modules require a contract decision; do not duplicate legacy money or identity services.

- [M0 — Contract and foundation](#m0-contract-and-foundation)
- [M1 — Identity, Guilds, skills and discovery](#m1-identity-guilds-skills-and-discovery)
- [M2 — Public work lifecycle and one active engagement](#m2-public-work-lifecycle-and-one-active-engagement)
- [M3 — Selected launch route and verified Guild linkage](#m3-selected-launch-route-and-verified-guild-linkage)
- [M4 — Verified funding, escrow, settlement and disputes](#m4-verified-funding-escrow-settlement-and-disputes)
- [M5 — Alpha, closed beta and controlled first release](#m5-alpha-closed-beta-and-controlled-first-release)
- [M6 — Private trust, Parties, selection Challenges and fixed sponsorship](#m6-private-trust-parties-selection-challenges-and-fixed-sponsorship)
- [M7 — Managed AI execution and bounded recommendations](#m7-managed-ai-execution-and-bounded-recommendations)
- [M8 — Advanced Guild economy and feature release gates](#m8-advanced-guild-economy-and-feature-release-gates)

## M0 Contract and foundation

| Phase contract              | Plan                                                                  |
| --------------------------- | --------------------------------------------------------------------- |
| Window                      | D1–D2 (2026-10-07 to 2026-10-08)                                      |
| Development                 | D1–D2                                                                 |
| Testing and review          | D2; regression checks begin with the first implemented behavior       |
| Dependency                  | Canonical blueprint and inspected repository; no earlier milestone.   |
| Accountable roles           | AG01 / AG03 / AG10; AG08 validates                                    |
| Blueprint reading           | Sections 00–04, 24–29, 33–34, 37–41                                   |
| Requirements and invariants | R01–R14; P01–P08; D01–D13; I01–I12 (contract mapping)                 |
| Acceptance evidence         | AC69, AC72; see the exact scenario list in the coverage document      |
| OPEN dependencies           | All O01–O19 get owners; dependent choices remain OPEN until recorded. |

**Entities and contracts:** Canonical participant, Guild, terms version, engagement, command receipt, asset identity, migration/status record.

**Permissions:** Freeze field and command ownership; distinguish product authority, reviewer authority, treasury authority, and runtime credentials.

**State transitions:** Agree separate identity, work, funding, access, dispute, and transaction state machines before changing persisted contracts.

**Repository mapping:** `prisma/schema.prisma`, `prisma/migrations/`, `src/lib/types.ts`, `src/lib/domain.ts`, `src/lib/states.ts`, `src/lib/validation.ts`, `src/lib/config.ts`, `tests/`, `.github/workflows/checks.yml`.

### Development work

- [ ] Inventory existing models, routes, workers, tests, feature flags, and legacy obligations. Mark reuse, extension, and missing contracts with evidence.
- [ ] Define canonical participant/Guild identifiers, immutable terms, exact asset/amount shapes, command errors, API versioning, and stable lock order. Existing attention campaigns must retain their accepted rule versions.
- [ ] Prepare additive migrations, compatibility/backfill and rollback plans; freeze shared contracts for independent UI, domain, and treasury work.
- [ ] Assign O01–O19 decision owners and feature-specific deadlines. Prepare the smallest supported launch/payment options; do not select economics from examples.
- [ ] Create one bounded task packet per feature using blueprint section 40; initialize the evidence/status register and risk list.

### Testing work

- [ ] Trace all requirements, invariants, decisions, gates, and acceptance scenarios to milestones using the coverage document.
- [ ] Run existing documentation/static checks to establish a baseline; validate contract fixtures and different-payload idempotency conflicts.
- [ ] Review accepted-term mutation and migration compatibility; classify pre-existing failures separately from new failures.

### Exit and handoff

Signed-off contract map, baseline evidence, migration approach, staffed responsibilities, and OPEN-decision queue. No implementation or live readiness claim.

Attach the commit SHA, environment/network, scenario IDs, actual result, outstanding defects/OPEN items, migration/rollback notes, and next bounded task using blueprint section 40. No unchecked item is completion evidence.

## M1 Identity, Guilds, skills and discovery

| Phase contract              | Plan                                                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Window                      | D3–D10 (2026-10-09 to 2026-10-20)                                                                                                                       |
| Development                 | D3–D8                                                                                                                                                   |
| Testing and review          | D6–D10; regression checks begin with the first implemented behavior                                                                                     |
| Dependency                  | M0 shared identity, authorization, terms, and API contracts.                                                                                            |
| Accountable roles           | AG03 / AG05 / AG02; AG08 validates                                                                                                                      |
| Blueprint reading           | Sections 05–10, 13, 18, 23, 25–28, 35.1                                                                                                                 |
| Requirements and invariants | R01–R04, R06, R08, R10–R12; P01, P07; D02, D07–D08, D13; I06–I07, I10–I12                                                                               |
| Acceptance evidence         | AC01–AC08, AC42–AC43; see the exact scenario list in the coverage document                                                                              |
| OPEN dependencies           | O09 automatic score thresholds deferred; O11 identity/privacy retention; O12 operating terms; O18 staging configuration. AC71 full flow finishes in M5. |

**Entities and contracts:** Account, wallet link, participant, Guild, founder/delegate, recognized token, holder observation, skill claim/assessment, reputation event.

**Permissions:** Wallet control authenticates an account; token ownership grants holder eligibility only. Manual assessors verify relevant skills; private resource authority remains separate.

**State transitions:** Guild draft → verified existing-project relationship; holder observation fresh/stale/unknown; skill claimed → reviewed → verified. Wallet changes preserve capacity/history.

**Repository mapping:** `src/lib/auth.ts`, `src/lib/wallet-auth.ts`, `src/lib/account-merge.ts`, `src/lib/admins.ts`, `src/lib/token-identity.ts`, `src/lib/data.ts`, `src/app/`, `src/components/`, `prisma/schema.prisma`.

### Development work

- [ ] Extend existing account/wallet authentication to a canonical human Raider identity; preserve history and outstanding claims during recovery/linking.
- [ ] Add Guild profiles, founder/delegate permissions, unique recognized-token linkage, verified existing-project attestation, holder balance freshness, and opt-in public association.
- [ ] Build orientation, claimed/verified skill records, relevant manual assessment and trial rubrics; allow experienced entrants to prove a skill directly.
- [ ] Implement safe Guild/participant projections, basic homepage/feed filters and honest NEW/no-history displays; add starter-task discovery.
- [ ] Create separate Raider reliability, Guild reliability and Guild Trust records; do not reuse attention scores as capability ranks.

### Testing work

- [ ] Replay/wrong-domain/expired challenge, conflicting wallet links, account merge with capacity, and founder/holder permission denial.
- [ ] Relevant-skill admission, token balance cannot buy rank, beginner orientation without fabricated verification, and RPC outage leaves unknown eligibility.
- [ ] Cross-Guild/private payload checks on HTML, metadata and APIs; mobile/keyboard onboarding, empty and retry states.

### Exit and handoff

Verified existing-project identity and public Guild/profile flow in staging; no holder-admin shortcut; relevant assessment and identity tests pass.

Attach the commit SHA, environment/network, scenario IDs, actual result, outstanding defects/OPEN items, migration/rollback notes, and next bounded task using blueprint section 40. No unchecked item is completion evidence.

## M2 Public work lifecycle and one active engagement

| Phase contract              | Plan                                                                                                                 |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Window                      | D11–D20 (2026-10-21 to 2026-11-03)                                                                                   |
| Development                 | D11–D18                                                                                                              |
| Testing and review          | D13–D20; regression checks begin with the first implemented behavior                                                 |
| Dependency                  | M1 identity/Guild/skill contracts; test-only funding adapter until M4.                                               |
| Accountable roles           | AG03 / AG02 / AG05; AG08 validates                                                                                   |
| Blueprint reading           | Sections 08–13, 16–17, 18, 23–29, 35.2                                                                               |
| Requirements and invariants | R04–R08, R11–R13; P07–P08; D03–D09; I01, I05–I11                                                                     |
| Acceptance evidence         | AC11–AC12, AC17–AC25, AC69–AC70, AC72; see the exact scenario list in the coverage document                          |
| OPEN dependencies           | O05–O08 unresolved payment choices cannot be bypassed; O09 numeric calibration is not needed for the bounded rubric. |

**Entities and contracts:** Raid listing, difficulty/skill predicates, application, offer, execution slot, immutable terms, engagement, active commitment, submission, review, deadline, outbox/inbox.

**Permissions:** Founder publishes/offers; Raider accepts; authorized reviewer decides on a specific submission. Every path calls the same transactional acceptance command.

**State transitions:** Draft → published → offered → ACCESS_PENDING → IN_PROGRESS → submitted/revision → terminal. Review duties retain capacity; terminal work releases capacity independently of unpaid claims.

**Repository mapping:** `src/app/api/raids/`, `src/lib/campaigns.ts`, `src/lib/tracking.ts`, `src/lib/states.ts`, `src/lib/queue.ts`, `src/lib/worker-jobs.ts`, `src/worker.ts`, `src/app/creator/`, `src/app/raids/`, `tests/standalone-db.test.ts`, `prisma/migrations/`.

### Development work

- [ ] Add outcome/criteria/reward/visibility/admission terms and bounded explainable recommendation rubric. Every published work Raid has E–S difficulty and structured skills.
- [ ] Implement safe cards, filters, eligibility explanations, applications/offers, stale application cleanup, and a versioned create-Raid wizard.
- [ ] Create database-enforced one-active commitment per canonical participant and single-slot vacancy, stable lock order, idempotent receipt and outbox. Do not treat legacy campaign enrollment as proof of this contract.
- [ ] Build terms acceptance, versioned artifact submission, criterion-level review, revision and withdrawal paths, finite deadlines, consented amendments, and payment-independent closure.
- [ ] Implement current-generation checks for setup/start/closure workers, notifications with safe previews, and My Raid/founder/review workspaces. Label every synthetic financial state.

### Testing work

- [ ] Synchronize competing accepts against real PostgreSQL; assert one success, one business effect, no orphan rows, no double-filled slot.
- [ ] Race stale offers/cleanup, closure/new job, submission/review and reopened terminal work; reject unilateral accepted-term changes.
- [ ] Run beginner and assessed-Raider journeys through review; preserve form drafts after wallet rejection; inspect public/private projections.

### Exit and handoff

Complete simulated public commissioned-work loop, meaningful database concurrency evidence, bounded closure, immutable terms, and accessible workspace. Prototype only.

Attach the commit SHA, environment/network, scenario IDs, actual result, outstanding defects/OPEN items, migration/rollback notes, and next bounded task using blueprint section 40. No unchecked item is completion evidence.

## M3 Selected launch route and verified Guild linkage

| Phase contract              | Plan                                                                                                              |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Window                      | D11–D25 (2026-10-21 to 2026-11-10)                                                                                |
| Development                 | D11–D22                                                                                                           |
| Testing and review          | D20–D25; regression checks begin with the first implemented behavior                                              |
| Dependency                  | M1 identity/Guild contracts; O01/O02 selected by D10. Runs beside M2 without modifying its shared contracts.      |
| Accountable roles           | AG04 / AG02 / AG09; AG08 validates                                                                                |
| Blueprint reading           | Sections 05–07, 16, 22–30, 35.3, 35.6                                                                             |
| Requirements and invariants | R01–R03; D11–D12; I03, I05, I09–I12                                                                               |
| Acceptance evidence         | AC26–AC27, AC29, AC41, AC67, AC69; see the exact scenario list in the coverage document                           |
| OPEN dependencies           | O01/O02 due D10; launch fee branch of O08 and O12/O18 before live launch. Custom route work changes the estimate. |

**Entities and contracts:** Launch intent, provider quote, signer authority, transaction attempt/receipt, canonical mint/program/network, Guild token relationship.

**Permissions:** Founder explicitly reviews and signs selected actions; provider/chain evidence verifies output. Existing pump.fun code is a candidate adapter, not an approved launch mechanism.

**State transitions:** Draft → ready for signature → submitted → observed → verified LIVE; action required, expired, failed and cancelled paths retain history.

**Repository mapping:** `src/lib/pump-sdk.ts`, `src/lib/launch-signatures.ts`, `src/lib/launch-ipfs.ts`, `src/lib/launch-crypto.ts`, `src/lib/launch-rotation.ts`, `src/lib/release.ts`, `src/app/launch/`, `src/app/api/`, `tests/launch-db.test.ts`.

### Development work

- [ ] Record the selected route, supported parameters, versions, program/network identities, token controls, fee destinations and authorities.
- [ ] Wrap reusable launch infrastructure in validate/quote/prepare/verify/reconcile contracts; remove assumptions about default economics from the selected path.
- [ ] Build review/sign/status UX with rejection, expiry, partial completion, provider outage and resume for the same semantic intent.
- [ ] Independently verify resulting mint, authorities and launch artifacts, then activate the correct Guild linkage; separate existing-token verification from a new launch.
- [ ] Keep the current hard launch gate closed outside the reviewed test path; document real enablement and recovery requirements.

### Testing work

- [ ] Adapter and test-network launch, verified signer/account identities, wrong mint/network, quote expiry, signature rejection and missing finality.
- [ ] Crash after broadcast, resume after expiry, partial multi-step launch, repeated callbacks and late observed success without duplicate creation.
- [ ] Guild linkage and transaction-review mobile/keyboard checks. AC66 full launch-to-payout proof belongs to M5.

### Exit and handoff

One supported launch route tested through verified artifacts and recovery on its selected test network. Production G01 remains a separate evidence gate.

Attach the commit SHA, environment/network, scenario IDs, actual result, outstanding defects/OPEN items, migration/rollback notes, and next bounded task using blueprint section 40. No unchecked item is completion evidence.

## M4 Verified funding, escrow, settlement and disputes

| Phase contract              | Plan                                                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Window                      | D21–D30 (2026-11-04 to 2026-11-17)                                                                                             |
| Development                 | D21–D27                                                                                                                        |
| Testing and review          | D23–D30; regression checks begin with the first implemented behavior                                                           |
| Dependency                  | M2 exits D20; real funding integration starts D21. O05–O08 decided by D10.                                                     |
| Accountable roles           | AG04 / AG03 / AG09; AG08 validates                                                                                             |
| Blueprint reading           | Sections 13–17, 22, 25–30, 32, 35.3, 35.6                                                                                      |
| Requirements and invariants | R13; P05; D03, D06, D11–D13; I01–I05, I08–I12                                                                                  |
| Acceptance evidence         | AC18, AC20, AC26–AC41, AC49, AC67–AC69, AC72; see the exact scenario list in the coverage document                             |
| OPEN dependencies           | O05–O08 due D10; O11/O12 operating decisions; O18 durability/provider configuration. Unsupported extra assets remain disabled. |

**Entities and contracts:** Asset registry/policy snapshot, escrow agreement, vault, per-slot reservation/binding, immutable allocation/claim, transaction attempt, dispute/appeal, audit/reconciliation incident.

**Permissions:** Separate funder, bound beneficiary, acceptance reviewer, mediator, fee and upgrade authorities. No generic admin/model withdrawal; no post-binding unilateral founder refund.

**State transitions:** Funding pending → finalized verified; commitment binding pending → verified; allocation → appealable/held → claimable → submitted → finalized/blocked. Work closure remains separate.

**Repository mapping:** `src/lib/raid-funding.ts`, `src/lib/raid-allocation.ts`, `src/lib/studio-finance.ts`, `src/lib/usdc-amount.ts`, `src/lib/usdc-chain.ts`, `src/lib/usdc-reconcile.ts`, `src/lib/rewards.ts`, `src/lib/worker-jobs.ts`, `tests/usdc-ops-db.test.ts`, `tests/money-integrity-db.test.ts`, `prisma/migrations/`.

### Development work

- [ ] Choose a reviewed settlement provider/program; compare existing custody/manual-withdrawal flows to the blueprint escrow authority requirements before reuse.
- [ ] Model multi-asset obligations from the start; enable one approved asset initially. Validate integer limits, network/mint/program, decimals/extensions, fee/rent payer and net reward.
- [ ] Protect individual slot obligations, finalize verified funding, bind exact accepted terms/beneficiaries before start, and serialize refund/commit paths.
- [ ] Implement authorized acceptance/dispute/appeal finality, claim holds, constrained partial allocation and beneficiary recovery with notice/deadline evidence.
- [ ] Persist semantic operation IDs across transaction attempts, reconcile timeouts/late binding and partial payouts, expose honest blocked/unknown/paid labels.
- [ ] Deliver vault/ledger reconciliation, incident pause controls and immutable audit. Review program/provider guarantees independently of application tests.

### Testing work

- [ ] Per-asset conservation properties, overflow/precision/rounding, same-symbol and wrong-network rejection, partial bundle funding and registry-version identity.
- [ ] Real selected mechanism tests for commitment/refund and hold/claim races, signer/account validation, duplicate semantic claims, expiry and close/reinitialize replay.
- [ ] Crash after external success, late binding after local closure, frozen token, changed beneficiary, restricted account with unpaid claim and partial recipient failure.
- [ ] Confirm existing paid obligations survive migration and a restored database cannot duplicate external effects.

### Exit and handoff

Chosen mechanism and backend agree on funding/binding/claims/refunds/finality and recovery. Selected assets pass G02–G04 evidence; unresolved assurance blocks live money.

Attach the commit SHA, environment/network, scenario IDs, actual result, outstanding defects/OPEN items, migration/rollback notes, and next bounded task using blueprint section 40. No unchecked item is completion evidence.

## M5 Alpha, closed beta and controlled first release

| Phase contract              | Plan                                                                                                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Window                      | D31–D50 (2026-11-18 to 2026-12-15)                                                                                                                       |
| Development                 | D31–D35 alpha fixes; D41–D45 beta fixes                                                                                                                  |
| Testing and review          | D31–D40 alpha; D41–D50 closed beta; regression checks begin with the first implemented behavior                                                          |
| Dependency                  | M1–M4 exit evidence and G01–G05/G10 for the selected live operating model. Existing-project work pilot can precede M3 only with an accurate pilot label. |
| Accountable roles           | AG09 / AG01 / AG02 / AG05; AG08 owns release evidence                                                                                                    |
| Blueprint reading           | Sections 05–13, 16–18, 23–32, 34–40                                                                                                                      |
| Requirements and invariants | R01–R08, R10–R13; P07–P08; D01–D09, D11–D13; I01–I12                                                                                                     |
| Acceptance evidence         | AC01–AC12, AC17–AC49, AC66–AC72 (relevant public release paths); see the exact scenario list in the coverage document                                    |
| OPEN dependencies           | O08/O11/O12/O18 and mediator/support decisions resolved before public paid operation; unresolved feature gates cannot be waived for D50.                 |

**Entities and contracts:** Release manifest, assessments, attributable work/reputation history, operator cases, alerts, backup recovery watermark, user support and metrics.

**Permissions:** Project owner enables only evidenced capabilities; staffed treasury, mediator, support and release responsibilities remain distinct.

**State transitions:** Verified staging → constrained pilot → enabled approved release. A deployment does not make a financial gate pass.

**Repository mapping:** `docs/operations.md`, `docs/verification.md`, `src/lib/config.ts`, `src/lib/release.ts`, `src/app/admin/`, `src/worker.ts`, `.github/workflows/checks.yml`, `tests/browser-live/`, `tests/browser-studio/`.

### Development work

- [ ] Integrate founder/novice/experienced Raider paths: verified project → funded public task → one commitment → submission → accepted work → claim → honest history.
- [ ] Prove the separate selected-route launch → verified mint → Guild flow; retain manual relevant assessment and ordinary authorized review for V1.
- [ ] Implement audited reputation corrections and related-party review, useful completion/settlement metrics, safe notification preferences and accessible empty/error screens.
- [ ] Assign support/mediation/on-call hours, test alerts, define production flags and caps through recorded operating decisions, and repair the actual deployment path.
- [ ] Rehearse migrations, backup/restore with later external effects, incident pause/resume and code/data rollback; archive release evidence and known limitations.
- [ ] Sprint 4 (D31–D40): run internal alpha on synthetic/test-network assets; triage daily, repair core journeys and perform restore/incident rehearsals before inviting external testers.
- [ ] Sprint 5 (D41–D50): run invited closed beta only after alpha and applicable live gates pass; collect founder/Raider feedback, stabilize the same core flow, and document go/no-go for public beta.

### Testing work

- [ ] Run applicable M1–M4 scenarios end to end, including AC66 launch path and AC71 existing-project path as distinct journeys.
- [ ] Verify post-snapshot recovery of acknowledged terms, consents, capacity, receipts and grants; disable affected writes if authoritative recovery fails.
- [ ] Re-run required static/database/build/browser gates against the release SHA; manual keyboard/accessibility and supported-wallet retry checks.
- [ ] Complete selected live provider/fund validation only under the approved operating model and record amounts/network/authority without exposing secrets.
- [ ] Keep distinct alpha and closed-beta evidence records, tester cohorts, bug reproduction, fix/retest results and gate owners. Time passing does not automatically advance either stage.

### Exit and handoff

V1 only when required production gates and bounded live operation have evidence. Otherwise publish a Prototype/Pilot with disabled dependent features and a recovery/decision schedule.

Attach the commit SHA, environment/network, scenario IDs, actual result, outstanding defects/OPEN items, migration/rollback notes, and next bounded task using blueprint section 40. No unchecked item is completion evidence.

## M6 Private trust, Parties, selection Challenges and fixed sponsorship

| Phase contract              | Plan                                                                                                                  |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Window                      | D51–D60 (2026-12-16 to 2026-12-29)                                                                                    |
| Development                 | D51–D57                                                                                                               |
| Testing and review          | D54–D60 plus public beta; regression checks begin with the first implemented behavior                                 |
| Dependency                  | M5 core release contracts; O10/O13 and sponsorship portion of O08 before enablement. Subfeatures can ship separately. |
| Accountable roles           | AG05 / AG03 / AG07 / AG02 / AG04; AG08 validates                                                                      |
| Blueprint reading           | Sections 09–18, 23, 25–32, 35.2, 35.4–35.5                                                                            |
| Requirements and invariants | R09–R14; P02, P05; D03–D06, D10; I01–I11                                                                              |
| Acceptance evidence         | AC09–AC10, AC13–AC14, AC36, AC42–AC59, AC67–AC70, AC72; see the exact scenario list in the coverage document          |
| OPEN dependencies           | O10 rights/awards/finality, O13 provider scopes, promotion O08; O17 auctions still disabled until M8.                 |

**Entities and contracts:** Scoped resources/access grants, desired-state generations, Party roster/consent/splits, Challenge entries/rubrics/rights/handoff, promotion inventory/order/delivery/refund.

**Permissions:** Resource-specific grant approval, every member’s consent, conflict-aware judging, separate selection/main budgets, and sponsorship purchase rights.

**State transitions:** Private brief approved → exact funded acceptance/binding → resources ready; grant desired/effective/revoked reconciled. Party commitment all-or-none; selection → explicit main offer/acceptance; placement funded → delivered/refunded.

**Repository mapping:** `prisma/schema.prisma`, `prisma/migrations/`, `src/lib/queue.ts`, `src/worker.ts`, `src/lib/discovery-rows.ts`, `src/app/`, `src/components/`, `src/app/api/`; new access/Party/Challenge/promotion modules after M0 contract approval.

### Development work

- [ ] Deliver private teasers/briefs, limited isolated repositories/workspaces, exact grant scope, secret expiry and effective-access revocation with overlapping grants.
- [ ] Add Party builder, member roles/skill coverage, per-asset exact split and individual consent snapshots; support atomic replacement and dispute evidence.
- [ ] Implement paid bounded SELECTION Challenges, entry admission, frozen rubric/rights, qualification separate from winning, funded maximum liability and independent stipends.
- [ ] Implement explicit, separately funded main-Raid offer and atomic participant/operator handoff; failed target setup preserves source compensation.
- [ ] Sell labeled fixed-duration inventory with published delivery/refund terms; deduplicate honest delivery metrics and separate ranking from payment.

### Testing work

- [ ] Cross-Guild leak sweep including cache/search/metadata/logs; overlapping grant removal, stale provider success, failed revoke and malicious artifact isolation.
- [ ] Party busy-member rollback, consent/split amendment denial, partial claims and selection-to-main race with normal acceptance.
- [ ] Nonwinner rights/payment, changed judging weights, declined main offer and failed binding after handoff; no automatic negative reliability.
- [ ] Sponsored labeling, inventory exhaustion, invalid listing while active, payment replay and delivery failure/refund.

### Exit and handoff

V1.5 feature-by-feature with G06 for confidential resources and G09 for promotions; selection compensation and handoff, Parties and scopes proven.

Attach the commit SHA, environment/network, scenario IDs, actual result, outstanding defects/OPEN items, migration/rollback notes, and next bounded task using blueprint section 40. No unchecked item is completion evidence.

## M7 Managed AI execution and bounded recommendations

| Phase contract              | Plan                                                                                                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Window                      | D61–D70 (2026-12-30 to 2027-01-12)                                                                                                                                      |
| Development                 | D61–D67                                                                                                                                                                 |
| Testing and review          | D64–D70 plus public beta; regression checks begin with the first implemented behavior                                                                                   |
| Dependency                  | M5 work/settlement and relevant M6 access/Party contracts; O14 provider/data/cost policy. Pilot uses blueprint individual-operator default.                             |
| Accountable roles           | AG06 / AG03 / AG04 / AG05 / AG02; AG08 validates                                                                                                                        |
| Blueprint reading           | Sections 07–08, 13–14, 19–20, 23–32, 35.2, 35.5                                                                                                                         |
| Requirements and invariants | R06–R07, R11–R13; P01, P08; D07, D09; I01–I12                                                                                                                           |
| Acceptance evidence         | AC15–AC16, AC48, AC61–AC64, AC67–AC70; see the exact scenario list in the coverage document                                                                             |
| OPEN dependencies           | O14 before D61; O15 before organization scaling (individual pilot default can proceed); AI charging/refund part of O08. O16 automatic social publication remains gated. |

**Entities and contracts:** Registered AI participant/operator, evaluated configuration, tool grant, budget account/rate card, run, artifact, callback receipt, operator capacity.

**Permissions:** Operator consents for registered worker; short-lived task credentials; runner permits tools. Model cannot grant permissions, extend budget, approve its work or collect its own reward.

**State transitions:** Planned → budget reserved → queued → running → submitted; pause/cancel/failure reconcile external effects and end or recover duties finitely.

**Repository mapping:** `src/lib/queue.ts`, `src/lib/worker-jobs.ts`, `src/worker.ts`, `src/lib/config.ts`, `prisma/schema.prisma`, `src/app/api/`; new runtime/operator/budget adapters and isolated runner deployment are required.

### Development work

- [ ] Register accountable operators/workers with benchmark evidence, immutable evaluated configuration history, participant identity and authenticated callbacks.
- [ ] Enforce participant and aggregate operator reservations transactionally, including the pilot operator’s human engagement and same-engagement Party members.
- [ ] Deploy an isolated run environment with network/filesystem/tool restrictions, short-lived grants, artifact validation and provider data-handling policy.
- [ ] Reserve a total execution cap across retries/subcalls, account for actual/estimated costs separately from contributor reward, and implement stop/cancel/heartbeat recovery.
- [ ] Add bounded AI-assisted recommendations/routing with explicit uncertainty, human/Party fallback and ordinary acceptance/review; retain low-risk manual influencer evidence.

### Testing work

- [ ] Competing aliases/human/AI jobs, same-Party operator sharing, model swap preserves history/capacity, forged callback and self-approval rejection.
- [ ] Prompt injection, secret exfiltration, unauthorized network/tool calls and private-code provider denial in the actual isolation boundary.
- [ ] Total budget exhaustion across retries, cancellation during an external action, lost heartbeat, context/provider failure and finite orphan-engagement closure.

### Exit and handoff

One allowed managed task reaches ordinary review under verified limits with G07 evidence. No claim that a model name determines rank.

Attach the commit SHA, environment/network, scenario IDs, actual result, outstanding defects/OPEN items, migration/rollback notes, and next bounded task using blueprint section 40. No unchecked item is completion evidence.

## M8 Advanced Guild economy and feature release gates

| Phase contract              | Plan                                                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Window                      | D71–D80 (2027-01-13 to 2027-01-26)                                                                                                                            |
| Development                 | D71–D77                                                                                                                                                       |
| Testing and review          | D74–D80 plus public beta; regression checks begin with the first implemented behavior                                                                         |
| Dependency                  | Corresponding M6/M7 contracts and O03/O04/O09/O10/O15–O17/O19 decisions for each affected feature. Independent modules do not share an automatic launch date. |
| Accountable roles           | AG03 / AG07 / AG06 / AG04 / AG05 / AG09; AG08 validates                                                                                                       |
| Blueprint reading           | Sections 08–09, 15–22, 23–32, 35.5–35.6, 38–40                                                                                                                |
| Requirements and invariants | R06, R09–R10, R13–R14; P01, P03–P06; D02, D10–D13; I01–I12                                                                                                    |
| Acceptance evidence         | AC04, AC09–AC10, AC28–AC41, AC50–AC65, AC67–AC72; see the exact scenario list in the coverage document                                                        |
| OPEN dependencies           | O03/O04/O09/O10/O15/O16/O17/O19 per feature; O08 pricing and O06 finality apply to new award/bid/service paths.                                               |

**Entities and contracts:** Prize award, bid/reservation/auction, approved channel/content/publication, versioned scoring, funded Role period, optional utility/entitlement policy.

**Permissions:** Judges/mediators decide awards; purchase terms govern bids; verified account owner approves publication; Role renewal requires consent/funding. Token ownership cannot buy rank/access/extra capacity.

**State transitions:** Prize entries → judging → appeal/final award; auction reserved → winner charge/loser release → delivery/refund; approved content → confirmed publish; funded accepted Role period → renew/close.

**Repository mapping:** `src/lib/providers/x.ts`, `src/lib/tracking-domain.ts`, `src/lib/studio-attribution.ts`, `src/lib/rewards.ts`, `src/lib/config.ts`, `src/app/`, `prisma/schema.prisma`; new auctions/publishing/Role contracts after policy approval.

### Development work

- [ ] Add PRIZE mode with pre-funded maximum liability, qualification/stipends separate from prizes, tie/no-qualifier/cancellation policy, rights and appeal finality.
- [ ] Implement selected single-asset bidding mechanism with deterministic tie-break, maximum charge, losing-budget release and delivery reconciliation.
- [ ] Add approved influencer channel adapter: account control, exact content approval, scoped credentials, deduplicated publish/lookup, takedown and dated evidence/attribution caps.
- [ ] Calibrate versioned skill/reliability scoring against real evidence; retain appeal corrections, uncertainty, anti-gaming and newcomer fairness checks.
- [ ] Add funded consented Role periods and renewal/termination; maintain one-active rule. Prepare RAID utility/license interfaces only for explicitly chosen policies.
- [ ] Treat actual RAID-token issuance as a separate conditional release package: chosen supply/distribution/authorities/market mechanism and G01/G04/G05 evidence. It is not promised by D80.

### Testing work

- [ ] Prize maximum liability, tie/no qualifier, changed rubric, private nonwinner rights and contested award/claim race.
- [ ] Concurrent bids, same-price ties, invalid/expired funding, losing refunds, failed delivery and late auction-job replay.
- [ ] Publish timeout after success, approval text/media mismatch, revoked channel credentials, duplicate metrics, cost caps and takedown.
- [ ] Role renewal failure, existing active Raid conflict, appeal corrections and high-token balance cannot alter eligibility. Execute each added asset’s full M4 tests.

### Exit and handoff

Selected V2 capabilities enabled only with their individual gates; D80 review lists delivered modules and blocked optional modules separately. No unapproved tokenomics, organization scale or channel rights.

Attach the commit SHA, environment/network, scenario IDs, actual result, outstanding defects/OPEN items, migration/rollback notes, and next bounded task using blueprint section 40. No unchecked item is completion evidence.
