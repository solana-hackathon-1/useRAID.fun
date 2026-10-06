# RAID GitHub Project developer guide

Open the [RAID full delivery Project](https://github.com/orgs/solana-hackathon-1/projects/1) from the [repository Projects tab](https://github.com/solana-hackathon-1/useRAID.fun/projects). The organization-owned Project is directly linked to this repository.

[Weekly sprint plan](raid-sprint-plan.md) · [Full issue catalogue](raid-project-backlog.md) · [UAT and business acceptance](raid-uat-plan.md) · [Canonical blueprint](../RAID_AGENT_BLUEPRINT.md)

## What the Project contains

The backlog covers the complete blueprint: **23 epics, 97 development/independent verification tasks, 16 UAT journeys, 19 owner decisions and 10 live release gates**. There are **16 native weekly Sprint iterations and matching repository milestones**. Each task has a plain-language outcome, actual inspection targets, work checklist, acceptance criteria, relevant scenarios, dependency links and completion handoff. Native sub-issues connect work to epics; native blocked-by relationships make unfinished predecessors visible.

Everything is planning work until actual evidence is added. Existing application behavior must be inventoried before implementation claims. Forecast sprint assignment is not a promise that every task fits that week. Re-estimate, assign named contributors and move unfinished work at weekly planning; never invent a policy or skip a safety gate to meet a date.

## Project views

| View                                                                                           | How to use it                                                                                                                                    |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| [All delivery work](https://github.com/orgs/solana-hackathon-1/projects/1/views/1)             | Full table of epics, implementation, verification, UAT, decisions and gates. Filter Kind, Epic, Sprint, Priority or Status.                      |
| [Weekly sprint board](https://github.com/orgs/solana-hackathon-1/projects/1/views/2)           | Board grouped by workflow Status. Filter Sprint to a single native one-week iteration; move only ready tasks into work.                          |
| [Weekly roadmap](https://github.com/orgs/solana-hackathon-1/projects/1/views/3)                | Native roadmap using sprint/date fields. All sprint items have forecast Start date/Target date; the Sprint field has 16 dated weekly iterations. |
| [Epics and outcomes](https://github.com/orgs/solana-hackathon-1/projects/1/views/4)            | Parent issues and native sub-issue progress; inspect child scope before claiming an epic complete.                                               |
| [Decisions and release gates](https://github.com/orgs/solana-hackathon-1/projects/1/views/5)   | Unresolved owner choices and actual enablement evidence; this is where blockers are resolved, not guessed.                                       |
| [Alpha and beta](https://github.com/orgs/solana-hackathon-1/projects/1/views/6)                | Cohort testing, feedback, stabilization and public-beta work by Stage.                                                                           |
| [UAT and business acceptance](https://github.com/orgs/solana-hackathon-1/projects/1/views/7)   | Representative-user journeys, UAT owner/result, environment and evidence/sign-off.                                                               |
| [Quality and release readiness](https://github.com/orgs/solana-hackathon-1/projects/1/views/8) | Independent verification/gates with QA result, UAT context, severity and release readiness.                                                      |
| [Priority board](https://github.com/orgs/solana-hackathon-1/projects/1/views/10)               | Compare P0/P1/P2 work with priority, owners and blockers visible.                                                                                |
| P0 / P1 / P2 priority boards                                                                   | Separate priority-filtered boards with workflow columns for each priority.                                                                       |
| [P0 blockers](https://github.com/orgs/solana-hackathon-1/projects/1/views/11)                  | Open invariant and release blockers for daily triage.                                                                                            |
| [Release timeline](https://github.com/orgs/solana-hackathon-1/projects/1/views/12)             | Dated delivery roadmap across phases, releases and weekly forecasts.                                                                             |
| [UAT board](https://github.com/orgs/solana-hackathon-1/projects/1/views/13)                    | UAT journeys with owner, result, environment and sign-off evidence visible.                                                                      |
| [Conditional backlog](https://github.com/orgs/solana-hackathon-1/projects/1/views/9)           | Token issuance, optional entitlement and organization scaling without an invented delivery promise.                                              |

The GitHub API exposes roadmap creation, filters and item dates; it does not expose the roadmap date-axis picker or custom board grouping. In the roadmap view’s Date fields menu, select Start date and Target date (or Sprint for iteration timing) if GitHub has not selected them by default. Priority-specific boards use workflow columns and P0/P1/P2 filters.

Roadmap timing is a forecast. Dates start on 7 October 2026 and exclude public holidays/leave from no calculations; each iteration is seven calendar days containing five weekdays. Reset the kickoff if the team starts later. Actual dates are separate and initially empty.

## Delivery and timeline fields

| Field                                           | Meaning and update rule                                                                                                                                                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Title                                           | Stable E/T/U/O/G ID and a concrete human-readable outcome.                                                                                                                                                                |
| Status                                          | Backlog, Ready, Needs decision, Blocked, In Progress, In Review or Done. See workflow below.                                                                                                                              |
| Kind                                            | Epic, Task, Verification, UAT, Decision or Release gate; separates building, checking and authorizing.                                                                                                                    |
| Sprint                                          | Native one-week iteration S01–S16 with real dates. Empty for spanning epics and conditional later work.                                                                                                                   |
| Milestone                                       | Matching repository weekly sprint; lets users filter issues without opening Projects.                                                                                                                                     |
| Epic                                            | Product/engineering parent outcome. Native Parent issue and Sub-issues progress carry the hierarchy.                                                                                                                      |
| Phase                                           | Blueprint M0–M8 milestone references; phases can span several weekly sprints.                                                                                                                                             |
| Stage                                           | Foundation, Core build, Internal alpha, Closed beta, Public beta, AI pilot, Advanced modules, UAT, Conditional backlog or Spanning epic.                                                                                  |
| Workstream                                      | Product/architecture, identity/trust, Guilds, frontend/work, backend/capacity, Solana/finance, quality/UAT, operations/release, private access, teams/Challenges, discovery/promotions, AI, channels or advanced economy. |
| Priority                                        | P0 core invariant/release blocker, P1 primary delivery, P2 conditional later scope. Priority is not observed defect severity.                                                                                             |
| Owner role                                      | Blueprint AG responsibility and relevant reviewer/representative role. A role is not a named assignee.                                                                                                                    |
| Assignees                                       | Real people selected when work is committed; initially unassigned. Do not infer availability or assign somebody without a reason.                                                                                         |
| Estimate                                        | Relative planning points for tasks/decisions/gates, not hours or automatic capacity. Epics use child roll-up. Refine after inventory.                                                                                     |
| Sprint commitment                               | Forecast initially; change to Committed only after owner/capacity/dependencies agree. Use Stretch or Conditional backlog accurately.                                                                                      |
| Target release                                  | Foundation, Prototype, Alpha, Closed beta, Public beta/V1, V1.5, managed AI pilot, selected V2 or conditional later. This is not an enabled state.                                                                        |
| Start date / Target date                        | Forecast bounds of the weekly iteration; conditional backlog remains undated.                                                                                                                                             |
| Actual start / Actual finish                    | Actual dates only after work starts/finishes; initially empty.                                                                                                                                                            |
| Dependencies                                    | Human-readable predecessor IDs and issue references; native blocked-by links enforce navigation.                                                                                                                          |
| Blocked reason                                  | Names the missing predecessor or unresolved decision/gate. Clear it only after verified resolution.                                                                                                                       |
| Blueprint                                       | Required section references, preserving the canonical source.                                                                                                                                                             |
| Acceptance scenarios                            | Exact AC references and task acceptance criteria; actual results belong in Evidence.                                                                                                                                      |
| Requirement IDs                                 | Exact applicable R/P/D/I references; acceptance scenarios live in the issue body.                                                                                                                                         |
| Release gates                                   | Applicable G01–G10 references and feature-specific qualifications.                                                                                                                                                        |
| Repository / Parent issue / Sub-issues progress | GitHub’s built-in repository and actual issue hierarchy/progress; not manually fabricated.                                                                                                                                |
| Linked pull requests / Reviewers                | Actual implementation and review links as work proceeds.                                                                                                                                                                  |

## Testing, UAT and release fields

| Field             | Meaning and update rule                                                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| QA status         | Not started, In progress, Passed, Failed or Blocked. Passed requires actual relevant verification evidence against a named SHA/environment.                                     |
| UAT status        | Not required, Not started, Ready for UAT, In UAT, Passed, Failed, Blocked or Awaiting sign-off. UAT tasks start untested; failed critical journeys block affected promotion.    |
| UAT owner         | Named product/business reviewer and representative tester once selected. Initially the responsibility is unassigned, not a fictitious person.                                   |
| Environment       | Not selected, Local test, Staging, Test network, Pilot or Production. Pick the actual tested environment; UAT staging is a forecast until configured.                           |
| Evidence          | Test/review result, candidate SHA, fixture/network/provider version, sanitized screenshot/report and defect/retest links. Initially not recorded.                               |
| Severity          | Not assessed, Critical, High, Medium or Low observed defect impact. Initially Not assessed; do not equate every P0 planned task with an actual Critical bug.                    |
| Release readiness | Not assessed, Blocked, Ready for review, Approved or Not applicable. Approved requires relevant financial/access/operations/UAT and live gates, not compilation or a merged PR. |

## Weekly execution and workflow

1. Read the issue outcome and parent epic, then blueprint 00–04 and 13 plus the task’s required domains. Inspect actual code and shared contracts.
2. Review all blocked-by issues and OPEN policy dependencies. Assign a real owner, estimate the bounded scope and select only work that fits available weekly capacity.
3. Move Backlog/Blocked → Ready when predecessors are verified. Decisions use Needs decision until the project owner records the exact accepted policy.
4. Move Ready → In Progress while implementing the complete slice: server command, persisted contracts, UI/adverse states, migration and recovery as relevant.
5. Move to In Review only with a PR and meaningful actual QA evidence. Record the appropriate environment and keep private information out of artifacts.
6. For a user-facing release, link the corresponding UAT issue, arrange representative execution and product-owner sign-off. Technical QA and business acceptance remain separate.
7. Close as Done only when the assigned outcome and acceptance criteria have verified results, required review is recorded and the next-agent handoff is clear. Completion cannot grant production authority.
8. At Day 5, demo observed behavior, review defects/feedback, update dates/estimates and select the next five-day scope. Beta fixes outrank expansion.

## Alpha, beta and UAT schedule

| Weeks   | Stage                                              | User acceptance work                                                                                                                    |
| ------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| S01–S06 | Foundation/core build and test-network integration | Developers prove contracts, real DB races, launch/funding behavior and recovery before outside testers.                                 |
| S07–S08 | Internal alpha                                     | Internal founder/newcomer/specialist/operator journeys, accessibility, adversarial/recovery tests and blocker retests.                  |
| S09     | Closed beta week 1                                 | U001–U008: discovery, Guilds, launch/create/accept and onboarding with representative users.                                            |
| S10     | Closed beta week 2                                 | U009–U012: workspace, applicant/review/dispute/payment journeys; feedback closure and controlled V1/public-beta gate.                   |
| S11–S12 | Public beta and independent M6 pilots              | Continued core UAT; U013–U014 team/selection acceptance once feature QA/gates pass.                                                     |
| S13–S14 | Managed AI pilot                                   | Ordinary authorized review, operator capacity, isolation, budgets and cancellation evidence; repeat relevant UAT for AI-assisted users. |
| S15–S16 | Selected advanced modules and beta exit            | U015–U016 sponsorship/bids/operations plus approved channel/Role scenarios; final business sign-off for enabled scope.                  |

UAT does not authorize recruitment, funds, publication or deployment. A live beta needs all applicable G01–G10 evidence. If a stage fails, keep the current safe stage or disable affected capability and add a focused one-week stabilization sprint.

## Keeping the backlog current

[planning/raid-backlog.json](../planning/raid-backlog.json) holds stable IDs, developer scope, criteria and dependencies. [planning/raid-github-sync.json](../planning/raid-github-sync.json) maps them to actual issue/milestone numbers; [planning/raid-project-sync.json](../planning/raid-project-sync.json) records the actual Project and fields. These records contain no credentials. Use them to inspect/reconcile existing objects rather than duplicate issues.

When requirements change, follow blueprint section 40: update the canonical decision register and contracts/tests together, then update issue descriptions and forecast. When a sprint is rebaselined, align milestone dates, iteration dates and item forecast dates. Preserve accepted customer terms and immutable money/access history.

Detailed criteria and completion review: [agent task contracts](raid-agent-task-contracts.md). All 165 issues have individually numbered criteria and canonical requirement statements; missing evidence prevents valid completion.

## Detailed criteria and TDD fields

The Project now has 49 visible fields. **Criteria coverage** starts at zero reviewed criteria per task; update only from actual evidence. **Completion review** starts Not reviewed and becomes Needs changes, Blocked or Accepted through independent review. **Task contract** links to the numbered issue criteria. Every implementation change follows RED → GREEN → REFACTOR, with genuine failure/pass/regression evidence and full commit SHAs. Read [mandatory TDD and completion rules](raid-agent-task-contracts.md#mandatory-test-driven-development) before implementation.

Every internal feature, including authentication and sessions, must satisfy [the module reuse and adapter matrix](raid-module-reuse.md). Criteria C20/C21 require shared adapter tests, safe provider switching, same-change documentation and an independent consuming example. These are required development outcomes; existing features are not claimed compliant until verified.

[CI requirements for every feature](raid-ci-plan.md) · [Automatically refreshed epic/issue status](raid-project-status.md).

The **CI and test coverage** view shows **Required CI**, **CI status** and **CI evidence** for all 165 issues. Feature CI starts Not run; T005 remains Blocked for recorded baseline failures. Record actual check/artifact URLs and candidate SHA. [Project status](raid-project-status.md) updates automatically from GitHub issue closure/reopening and highlights incomplete epics.

## AI assignments

Every issue includes [model, effort, capacity and human responsibility recommendations](raid-agent-assignment.md). The Project exposes **AI suitability**, **Model recommendations** (Codex and Claude, effort and staffing). These recommendations retain the full TDD and review contract.

Open the [AI assignments view](https://github.com/orgs/solana-hackathon-1/projects/1/views/18) for per-issue models, effort and staffing, and the [CI and test coverage view](https://github.com/orgs/solana-hackathon-1/projects/1/views/17) for required checks and evidence.
