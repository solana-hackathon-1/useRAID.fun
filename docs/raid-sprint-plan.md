# RAID one-week sprints, alpha and beta plan

**Primary schedule: sixteen one-week sprints across 16 weeks.** Each sprint is five working days. Internal alpha uses S07–S08, closed beta uses S09–S10, and public beta begins in S11 only after the preceding gate passes. Weekly planning changes the review cadence; it does not remove required test time or change blueprint policy.

[Master timeline](raid-delivery-timeline.md) · [Phase development/testing checklists](raid-development-phases.md) · [Full requirement coverage](raid-delivery-coverage.md) · [GitHub backlog guide](raid-project-guide.md) · [Canonical blueprint](../RAID_AGENT_BLUEPRINT.md)

Prepared 6 October 2026. Dates assume an illustrative 7 October kickoff, four delivery contributors and Monday–Friday work only, with no holiday/leave adjustment. Re-estimate after the repository inventory and policy decisions. Actual token issuance, an optional license and unresolved provider/operator capabilities have a separate conditional backlog.

## Weekly sprint board

| Sprint                                                      | Dates                    | Phase    | One user outcome                                                                                                                               |
| ----------------------------------------------------------- | ------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| [S01](#s01-contract-and-canonical-identity-foundation)      | 2026-10-07 to 2026-10-13 | M0/M1    | Agree the shared contracts and preserve one canonical person across linked wallets.                                                            |
| [S02](#s02-verified-guilds-skills-and-public-discovery)     | 2026-10-14 to 2026-10-20 | M1       | Show verified project relationships and relevant skill evidence without granting token holders administration.                                 |
| [S03](#s03-work-terms-creation-and-atomic-acceptance)       | 2026-10-21 to 2026-10-27 | M2/M3    | A founder publishes clear work and a Raider can accept exactly one funded/simulated assignment; launch adapter preparation runs independently. |
| [S04](#s04-submission-review-and-synthetic-work-completion) | 2026-10-28 to 2026-11-03 | M2/M3    | A Raider submits evidence, receives bounded review, and closes the synthetic work loop with truthful state.                                    |
| [S05](#s05-verified-launch-and-protected-funding)           | 2026-11-04 to 2026-11-10 | M3/M4    | Verify the selected launch artifacts and protect exact per-asset work reserves on the selected test path.                                      |
| [S06](#s06-claims-disputes-and-financial-recovery)          | 2026-11-11 to 2026-11-17 | M4       | Prove authorized claims/refunds/finality and reconcile late/duplicate financial effects.                                                       |
| [S07](#s07-internal-alpha-core-journeys-and-usability)      | 2026-11-18 to 2026-11-24 | M5 alpha | Run the integrated core with internal fixtures; identify real journey and accessibility failures.                                              |
| [S08](#s08-internal-alpha-recovery-and-exit-review)         | 2026-11-25 to 2026-12-01 | M5 alpha | Retest fixes, rehearse restore/incidents, and decide if outside testers can enter.                                                             |
| [S09](#s09-closed-beta-invited-cohort-and-feedback)         | 2026-12-02 to 2026-12-08 | M5 beta  | Observe invited founder/newcomer/experienced Raider workflows under a staffed approved beta model.                                             |
| [S10](#s10-closed-beta-stabilization-and-v1-gate)           | 2026-12-09 to 2026-12-15 | M5 beta  | Resolve blockers and decide whether the stable core is ready for public beta.                                                                  |
| [S11](#s11-public-beta-and-scoped-private-work)             | 2026-12-16 to 2026-12-22 | M6       | Open the eligible core cohort conservatively and prove explicitly scoped confidential work.                                                    |
| [S12](#s12-parties-paid-selection-and-fixed-sponsorship)    | 2026-12-23 to 2026-12-29 | M6       | Introduce independent team/selection/placement slices with consent, funding and recovery evidence.                                             |
| [S13](#s13-managed-ai-identity-capacity-and-isolation)      | 2026-12-30 to 2027-01-05 | M7       | An accountable evaluated worker can be admitted under operator capacity and sandbox restrictions.                                              |
| [S14](#s14-managed-ai-capped-task-cancellation-and-pilot)   | 2027-01-06 to 2027-01-12 | M7       | One permitted capped run submits useful evidence for ordinary authorized review.                                                               |
| [S15](#s15-advanced-economy-prize-and-bid-modules)          | 2027-01-13 to 2027-01-19 | M8       | Implement only approved prize/auction/asset slices and prove liability, claim and delivery boundaries.                                         |
| [S16](#s16-approved-channels-roles-and-beta-exit)           | 2027-01-20 to 2027-01-26 | M8       | Verify selected channel/Role/scoring additions, repeat core beta evidence and record the release decision.                                     |

## Five-day sprint rhythm

| Day                       | Development sprint                                                                                           | Alpha/beta sprint                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Monday-equivalent / Day 1 | Agree one user outcome, ready tasks, dependencies, owner roles, contracts and test criteria.                 | Verify cohort/environment/support and stage-entry evidence; select the week’s journeys and defects.       |
| Days 2–3                  | Build small complete slices; test meaningful behavior as it lands; integrate independent reviewed contracts. | Observe scripted/exploratory journeys, collect sanitized feedback, reproduce issues and fix blockers.     |
| Day 4                     | Integrate server/UI/migrations, run adverse/recovery/accessibility checks and stabilize.                     | Retest fixes, inspect reconciliation/support incidents and run the planned recovery/adversarial evidence. |
| Day 5                     | Demo actual outcome, review test evidence, update status/forecast and choose next ready backlog.             | Review feedback/blockers, record continue/go/limited-go/no-go and hand off the next one-week test scope.  |

The illustrative kickoff is Wednesday, so sprint days here run Wednesday–Tuesday. If kickoff changes, rebase dates rather than pretending every sprint begins Monday. All tasks start in Backlog; a sprint assignment is a forecast, not a commitment or completion claim. The work exceeds some weekly capacities and must be sized after M0. Beta defects take priority over feature expansion.

## Weekly developer scope

## S01 Contract and canonical identity foundation

**Dates:** 2026-10-07 to 2026-10-13 (D1–D5). **Phase:** M0/M1.

Agree the shared contracts and preserve one canonical person across linked wallets.

- `T001` — Inventory existing behavior and protect legacy obligations. Know what can be reused and what is still missing before altering production contracts.
- `T002` — Freeze shared domain contracts and state ownership. Developers agree on the same IDs and boundaries before parallel implementation.
- `T003` — Plan additive migrations, backfills and rollback. Move existing data safely into new contracts without editing applied migrations.
- `T004` — Prepare realistic fixtures and evidence register. Every developer can reproduce important failure cases and record what really passed.
- `T005` — Repair baseline CI and choose the web/worker staging path. A normal change gets meaningful checks and deploys into the correct application environment.
- `T006` — Preserve canonical identity across verified wallet links. Changing a wallet or login method never gives another work slot or erases earned history.
- `T007` — Verify one-use wallet sign-in and account-link intent. A relayed or replayed signature cannot authenticate the wrong account or origin.

**Weekly exit:** demonstrate actual scenario results with SHA/environment/evidence, remaining blockers and the next bounded scope.

## S02 Verified Guilds, skills and public discovery

**Dates:** 2026-10-14 to 2026-10-20 (D6–D10). **Phase:** M1.

Show verified project relationships and relevant skill evidence without granting token holders administration.

- `T008` — Build beginner and experienced Raider onboarding. Newcomers understand commitments; experienced builders can prove relevant ability directly.
- `T009` — Create Guild profiles and scoped founder delegation. A verified project can administer its own workspace with explicit permissions.
- `T010` — Verify an existing project and its canonical token. Linking an existing mint is clearly labeled and requires proof of project authority.
- `T011` — Observe holder eligibility without permission shortcuts. Token holders see accurate membership freshness while private rights stay separately granted.
- `T012` — Add stable skill taxonomy and evidence records. A profile separates claimed ability from assessed relevant skill.
- `T013` — Deliver public trials and authorized assessment review. Builders can demonstrate skills with bounded fair exercises and explicit evidence.
- `T014` — Explain structured skill eligibility and anti-spam review. People understand why a task fits while risk signals do not become arbitrary punishment.
- `T015` — Build safe homepage, Guild directory and public profiles. A visitor understands RAID and sees only approved project/work information.
- `T078` — Independently verify identity, skills and fair admission. Prove identity, skills and fair admission against the actual boundary, with reproducible negative and recovery evidence.
- `T090` — Verify provider account ownership and privacy-safe recovery evidence. Linked GitHub/social credentials prove the specific account controlled, without pretending they prove unique humanity or skill.
- `T096` — Independently audit every blueprint subsection and board linkage. A new developer can locate concrete work for every blueprint section without guessing missing scope.

**Weekly exit:** demonstrate actual scenario results with SHA/environment/evidence, remaining blockers and the next bounded scope.

## S03 Work terms, creation and atomic acceptance

**Dates:** 2026-10-21 to 2026-10-27 (D11–D15). **Phase:** M2/M3.

A founder publishes clear work and a Raider can accept exactly one funded/simulated assignment; launch adapter preparation runs independently.

- `T016` — Define immutable Raid terms and publication checks. A published task says exactly what is required, rewarded and reviewed.
- `T017` — Build bounded difficulty and reward recommendations. Founders get useful advice while keeping control of assumptions and the final contract.
- `T018` — Create the founder Raid wizard and reward review. Founders can draft a clear task and understand all asset legs, net reward and fees.
- `T019` — Implement idempotent commands with audit and outbox. Retrying a business action cannot silently create duplicate work, claims or history.
- `T020` — Enforce atomic one-engagement capacity and slot vacancy. Two competing accepts cannot reserve the same Raider or work slot twice.
- `T021` — Route applications, offers and instant acceptance through one command. Every entry path checks current eligibility, terms, funds, consent and capacity.
- `T026` — Wrap the selected launch route behind a typed adapter. A founder follows one approved launch mechanism without silent protocol/fee switching.
- `T089` — Implement versioned API contracts and scoped command authorization. Web and service callers use one validated command model, rather than a second set of hidden state edits.

**Weekly exit:** demonstrate actual scenario results with SHA/environment/evidence, remaining blockers and the next bounded scope.

## S04 Submission, review and synthetic work completion

**Dates:** 2026-10-28 to 2026-11-03 (D16–D20). **Phase:** M2/M3.

A Raider submits evidence, receives bounded review, and closes the synthetic work loop with truthful state.

- `T022` — Deliver My Raid and founder applicant workspaces. Workers and founders can see the accepted contract, next action and truthful current state.
- `T023` — Accept versioned submissions and criterion-based review. A review always decides on a specific deliverable against agreed criteria.
- `T024` — Close work finitely while preserving claims and newer capacity. An abandoned review cannot trap a Raider or erase money still owed.
- `T025` — Support consented work amendments and member replacement contracts. Material changes require agreement rather than editing accepted promises.
- `T027` — Build exact launch review, signature and resume UX. A founder sees what they sign and can safely recover an interrupted launch.
- `T042` — Add safe lifecycle notifications and user preferences. People know the next required action without exposing private briefs in previews.
- `T079` — Independently verify canonical capacity and bounded work closure. Prove canonical capacity and bounded work closure against the actual boundary, with reproducible negative and recovery evidence.
- `T091` — Enforce web, upload, URL and integration security boundaries. Malicious inputs cannot expose secrets, trigger unauthorized network access or execute trusted code.
- `T095` — Deliver manual influencer identity, draft and publication-evidence workflow. Content participants can submit verifiable agreed work before automated social publishing is enabled.
- `T097` — Deliver funded discovery filters and comparable organic ordering. A Raider can find current permitted funded work by actual skill and reward fit without misleading asset values or paid credibility.

**Weekly exit:** demonstrate actual scenario results with SHA/environment/evidence, remaining blockers and the next bounded scope.

## S05 Verified launch and protected funding

**Dates:** 2026-11-04 to 2026-11-10 (D21–D25). **Phase:** M3/M4.

Verify the selected launch artifacts and protect exact per-asset work reserves on the selected test path.

- `T028` — Verify launch artifacts and activate the right Guild relationship. Launch success means the intended verified mint and authority facts exist.
- `T029` — Implement exact asset registry and bounded amount arithmetic. The reward amount identifies the actual asset and never loses precision.
- `T030` — Prove selected escrow authority and protocol capability. The payment mechanism protects committed rewards and constrains who may move them.
- `T031` — Verify deposits and reserve each promised obligation once. A client signature cannot invent funds or promise the same deposit to several workers.
- `T032` — Bind accepted terms before work and resource readiness. No commissioned work starts before verified funding binding and required resources.

**Weekly exit:** demonstrate actual scenario results with SHA/environment/evidence, remaining blockers and the next bounded scope.

## S06 Claims, disputes and financial recovery

**Dates:** 2026-11-11 to 2026-11-17 (D26–D30). **Phase:** M4.

Prove authorized claims/refunds/finality and reconcile late/duplicate financial effects.

- `T033` — Allocate immutable claims and reconcile payout retries. Each beneficiary and asset gets an exact claim that can settle once across new signatures.
- `T034` — Expose payment progress and ledger-vault incidents. People can see exactly what is owed, pending, blocked or actually paid.
- `T035` — Implement private disputes and snapshotted financial finality. A contested award cannot become claimable while its timely appeal is held.
- `T036` — Recover payout destination safely and preserve restricted claims. Wallet recovery and account restriction cannot confiscate an earned entitlement.
- `T037` — Validate environments, feature flags and audited configuration. Sample assets or missing authorities cannot accidentally enable real operations.
- `T038` — Deliver durable worker generations, retries and health signals. Late jobs and provider outages are recoverable without repeated external action.
- `T039` — Protect acknowledged authorizations outside the primary failure domain. A restore can recover original terms, consent and semantic IDs before writing again.
- `T080` — Independently verify funding, exact assets and settlement boundaries. Prove funding, exact assets and settlement boundaries against the actual boundary, with reproducible negative and recovery evidence.
- `T092` — Implement privacy, retention and account deletion without erasing obligations. Users can exercise the chosen privacy policy while required financial/access/work evidence remains recoverable and restricted.
- `T093` — Separate five budgets and exact billing/receipt obligations. Launch, contributor reward, platform fee, AI compute and promotion funds are never silently spent on each other.

**Weekly exit:** demonstrate actual scenario results with SHA/environment/evidence, remaining blockers and the next bounded scope.

## S07 Internal alpha: core journeys and usability

**Dates:** 2026-11-18 to 2026-11-24 (D31–D35). **Phase:** M5 alpha.

Run the integrated core with internal fixtures; identify real journey and accessibility failures.

- `T040` — Publish incident, migration and staffed support runbooks. Operators know who can contain, investigate and resolve each supported failure.
- `T041` — Record attributable reputation, Guild Trust and correction history. History shows actual useful work rather than wealth or repeated webhook ratings.
- `T043` — Measure the useful work loop with honest asset-aware metrics. Operators understand activation/completion/settlement without counting fake traffic or fabricated dollars.
- `T044` — Run internal alpha core journeys and capture usability evidence. Internal testers prove founder, beginner and specialist can complete supported core paths.
- `T045` — Verify core accessibility, wallet rejection and private projections. Keyboard/mobile users can complete core actions safely even when a wallet rejects.

**Weekly exit:** demonstrate actual scenario results with SHA/environment/evidence, remaining blockers and the next bounded scope.

## S08 Internal alpha: recovery and exit review

**Dates:** 2026-11-25 to 2026-12-01 (D36–D40). **Phase:** M5 alpha.

Retest fixes, rehearse restore/incidents, and decide if outside testers can enter.

- `T046` — Rehearse alpha crash, restore and adversarial boundaries. The candidate survives real transaction races and recovery rather than only happy-path demos.
- `T047` — Fix alpha blockers, retest and record the alpha exit. Invite outside testers only after core security/money/capacity/recovery blockers are verified fixed.
- `T087` — Independently verify core end-to-end, restore, replay and accessibility. Prove core end-to-end, restore, replay and accessibility against the actual boundary, with reproducible negative and recovery evidence.
- `T088` — Independently verify attributable reputation and appeal corrections. Prove suspect reciprocal activity is reviewed fairly and appeal corrections preserve evidence rather than erase history.

**Weekly exit:** demonstrate actual scenario results with SHA/environment/evidence, remaining blockers and the next bounded scope.

## S09 Closed beta: invited cohort and feedback

**Dates:** 2026-12-02 to 2026-12-08 (D41–D45). **Phase:** M5 beta.

Observe invited founder/newcomer/experienced Raider workflows under a staffed approved beta model.

- `T048` — Prepare a supported invited beta configuration and cohort. Outside testers receive accurate environment, terms, budget/cap and support information.
- `T049` — Observe invited founder and Raider work journeys. Real testers expose workflow confusion and support needs before broader access.
- `U001` — UAT: Homepage. A visitor representative can complete and explain this user journey without relying on developer implementation details.
- `U002` — UAT: Raid feed. A raider representative can complete and explain this user journey without relying on developer implementation details.
- `U003` — UAT: Guild directory. A visitor representative can complete and explain this user journey without relying on developer implementation details.
- `U004` — UAT: Guild profile and founder management. A founder and token holder representative can complete and explain this user journey without relying on developer implementation details.
- `U005` — UAT: Launch wizard. A founder representative can complete and explain this user journey without relying on developer implementation details.
- `U006` — UAT: Create-Raid wizard. A founder representative can complete and explain this user journey without relying on developer implementation details.
- `U007` — UAT: Raid detail and acceptance. A beginner and experienced raider representative can complete and explain this user journey without relying on developer implementation details.
- `U008` — UAT: Raider onboarding and profile. A newcomer and experienced builder representative can complete and explain this user journey without relying on developer implementation details.

**Weekly exit:** demonstrate actual scenario results with SHA/environment/evidence, remaining blockers and the next bounded scope.

## S10 Closed beta: stabilization and V1 gate

**Dates:** 2026-12-09 to 2026-12-15 (D46–D50). **Phase:** M5 beta.

Resolve blockers and decide whether the stable core is ready for public beta.

- `T050` — Stabilize closed beta and retest cohort defects. A clean second beta week verifies fixes instead of adding new functionality.
- `T051` — Hold V1 and public-beta entry review. A named owner decides which tested capabilities can open to wider users.
- `U009` — UAT: My Raid workspace. A raider representative can complete and explain this user journey without relying on developer implementation details.
- `U010` — UAT: Founder applicant review. A founder representative can complete and explain this user journey without relying on developer implementation details.
- `U011` — UAT: Submission review and dispute. A founder reviewer and raider representative can complete and explain this user journey without relying on developer implementation details.
- `U012` — UAT: Payments and recovery. A contributor and founder representative can complete and explain this user journey without relying on developer implementation details.

**Weekly exit:** demonstrate actual scenario results with SHA/environment/evidence, remaining blockers and the next bounded scope.

## S11 Public beta and scoped private work

**Dates:** 2026-12-16 to 2026-12-22 (D51–D55). **Phase:** M6.

Open the eligible core cohort conservatively and prove explicitly scoped confidential work.

- `T052` — Open conservative public beta and monitor the stable core. More eligible users can join without forcing incomplete feature contracts.
- `T053` — Separate private teasers, brief disclosure and resource approval. Discovery and skill scores do not reveal confidential work or grant repositories.
- `T054` — Provision isolated resources and reconcile effective access. A grant represents what the provider really allows, not imaginary folder secrecy.
- `T056` — Create Party rosters, skill coverage and member consent. Every team member understands their responsibility, terms and payout before commitment.

**Weekly exit:** demonstrate actual scenario results with SHA/environment/evidence, remaining blockers and the next bounded scope.

## S12 Parties, paid selection and fixed sponsorship

**Dates:** 2026-12-23 to 2026-12-29 (D56–D60). **Phase:** M6.

Introduce independent team/selection/placement slices with consent, funding and recovery evidence.

- `T055` — Revoke task access and contain malicious artifacts safely. Closed work ends task-derived credentials even when the provider fails.
- `T057` — Reserve Party capacity atomically and support valid replacement. A team with one busy member cannot partially reserve others or bypass capacity.
- `T058` — Publish paid selection Challenges with frozen rights and rubric. Participants know whether they are applying or accepting bounded paid prototype work.
- `T059` — Hand off selection winners through a separate funded main offer. Winning selection never silently commits someone to the larger job.
- `T060` — Sell labeled fixed sponsorship with delivery and refund tracking. Founders buy defined visibility without buying trust, rank or judgment.
- `T081` — Independently verify private visibility, provider scopes and malicious artifacts. Prove private visibility, provider scopes and malicious artifacts against the actual boundary, with reproducible negative and recovery evidence.
- `T082` — Independently verify party and challenge atomicity/rights. Prove party and challenge atomicity/rights against the actual boundary, with reproducible negative and recovery evidence.
- `U013` — UAT: Party builder. A party leader and individual members representative can complete and explain this user journey without relying on developer implementation details.
- `U014` — UAT: Challenge detail, selection and follow-on work. A challenge entrant and founder representative can complete and explain this user journey without relying on developer implementation details.

**Weekly exit:** demonstrate actual scenario results with SHA/environment/evidence, remaining blockers and the next bounded scope.

## S13 Managed AI: identity, capacity and isolation

**Dates:** 2026-12-30 to 2027-01-05 (D61–D65). **Phase:** M7.

An accountable evaluated worker can be admitted under operator capacity and sandbox restrictions.

- `T061` — Register accountable AI workers and evaluated configurations. An AI worker has stable identity and evidence rather than a model-price rank.
- `T062` — Enforce aggregate operator commitments alongside participant capacity. One operator cannot create aliases to bypass the managed-agent pilot cap.
- `T063` — Deploy an actual isolated runner with explicit tool/data authority. Untrusted task material cannot steal secrets or authorize outside actions.

**Weekly exit:** demonstrate actual scenario results with SHA/environment/evidence, remaining blockers and the next bounded scope.

## S14 Managed AI: capped task, cancellation and pilot

**Dates:** 2027-01-06 to 2027-01-12 (D66–D70). **Phase:** M7.

One permitted capped run submits useful evidence for ordinary authorized review.

- `T064` — Reserve and enforce a total AI execution budget. A retry or parallel subcall cannot spend beyond the owner’s authorized cap.
- `T065` — Handle cancel, provider failure and orphaned run recovery. A failed AI process does not leave indefinite work locks or undo external effects by assumption.
- `T066` — Route one evaluated AI task through ordinary review. A permitted task completes under limits and its output is reviewed by authorized people.
- `T084` — Independently verify ai operator capacity, spend, tools and closure. Prove ai operator capacity, spend, tools and closure against the actual boundary, with reproducible negative and recovery evidence.
- `T094` — Reconcile AI prepaid service budget, unused credit and failure refunds. A founder can understand what was spent and what is returned after a capped partial or failed run.

**Weekly exit:** demonstrate actual scenario results with SHA/environment/evidence, remaining blockers and the next bounded scope.

## S15 Advanced economy: prize and bid modules

**Dates:** 2027-01-13 to 2027-01-19 (D71–D75). **Phase:** M8.

Implement only approved prize/auction/asset slices and prove liability, claim and delivery boundaries.

- `T067` — Add fully funded prize competitions with fair award finality. All promised prizes/stipends are reserved and awarded under declared rules.
- `T068` — Implement approved single-asset auctions and losing-budget release. A bidder knows the maximum charge and gets protected release/refund if not delivered.
- `T069` — Validate each additional reward asset end to end. Adding SOL/project-token/RAID support is tested behavior rather than a ticker entry.
- `T083` — Independently verify promotion labels, auction release and delivery recovery. Prove promotion labels, auction release and delivery recovery against the actual boundary, with reproducible negative and recovery evidence.

**Weekly exit:** demonstrate actual scenario results with SHA/environment/evidence, remaining blockers and the next bounded scope.

## S16 Approved channels, Roles and beta exit

**Dates:** 2027-01-20 to 2027-01-26 (D76–D80). **Phase:** M8.

Verify selected channel/Role/scoring additions, repeat core beta evidence and record the release decision.

- `T070` — Approve channel content and deduplicate automatic publication. The exact approved content is published once through a controlled account.
- `T071` — Measure influencer delivery and capped attribution honestly. Draft creation, publication and performance bonuses remain separate obligations.
- `T072` — Calibrate versioned reputation and skill scoring with appeals. Numerical scoring uses reviewed evidence and preserves newcomer opportunity.
- `T073` — Model funded Role periods, renewal and finite closure. Ongoing responsibility uses the same one-active rule and paid consent as normal work.
- `T077` — Review public beta stability and decide GA or extended weekly beta. The project leaves beta only when the enabled scope is actually supported and proven.
- `T085` — Independently verify automatic channel publication recovery. Prove automatic channel publication recovery against the actual boundary, with reproducible negative and recovery evidence.
- `T086` — Independently verify role capacity and renewal. Prove role capacity and renewal against the actual boundary, with reproducible negative and recovery evidence.
- `U015` — UAT: Sponsor dashboard and bid clarity. A sponsor representative can complete and explain this user journey without relying on developer implementation details.
- `U016` — UAT: Operator console and release sign-off. A operator, product owner and representatives representative can complete and explain this user journey without relying on developer implementation details.

**Weekly exit:** demonstrate actual scenario results with SHA/environment/evidence, remaining blockers and the next bounded scope.

## Internal alpha across S07 and S08

**Milestone:** M5 alpha, D31–D40. **One outcome:** establish that the integrated core is ready for invited outside testers. **Development scope:** core integration, instrumentation and bug fixes only.

**Proposed cohort:** 3–5 internal participants covering founder, novice Raider, assessed experienced Raider and operator/reviewer roles. This is a test-planning assumption, not a commercial limit or claim of unique-human identity. Start on an isolated test database/network with clearly synthetic identities and assets. An internal rehearsal cannot be counted as real customer work or public reputation.

Alpha entry requires M1–M4 exit evidence for the supported test path, repeatable fixtures, observable web/worker behavior, a release SHA, safe configuration, reproducible backup/restore environment, and named bug/incident owners.

Run:

- Scripted new-project launch → verified mint → Guild → funded public task → one acceptance → submission/review → claim → history (AC66).
- Separately labeled existing-project verification → funded-work loop (AC71), plus experienced and beginner admission paths.
- Real acceptance and slot races, late jobs, immutable amendments and bounded review closure.
- Forged funding, wrong asset/network, refund/commit and hold/claim races, timeouts and duplicate receipt recovery.
- Permission/private-payload checks, wallet rejection, mobile/keyboard usability and accessible status/error states.
- Process crash/provider outage/restore with post-snapshot effects (AC67–AC68); unsafe unresolved recovered state keeps writes disabled.

Triage daily, attach evidence to every blocker, fix and retest. Finish with a fresh core regression on the candidate SHA, an operator drill, clear remaining issues and alpha exit review. Alpha exits only with no unresolved release-blocking security, money, privacy, canonical-capacity or data-loss defects, and enough usability evidence for both beginner and experienced paths.

## Invited closed beta across S09 and S10

**Milestone:** M5 closed beta, D41–D50. **One outcome:** validate real founder/Raider workflows with bounded intake and staffed support. **Development scope:** beta fixes, support and feedback improvements only.

**Proposed cohort:** 3–5 verified Guild/founder representatives and 10–20 invited Raiders, including newcomers and assessed builders. Adjust to actual support capacity and permitted operating model. Set asset, transaction and per-Guild budget caps in an accepted operating decision; this plan supplies no real fund amount or authorization.

Before invitations, choose and label the beta environment. A test-network beta uses test assets and has no real payout claim. A real-funded beta must pass every applicable G01–G05/G10 gate with actual custody/finality/terms/provider/operations evidence. Verify identity, preferences, minimal data retention, supported hours and escalation contacts. Beta labeling grants no extra authority or weaker invariants.

During beta:

- Onboard founder and Raider cohorts in small batches; verify understanding of skill, capacity, deadline, payment and confidentiality rules.
- Observe a legitimate complete work loop in the supported environment. Record funded, accepted, reviewed and actually paid states separately.
- Collect feedback after onboarding, acceptance, submission, review and payment; preserve optionality and case privacy.
- Monitor oldest engagement, overdue review, unknown transactions, claim/vault discrepancies, worker lag and support cases daily.
- Keep output/financial/permission artifacts tied to the exact tested SHA and accepted terms; a fix that changes accepted obligations needs a valid amendment/migration.
- Reproduce issues, ship small fixes, retest affected scenarios and repeat the core release journey before the stage gate.

Closed-beta exit requires complete observed founder/novice/experienced journeys, no unresolved release blockers, reconciled claims, staffed bounded case handling and disclosed remaining nonblocking issues. A small sample validates the tested paths; it does not establish scale, universal provider reliability or investment credibility.

## Public beta from S11

**Milestone:** stable core public beta; M6 features are independent gated additions. **One outcome:** increase eligible-user access while keeping the core reliable. **Evidence:** repeated M5 journeys/recovery and relevant M6 AC13–AC14/AC42–AC59.

Start only after closed-beta exit and the project owner’s recorded release decision. Use a published beta label, supported network/assets, limitations, status/support channel and permitted intake rules. Begin with conservative operating caps chosen under the approved model; increase them after observed support/reconciliation evidence. Do not promise unrestricted availability.

Prioritize live beta incidents and usability repairs. Build M6 private access, Parties, paid selection and fixed sponsorship behind separate flags with their own tests. A feature can enter a small invited cohort before public enablement. Public-beta core users must not be forced onto an incomplete new contract.

The sprint demo shows stable core throughput and case resolution, then only those M6 features with actual consent, funds, scope and recovery evidence. If support consumes planned capacity, move M6 slices into another sprint rather than compressing beta verification.

## Alpha and beta gate matrix

| Stage             | Entry                                                                                   | Test focus                                                                                    | Exit                                                                                                | Release owner                                                              |
| ----------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Internal alpha    | Integrated M1–M4 test paths, fixtures, safe environment, observability and named owners | Core correctness, concurrency, adversarial boundaries, accessibility, crash/restore           | No unresolved blockers; candidate SHA regression and operator drill; invited-beta readiness         | AG01/AG09 with AG08 evidence and AG04 finance review.                      |
| Closed beta       | Alpha exit; configured cohort/support/terms; all applicable live gates if funded        | Real user comprehension, completed work, verified claims, support and feedback                | Founder/novice/experienced paths complete; no blockers, reconciled state and staffed expansion plan | Project owner + release/support/mediation owners.                          |
| Public beta       | Closed-beta exit and approved eligible-user intake/configuration                        | Wider repeated journeys, incident handling, usability, recovery and safe incremental features | Core stability demonstrated, required gates pass, remaining issues disclosed, GA/V2 approved        | Project owner + AG09/AG08; feature authority owners sign applicable gates. |
| New feature pilot | Feature scenarios, contracts and relevant G06–G09 pass                                  | Small opt-in cohort plus feature-specific negative/recovery cases                             | Recorded enablement or continued disabled/pilot state                                               | Relevant domain owner + release/QA reviewer.                               |

For any stage, a ledger discrepancy, duplicated effect, private-data leak, bypassed commitment limit, unauthorized settlement/access, or lost acknowledged authorization pauses affected expansion immediately. Containment and final financial/culpability decisions remain separate as required by the blueprint.

## Bug and feedback process

Track beta observations and sprint defects as reviewable records. Repository issues or an existing tracker can hold them; this documentation task does not create external notifications or recruit testers.

| Field          | Record                                                                            |
| -------------- | --------------------------------------------------------------------------------- |
| Identification | Sprint/stage, issue ID, reporter, timestamp, environment/network, release SHA.    |
| Scope          | Affected user outcome, blueprint requirement/invariant and AC IDs.                |
| Reproduction   | Minimal steps, expected/actual behavior, role/permissions and sanitized evidence. |
| Impact         | Data/money/privacy/capacity harm, affected users and known external effects.      |
| Ownership      | Severity, accountable engineer/operator, support disposition and next update.     |
| Fix            | PR/SHA, migration or contract amendment, containment/recovery notes.              |
| Retest         | Exact scenario/environment/result; regression coverage where meaningful.          |
| Closure        | Reporter confirmation where available, QA verification and remaining limitations. |

| Severity | Examples                                                                                                            | Handling                                                                                                                     |
| -------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Critical | Unauthorized fund/access action, duplicate payout, exposed confidential data, lost acknowledged money/authorization | Pause affected actions/intake, preserve evidence, assign incident owner; block stage promotion until corrected and verified. |
| High     | Core workflow cannot safely complete, capacity conflict bypass, missing recovery or misleading funded/paid status   | Fix before next-stage gate; review affected existing obligations and retest boundary.                                        |
| Medium   | Recoverable core usability defect or operational issue with a safe documented workaround                            | Prioritize in current/next sprint; release owner must explicitly accept residual impact and workaround.                      |
| Low      | Cosmetic polish or low-impact enhancement                                                                           | Schedule against actual user evidence after core stability; does not override required accessibility criteria.               |

These are planning severity categories, not promised customer response-time SLAs. The operating model must record supported hours and escalation duties before paid beta. Close defects only with evidence; keep suggestions distinct from failures and never require positive ratings.

## Weekly review and release decision

Day 5 records completed scope, actual demo/scenario results, beta feedback, defect disposition, OPEN/gate status, dependency forecast, migration/recovery impact and the next five-day scope. Use blueprint section 40 task/decision/handoff templates.

The project owner and accountable release reviewers record **go**, **limited go** for independently passed features, or **no-go** for affected capability. A failed gate keeps the current safe stage or disables affected actions, with another one-week stabilization sprint and updated dates. Never erase existing claims, authorize outreach/spending from a planning issue, or bypass a required gate because the sprint has ended.
