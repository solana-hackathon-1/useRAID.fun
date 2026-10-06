# RAID two-week sprints, alpha and beta plan

**Primary schedule: eight two-week sprints, 16 weeks total.** Internal alpha has its own two-week sprint. Invited closed beta has its own two-week sprint. Public beta starts only after the closed-beta gate passes, then continues while independently gated features are introduced.

[Master timeline and assumptions](raid-delivery-timeline.md) · [Development/testing checklists](raid-development-phases.md) · [Complete coverage](raid-delivery-coverage.md) · [Canonical blueprint](../RAID_AGENT_BLUEPRINT.md)

Prepared 6 October 2026. Illustrative kickoff: 7 October. Dates exclude weekends only; no holiday/leave adjustment. Staffing and OPEN-policy assumptions come from the master timeline. The schedule reserves S4 for alpha stabilization and S5 for invited closed beta. The canonical M0–M8 scope remains unchanged; M5 spans both S4 and S5.

## Contents

- [Sprint board](#sprint-board)
- [Ten-day sprint rhythm](#ten-day-sprint-rhythm)
- [S1 foundation](#s1-foundation)
- [S2 public work prototype](#s2-public-work-prototype)
- [S3 launch and financial proof](#s3-launch-and-financial-proof)
- [S4 internal alpha](#s4-internal-alpha)
- [S5 invited closed beta](#s5-invited-closed-beta)
- [S6 public beta](#s6-public-beta)
- [S7 managed AI pilot](#s7-managed-ai-pilot)
- [S8 advanced modules and beta exit](#s8-advanced-modules-and-beta-exit)
- [Alpha and beta gate matrix](#alpha-and-beta-gate-matrix)
- [Bug and feedback process](#bug-and-feedback-process)
- [Sprint review and release decision](#sprint-review-and-release-decision)

## Sprint board

| Sprint | Dates              | One primary outcome                             | Development phase           | Testing/release stage                                            |
| ------ | ------------------ | ----------------------------------------------- | --------------------------- | ---------------------------------------------------------------- |
| S1     | 7–20 Oct 2026      | Verified participant/Guild foundation           | M0 + M1                     | Domain/auth/permission tests; staging demo.                      |
| S2     | 21 Oct–3 Nov       | Public commissioned-work prototype              | M2; M3 starts independently | Synthetic money; real PostgreSQL capacity/terms tests.           |
| S3     | 4–17 Nov           | Integrated verified launch/funding loop         | M3 completes; M4            | Test-network financial/program/recovery proof.                   |
| S4     | 18 Nov–1 Dec       | Stable core proven by internal alpha            | M5 alpha integration/fixes  | Internal alpha, isolated test environment; no feature expansion. |
| S5     | 2–15 Dec           | Core validated by invited users                 | M5 beta fixes/operations    | Closed beta, constrained intake; controlled V1 decision.         |
| S6     | 16–29 Dec          | Stable core opened to a wider eligible cohort   | M6 conditional expansion    | Public beta; private/Party/selection/sponsor gates independent.  |
| S7     | 30 Dec–12 Jan 2027 | One accountable AI task reaches ordinary review | M7                          | Managed-agent pilot inside continued core public beta.           |
| S8     | 13–26 Jan          | Selected economy modules and beta exit evidence | M8 selected capabilities    | Module tests; public-beta regression/restore; V2/GA review.      |

These dates are conditional targets. Core beta defects take precedence over S6–S8 expansion. Actual token issuance, an optional license, unsupported channel automation, custom program assurance, and unresolved organization operator scaling have separate gates and no guaranteed sprint.

## Ten-day sprint rhythm

| Sprint day | Development sprints S1–S3/S6–S8                                                                    | Alpha/beta sprints S4–S5                                                                                               |
| ---------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Day 1      | Confirm one outcome, contracts, requirements, owners and test fixtures; freeze acceptance criteria | Verify stage entry, release SHA/configuration, tester consent/preferences and support readiness.                       |
| Days 2–5   | Build small vertical slices; daily meaningful tests and review; integrate independent contracts    | Run scripted and exploratory journeys, observe usability, collect evidence and reproduce feedback; fix blockers daily. |
| Days 6–7   | Complete user flow, adverse states, integration and migrations; no unbounded scope additions       | Retest fixes, cover hostile/concurrent/provider failure paths and inspect user support incidents.                      |
| Day 8      | Execute full phase scenarios, accessibility and recovery relevant to the feature                   | Run restore/incident drill or full cohort journey; reconcile financial/access state and close evidence gaps.           |
| Day 9      | Stabilize, targeted regression and documentation; prepare demo and release evidence                | Verify retests and feedback disposition; assemble alpha/beta stage decision.                                           |
| Day 10     | Demo actual behavior, assess exit criteria, update register and next bounded backlog               | Hold explicit go/no-go review; promote only passed features; publish next stage/cohort plan.                           |

Testing starts on the first delivered behavior. Days 8–10 are integration and gate time, not the first time anyone tests the code. Sprint reviews cite actual scenario results and environment; they cannot mark PENDING tests passed.

## S1 foundation

**Milestones:** M0 and M1. **Requirements:** R01–R04, R06, R08, R10–R12; relevant I06–I12. **Evidence:** AC01–AC08 and safe projections AC42–AC43; full behavior appears in the phase and coverage docs.

Deliver canonical identity and wallet links, verified existing-project/Guild relationship, holder freshness, founder permissions, beginner orientation and relevant skill assessment. Freeze identity/terms/work/asset/API contracts and migrations. Map all OPEN decisions and staffing; nominate launch and settlement options by D10.

The demo shows a new person and an experienced builder taking appropriate paths, a token holder denied founder authority, and a wallet change preserving identity. No synthetic score becomes a verified capability. Exit with working staging foundation and documented gaps.

## S2 public work prototype

**Milestone:** M2; M3 starts in parallel after identity contracts. **Requirements:** R04–R08 and R11–R13. **Evidence:** AC11–AC12, AC17–AC25, AC69–AC70, AC72.

Deliver create/recommend/publish, safe work cards, applications/offers, immutable accepted terms, one canonical active commitment, versioned submissions/review, bounded revision/closure and My Raid. Funding is explicitly simulated. Prove concurrent accepts against real PostgreSQL; no process-local mutex or mock busy check can pass the capacity gate.

The demo ends with accepted work and freed capacity while a distinct synthetic payment status remains. Existing attention campaign rules and historical obligations stay versioned. M3 meanwhile builds the selected route adapter and signing/recovery contract without delaying the synthetic work loop.

## S3 launch and financial proof

**Milestones:** M3 finishes by D25; M4 exits D30. **Requirements:** R01–R03/R13, P05, I03–I05/I08–I12. **Evidence:** AC26–AC41, AC49, AC67–AC69, AC72; integrated AC66/AC71 tested in alpha and beta.

Complete the selected test-network launch, verified mint/Guild linkage, approved asset model, verified funding/binding, per-slot reserves, constrained claims/refunds, finality/appeals and reconciliation. Separate chain receipts, work state and financial state. Existing manual custody is reused only if the selected design supports the blueprint authority rules.

The demo proves launch artifacts, the right escrow binding, no duplicate payout after timeout, no unilateral refund of committed work, and protected partial/blocked claims. Alpha entry requires no known critical failure in these boundaries. If selected provider/program capability or assurance is missing, continue a labeled test-only alpha; live beta cannot bypass G01–G05/G10.

## S4 internal alpha

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

## S5 invited closed beta

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

## S6 public beta

**Milestone:** stable core public beta; M6 features are independent gated additions. **One outcome:** increase eligible-user access while keeping the core reliable. **Evidence:** repeated M5 journeys/recovery and relevant M6 AC13–AC14/AC42–AC59.

Start only after closed-beta exit and the project owner’s recorded release decision. Use a published beta label, supported network/assets, limitations, status/support channel and permitted intake rules. Begin with conservative operating caps chosen under the approved model; increase them after observed support/reconciliation evidence. Do not promise unrestricted availability.

Prioritize live beta incidents and usability repairs. Build M6 private access, Parties, paid selection and fixed sponsorship behind separate flags with their own tests. A feature can enter a small invited cohort before public enablement. Public-beta core users must not be forced onto an incomplete new contract.

The sprint demo shows stable core throughput and case resolution, then only those M6 features with actual consent, funds, scope and recovery evidence. If support consumes planned capacity, move M6 slices into another sprint rather than compressing beta verification.

## S7 managed AI pilot

**Milestone:** M7, while core public beta continues. **One outcome:** an evaluated registered worker completes one bounded task and enters ordinary authorized review. **Evidence:** AC15–AC16, AC48, AC61–AC64 plus replay/access checks.

Register an accountable operator, evaluate the configuration, enforce participant/operator capacity and deploy a real isolation boundary. Verify task-scoped tools, callback authentication, approved provider data handling, total budget across retries and subcalls, cancellation, heartbeat recovery and finite operational closure. No model approval of its own output/reward.

Enable the managed feature for a small opted-in cohort only after G07. Record execution costs separately from performance rewards and preserve model/configuration history. Beta findings or actual core incidents take precedence over widening the agent cohort.

## S8 advanced modules and beta exit

**Milestone:** selected M8 modules; remaining modules receive a dated backlog/decision owner. **One outcome:** release only evidenced additions and decide whether the core can leave beta. **Evidence:** relevant AC50–AC65 plus AC67–AC72 and all added-asset financial cases.

Pick the sprint’s permitted prize/bid/channel/scoring/Role slices based on accepted decisions and available capacity. Test maximum reward liability, rights/finality, losing-bid release, approval-bound deduplicated publication, evidence calibration and Role capacity/renewal. Reuse existing verified contracts; do not invent O03/O04/O09/O16/O17/O19 policy to finish a board.

Review public-beta core reliability, case handling, recurring journey defects, reconciliation and restore evidence across S6–S8. Re-run required scenarios at the release SHA. V2 or GA is a recorded feature-by-feature decision, not automatic on D80. If stability or a required gate is missing, extend beta by another two-week sprint focused on the unresolved outcomes. Actual RAID-token issuance retains its separately estimated economics/authority/assurance package.

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

## Sprint review and release decision

Every Day 10 review records the one user outcome, completed scope, observed test/demo results, beta feedback and defect disposition, OPEN/gate status, current forecast, migration/recovery effect and next ten-day task packets. Use blueprint section 40 for formal handoffs.

The project owner and accountable release roles choose **go**, **limited go** for passed independent features, or **no-go** for the affected stage. A no-go keeps the current safe stage or disables affected actions; it creates another bounded two-week stabilization sprint and a revised timeline. Existing claims and evidence survive a paused rollout.

No new commercial policy is adopted by this schedule. Preserve one active work engagement, integer asset accounting, immutable terms, explicit grants, replay protection, and separate work/financial states throughout alpha and beta.
