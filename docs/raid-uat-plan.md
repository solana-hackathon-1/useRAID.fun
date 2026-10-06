# RAID user acceptance testing

[GitHub Project](https://github.com/orgs/solana-hackathon-1/projects/1) · [Developer board guide](raid-project-guide.md) · [Weekly sprint plan](raid-sprint-plan.md) · [Canonical blueprint](../RAID_AGENT_BLUEPRINT.md)

UAT asks whether a representative founder, Raider, sponsor or operator can understand and complete the intended outcome. Technical QA proves command/database/program/access/recovery correctness. Both are required where relevant; a passing developer suite does not constitute business acceptance.

There are 16 UAT journeys under epic E22, covering every screen contract in blueprint 23.2. Each has a test persona, plain steps, expected results, prerequisite implementation, canonical scenarios and recorded product-owner sign-off. Planned sprint and staging environment are forecasts; no UAT has been marked passed by creating this backlog.

## How to run and sign off

1. Select a QA-verified candidate SHA and actually configured environment/network. Use synthetic test data/test assets unless live scope has separately approved gates and authorization.
2. Assign representative tester and business reviewer; give the user the goal without teaching hidden developer steps.
3. Run each journey’s steps and record expected versus observed outcomes. Capture sanitized screenshot/video/result and defect links.
4. Record Pass, Fail or Blocked per scenario. Fix and retest failed boundaries at a named SHA; preserve the first observation.
5. The named business reviewer records accepted/rejected scope, date, limitations and the relevant stage decision. Set UAT status Passed only with that evidence.
6. Keep QA status, UAT status and Release readiness separate. An approved UAT still cannot bypass a missing custody/finality/access/provider/operations gate.

## UAT journeys

## U001 UAT: Homepage

**Forecast:** S09. **Tester/reviewer responsibility:** Product owner + Visitor representative + AG08 facilitator. **Predecessors:** T015, T044. **Acceptance references:** AC42,AC70.

A visitor representative can complete and explain this user journey without relying on developer implementation details.

[Open GitHub UAT issue](https://github.com/solana-hackathon-1/useRAID.fun/issues/142)

### Steps

1. Open the homepage on mobile and desktop
2. Explain RAID’s project/work loop in your own words
3. Navigate to funded work and project discovery
4. Record tester identity/role, environment/network, release SHA and test data before starting.
5. Record observed results, sanitized screenshots, feedback and defect links.
6. Have the product owner or designated business reviewer record acceptance or rejection; keep technical QA and live gate approval separate.

### Expected results

- [ ] Main actions are visible and understandable
- [ ] Only permitted safe cards appear; no fake activity or unmarked simulation
- [ ] Each expected result has pass/fail and observable evidence.
- [ ] Failed critical/high-impact journey blocks dependent feature/stage until fixed and retested.
- [ ] Business sign-off identifies reviewer/date/scope and remaining accepted limitations.

## U002 UAT: Raid feed

**Forecast:** S09. **Tester/reviewer responsibility:** Product owner + Raider representative + AG08 facilitator. **Predecessors:** T018, T021, T097. **Acceptance references:** AC05,AC42,AC70.

A raider representative can complete and explain this user journey without relying on developer implementation details.

[Open GitHub UAT issue](https://github.com/solana-hackathon-1/useRAID.fun/issues/143)

### Steps

1. Filter by relevant skill/rank/funding/asset
2. Open a fitting task
3. Try an ineligible task and read the reason
4. Record tester identity/role, environment/network, release SHA and test data before starting.
5. Record observed results, sanitized screenshots, feedback and defect links.
6. Have the product owner or designated business reviewer record acceptance or rejection; keep technical QA and live gate approval separate.

### Expected results

- [ ] Filtering uses actual permitted fields
- [ ] Unmet requirement is understandable without leaking private policy
- [ ] Each expected result has pass/fail and observable evidence.
- [ ] Failed critical/high-impact journey blocks dependent feature/stage until fixed and retested.
- [ ] Business sign-off identifies reviewer/date/scope and remaining accepted limitations.

## U003 UAT: Guild directory

**Forecast:** S09. **Tester/reviewer responsibility:** Product owner + Visitor representative + AG08 facilitator. **Predecessors:** T009, T015. **Acceptance references:** AC07,AC08.

A visitor representative can complete and explain this user journey without relying on developer implementation details.

[Open GitHub UAT issue](https://github.com/solana-hackathon-1/useRAID.fun/issues/144)

### Steps

1. Find a verified project
2. Open a new Guild with no work history
3. Compare verification and unknown holder states
4. Record tester identity/role, environment/network, release SHA and test data before starting.
5. Record observed results, sanitized screenshots, feedback and defect links.
6. Have the product owner or designated business reviewer record acceptance or rejection; keep technical QA and live gate approval separate.

### Expected results

- [ ] No-history is honest
- [ ] Token/project labels and verification state are understandable
- [ ] Each expected result has pass/fail and observable evidence.
- [ ] Failed critical/high-impact journey blocks dependent feature/stage until fixed and retested.
- [ ] Business sign-off identifies reviewer/date/scope and remaining accepted limitations.

## U004 UAT: Guild profile and founder management

**Forecast:** S09. **Tester/reviewer responsibility:** Product owner + Founder and token holder representative + AG08 facilitator. **Predecessors:** T009, T010, T011, T041. **Acceptance references:** AC07,AC08,AC71.

A founder and token holder representative can complete and explain this user journey without relying on developer implementation details.

[Open GitHub UAT issue](https://github.com/solana-hackathon-1/useRAID.fun/issues/145)

### Steps

1. Verify/link an existing project with approved control evidence
2. Inspect public history and founder permissions
3. Try holder-only administration without a grant
4. Record tester identity/role, environment/network, release SHA and test data before starting.
5. Record observed results, sanitized screenshots, feedback and defect links.
6. Have the product owner or designated business reviewer record acceptance or rejection; keep technical QA and live gate approval separate.

### Expected results

- [ ] Founder can manage only authorized fields
- [ ] Holder membership does not give project ownership or private rights
- [ ] Each expected result has pass/fail and observable evidence.
- [ ] Failed critical/high-impact journey blocks dependent feature/stage until fixed and retested.
- [ ] Business sign-off identifies reviewer/date/scope and remaining accepted limitations.

## U005 UAT: Launch wizard

**Forecast:** S09. **Tester/reviewer responsibility:** Product owner + Founder representative + AG08 facilitator. **Predecessors:** T027, T028. **Acceptance references:** AC26,AC27,AC66,AC70.

A founder representative can complete and explain this user journey without relying on developer implementation details.

[Open GitHub UAT issue](https://github.com/solana-hackathon-1/useRAID.fun/issues/146)

### Steps

1. Prepare selected test-network launch
2. Review token controls, actions, network, recipient and costs
3. Reject a wallet request, retry and inspect final verified mint
4. Record tester identity/role, environment/network, release SHA and test data before starting.
5. Record observed results, sanitized screenshots, feedback and defect links.
6. Have the product owner or designated business reviewer record acceptance or rejection; keep technical QA and live gate approval separate.

### Expected results

- [ ] Draft and intent survive rejection
- [ ] Final success reflects verified artifacts and correct Guild linkage
- [ ] Each expected result has pass/fail and observable evidence.
- [ ] Failed critical/high-impact journey blocks dependent feature/stage until fixed and retested.
- [ ] Business sign-off identifies reviewer/date/scope and remaining accepted limitations.

## U006 UAT: Create-Raid wizard

**Forecast:** S09. **Tester/reviewer responsibility:** Product owner + Founder representative + AG08 facilitator. **Predecessors:** T016, T017, T018, T031. **Acceptance references:** AC28,AC72.

A founder representative can complete and explain this user journey without relying on developer implementation details.

[Open GitHub UAT issue](https://github.com/solana-hackathon-1/useRAID.fun/issues/147)

### Steps

1. Describe outcome/criteria and inspect recommendation assumptions
2. Review rank/skills/full reward/net fees/deadlines
3. Save, fund on approved test path and publish; try changing accepted terms
4. Record tester identity/role, environment/network, release SHA and test data before starting.
5. Record observed results, sanitized screenshots, feedback and defect links.
6. Have the product owner or designated business reviewer record acceptance or rejection; keep technical QA and live gate approval separate.

### Expected results

- [ ] Founder understands what they commission and fund
- [ ] Missing reward leg prevents full-funded claim; accepted terms cannot be overwritten
- [ ] Each expected result has pass/fail and observable evidence.
- [ ] Failed critical/high-impact journey blocks dependent feature/stage until fixed and retested.
- [ ] Business sign-off identifies reviewer/date/scope and remaining accepted limitations.

## U007 UAT: Raid detail and acceptance

**Forecast:** S09. **Tester/reviewer responsibility:** Product owner + Beginner and experienced Raider representative + AG08 facilitator. **Predecessors:** T020, T021, T022, T032. **Acceptance references:** AC03,AC05,AC06,AC11,AC12,AC18.

A beginner and experienced raider representative can complete and explain this user journey without relying on developer implementation details.

[Open GitHub UAT issue](https://github.com/solana-hackathon-1/useRAID.fun/issues/148)

### Steps

1. Read terms and skill/capacity checklist
2. Apply or accept the permitted offer
3. From a second device attempt another work engagement
4. Record tester identity/role, environment/network, release SHA and test data before starting.
5. Record observed results, sanitized screenshots, feedback and defect links.
6. Have the product owner or designated business reviewer record acceptance or rejection; keep technical QA and live gate approval separate.

### Expected results

- [ ] Both appropriate entry routes are understandable
- [ ] Exactly one engagement is committed, with honest binding readiness
- [ ] Each expected result has pass/fail and observable evidence.
- [ ] Failed critical/high-impact journey blocks dependent feature/stage until fixed and retested.
- [ ] Business sign-off identifies reviewer/date/scope and remaining accepted limitations.

## U008 UAT: Raider onboarding and profile

**Forecast:** S09. **Tester/reviewer responsibility:** Product owner + Newcomer and experienced builder representative + AG08 facilitator. **Predecessors:** T008, T012, T013, T014. **Acceptance references:** AC01,AC03,AC04,AC06.

A newcomer and experienced builder representative can complete and explain this user journey without relying on developer implementation details.

[Open GitHub UAT issue](https://github.com/solana-hackathon-1/useRAID.fun/issues/149)

### Steps

1. Complete orientation and find a starter task
2. Add portfolio/trial evidence for a relevant advanced skill
3. Link another wallet and inspect history/active work
4. Record tester identity/role, environment/network, release SHA and test data before starting.
5. Record observed results, sanitized screenshots, feedback and defect links.
6. Have the product owner or designated business reviewer record acceptance or rejection; keep technical QA and live gate approval separate.

### Expected results

- [ ] Registration/token purchase does not fabricate verified rank
- [ ] Experienced builder can prove ability without irrelevant grinding; identity/history stay intact
- [ ] Each expected result has pass/fail and observable evidence.
- [ ] Failed critical/high-impact journey blocks dependent feature/stage until fixed and retested.
- [ ] Business sign-off identifies reviewer/date/scope and remaining accepted limitations.

## U009 UAT: My Raid workspace

**Forecast:** S10. **Tester/reviewer responsibility:** Product owner + Raider representative + AG08 facilitator. **Predecessors:** T022, T023, T024, T034. **Acceptance references:** AC19,AC20,AC21,AC23.

A raider representative can complete and explain this user journey without relying on developer implementation details.

[Open GitHub UAT issue](https://github.com/solana-hackathon-1/useRAID.fun/issues/150)

### Steps

1. Open accepted terms and resources
2. Submit versioned work, handle review/revision and observe deadline
3. After operational acceptance inspect payment while starting eligible next work
4. Record tester identity/role, environment/network, release SHA and test data before starting.
5. Record observed results, sanitized screenshots, feedback and defect links.
6. Have the product owner or designated business reviewer record acceptance or rejection; keep technical QA and live gate approval separate.

### Expected results

- [ ] Next action and agreed version are clear
- [ ] Review duty holds capacity; terminal unpaid work preserves claim and frees capacity
- [ ] Each expected result has pass/fail and observable evidence.
- [ ] Failed critical/high-impact journey blocks dependent feature/stage until fixed and retested.
- [ ] Business sign-off identifies reviewer/date/scope and remaining accepted limitations.

## U010 UAT: Founder applicant review

**Forecast:** S10. **Tester/reviewer responsibility:** Product owner + Founder representative + AG08 facilitator. **Predecessors:** T014, T021, T022. **Acceptance references:** AC05,AC17.

A founder representative can complete and explain this user journey without relying on developer implementation details.

[Open GitHub UAT issue](https://github.com/solana-hackathon-1/useRAID.fun/issues/151)

### Steps

1. Compare relevant assessed skill/evidence and current capacity
2. Offer specific versioned work
3. Try a stale offer after the candidate becomes busy
4. Record tester identity/role, environment/network, release SHA and test data before starting.
5. Record observed results, sanitized screenshots, feedback and defect links.
6. Have the product owner or designated business reviewer record acceptance or rejection; keep technical QA and live gate approval separate.

### Expected results

- [ ] Irrelevant skill cannot substitute
- [ ] Founder understands current capacity; acceptance rechecks state
- [ ] Each expected result has pass/fail and observable evidence.
- [ ] Failed critical/high-impact journey blocks dependent feature/stage until fixed and retested.
- [ ] Business sign-off identifies reviewer/date/scope and remaining accepted limitations.

## U011 UAT: Submission review and dispute

**Forecast:** S10. **Tester/reviewer responsibility:** Product owner + Founder reviewer and Raider representative + AG08 facilitator. **Predecessors:** T023, T025, T035. **Acceptance references:** AC10,AC19,AC21,AC38,AC72.

A founder reviewer and raider representative can complete and explain this user journey without relying on developer implementation details.

[Open GitHub UAT issue](https://github.com/solana-hackathon-1/useRAID.fun/issues/152)

### Steps

1. Review a specific submitted version against original checklist
2. Request permitted bounded revision or reasoned dispute
3. Inspect notice/appeal/claim state and try a unilateral scope change
4. Record tester identity/role, environment/network, release SHA and test data before starting.
5. Record observed results, sanitized screenshots, feedback and defect links.
6. Have the product owner or designated business reviewer record acceptance or rejection; keep technical QA and live gate approval separate.

### Expected results

- [ ] Decision is about the right version and original terms
- [ ] Claim/finality and work closure remain clear and separate
- [ ] Each expected result has pass/fail and observable evidence.
- [ ] Failed critical/high-impact journey blocks dependent feature/stage until fixed and retested.
- [ ] Business sign-off identifies reviewer/date/scope and remaining accepted limitations.

## U012 UAT: Payments and recovery

**Forecast:** S10. **Tester/reviewer responsibility:** Product owner + Contributor and founder representative + AG08 facilitator. **Predecessors:** T033, T034, T036. **Acceptance references:** AC33,AC36,AC37,AC40,AC49.

A contributor and founder representative can complete and explain this user journey without relying on developer implementation details.

[Open GitHub UAT issue](https://github.com/solana-hackathon-1/useRAID.fun/issues/153)

### Steps

1. Inspect exact asset obligations/net fees
2. Observe pending, partially paid, blocked and finalized transfer examples
3. Check restricted-account claim access and permitted destination recovery
4. Record tester identity/role, environment/network, release SHA and test data before starting.
5. Record observed results, sanitized screenshots, feedback and defect links.
6. Have the product owner or designated business reviewer record acceptance or rejection; keep technical QA and live gate approval separate.

### Expected results

- [ ] Displayed paid state matches actual evidence
- [ ] Blocked/frozen claim remains owed; unauthorized payout address change is rejected
- [ ] Each expected result has pass/fail and observable evidence.
- [ ] Failed critical/high-impact journey blocks dependent feature/stage until fixed and retested.
- [ ] Business sign-off identifies reviewer/date/scope and remaining accepted limitations.

## U013 UAT: Party builder

**Forecast:** S12. **Tester/reviewer responsibility:** Product owner + Party leader and individual members representative + AG08 facilitator. **Predecessors:** T056, T057. **Acceptance references:** AC13,AC50.

A party leader and individual members representative can complete and explain this user journey without relying on developer implementation details.

[Open GitHub UAT issue](https://github.com/solana-hackathon-1/useRAID.fun/issues/154)

### Steps

1. Choose roles and relevant skill coverage
2. Each member reviews exact per-asset split and consents
3. Try accepting with a busy member and changing another member’s split
4. Record tester identity/role, environment/network, release SHA and test data before starting.
5. Record observed results, sanitized screenshots, feedback and defect links.
6. Have the product owner or designated business reviewer record acceptance or rejection; keep technical QA and live gate approval separate.

### Expected results

- [ ] Members understand responsibility and payout
- [ ] Busy member causes full rollback; leader cannot override another member’s consent
- [ ] Each expected result has pass/fail and observable evidence.
- [ ] Failed critical/high-impact journey blocks dependent feature/stage until fixed and retested.
- [ ] Business sign-off identifies reviewer/date/scope and remaining accepted limitations.

## U014 UAT: Challenge detail, selection and follow-on work

**Forecast:** S12. **Tester/reviewer responsibility:** Product owner + Challenge entrant and founder representative + AG08 facilitator. **Predecessors:** T058, T059. **Acceptance references:** AC51,AC52,AC53,AC54,AC55,AC56,AC57.

A challenge entrant and founder representative can complete and explain this user journey without relying on developer implementation details.

[Open GitHub UAT issue](https://github.com/solana-hackathon-1/useRAID.fun/issues/155)

### Steps

1. Read selection terms, rubric, rights and compensation
2. Submit qualifying prototype and inspect nonwinning outcome
3. As selected builder decline or accept separately funded main offer
4. Record tester identity/role, environment/network, release SHA and test data before starting.
5. Record observed results, sanitized screenshots, feedback and defect links.
6. Have the product owner or designated business reviewer record acceptance or rejection; keep technical QA and live gate approval separate.

### Expected results

- [ ] Nonwinner qualification/payment and rights are preserved
- [ ] Winning does not automatically reserve main work or punish decline
- [ ] Each expected result has pass/fail and observable evidence.
- [ ] Failed critical/high-impact journey blocks dependent feature/stage until fixed and retested.
- [ ] Business sign-off identifies reviewer/date/scope and remaining accepted limitations.

## U015 UAT: Sponsor dashboard and bid clarity

**Forecast:** S16. **Tester/reviewer responsibility:** Product owner + Sponsor representative + AG08 facilitator. **Predecessors:** T060, T068. **Acceptance references:** AC58,AC59.

A sponsor representative can complete and explain this user journey without relying on developer implementation details.

[Open GitHub UAT issue](https://github.com/solana-hackathon-1/useRAID.fun/issues/156)

### Steps

1. Read fixed slot/bid price, inventory, maximum charge and delivery terms
2. Inspect Sponsored display versus organic work
3. Review losing bid or undelivered placement refund example
4. Record tester identity/role, environment/network, release SHA and test data before starting.
5. Record observed results, sanitized screenshots, feedback and defect links.
6. Have the product owner or designated business reviewer record acceptance or rejection; keep technical QA and live gate approval separate.

### Expected results

- [ ] Buyer understands visibility product without rank/reputation benefit
- [ ] Losing/undelivered purchase follows exact published release/refund rules
- [ ] Each expected result has pass/fail and observable evidence.
- [ ] Failed critical/high-impact journey blocks dependent feature/stage until fixed and retested.
- [ ] Business sign-off identifies reviewer/date/scope and remaining accepted limitations.

## U016 UAT: Operator console and release sign-off

**Forecast:** S16. **Tester/reviewer responsibility:** Product owner + Operator, product owner and representatives representative + AG08 facilitator. **Predecessors:** T040, T046, T066, T070, T073. **Acceptance references:** AC60,AC61,AC62,AC63,AC64,AC65,AC67,AC68.

A operator, product owner and representatives representative can complete and explain this user journey without relying on developer implementation details.

[Open GitHub UAT issue](https://github.com/solana-hackathon-1/useRAID.fun/issues/157)

### Steps

1. Investigate unknown payment/access/AI/provider incident from correlated state
2. Use scoped permitted repair or escalation and inspect audit
3. Review beta evidence, optional features and go/limited-go/no-go; verify approved publication and Role capacity examples
4. Record tester identity/role, environment/network, release SHA and test data before starting.
5. Record observed results, sanitized screenshots, feedback and defect links.
6. Have the product owner or designated business reviewer record acceptance or rejection; keep technical QA and live gate approval separate.

### Expected results

- [ ] Operator understands authority and honest recovery limits
- [ ] QA results, UAT sign-off and production gates are separate; unsafe rollout stays disabled
- [ ] Each expected result has pass/fail and observable evidence.
- [ ] Failed critical/high-impact journey blocks dependent feature/stage until fixed and retested.
- [ ] Business sign-off identifies reviewer/date/scope and remaining accepted limitations.

## Evidence record

| Field               | Required value                                                                            |
| ------------------- | ----------------------------------------------------------------------------------------- |
| Journey/stage       | UAT ID and weekly sprint/stage.                                                           |
| Tester/reviewer     | Named representative role/person and designated business reviewer.                        |
| Candidate           | SHA/build, date, actual environment/network and fixture/provider versions.                |
| Result              | Step-level expected/observed behavior, Pass/Fail/Blocked and sanitized evidence links.    |
| Defect              | Impact/severity, reproduction, engineer/operator owner, containment and retest reference. |
| Business acceptance | Accepted/rejected scope, reviewer/date, outstanding limitations and next review.          |
| Enablement          | Relevant G01–G10 evidence and recorded go/limited-go/no-go for the affected feature.      |

Critical/high failures of money, privacy, authority, capacity or recoverable commitments block affected promotion. A safe workaround for a lesser usability issue needs explicit release-owner acceptance and a visible follow-up. No tester must submit a positive rating or surrender unrelated private credentials to prove acceptance.
