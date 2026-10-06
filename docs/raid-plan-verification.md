# RAID delivery plan verification

[One-week sprint and alpha/beta plan](raid-sprint-plan.md) · [Master timeline](raid-delivery-timeline.md) · [Phase checklists](raid-development-phases.md) · [Coverage register](raid-delivery-coverage.md)

Prepared 6 October 2026. Scope: documentation only, planned against `main` baseline `9ffe5b8`. No application feature, paid operation, deployment, external provider test or beta recruitment was performed by this planning task. Historical application test results remain in [verification.md](verification.md).

## Review scope

The review checks the schedule against blueprint sections 00–04, 13, 33–35 and 38–40, relevant domain/finance/access rules, actual source/schema/CI infrastructure and the user's one-week sprint request, dedicated alpha/beta windows and full GitHub Project scope.

| Review                   | Expected coverage                                                                                                      |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Blueprint domains        | All 42 numbered sections mapped to delivery or recurring use.                                                          |
| Requirement groups       | R01–R14, P01–P08, D01–D13, I01–I12 individually assigned.                                                              |
| Behavior evidence        | AC01–AC75 individually scheduled; actual application results remain PENDING.                                           |
| Decisions and enablement | O01–O19 owners/target deadlines; G01–G10 feature gates.                                                                |
| User flows               | All 16 screen contracts; loading/error/empty/stale and accessible journeys.                                            |
| Delivery schedule        | Sixteen five-working-day sprints; dated milestone dependencies and testing windows.                                    |
| Test stages              | S07–S08 internal alpha, S09–S10 invited closed beta, S11–S16 public beta and independent feature pilots.               |
| State and authority      | Immutable terms, canonical single capacity, exact assets, explicit grants and separate financial/work state preserved. |

## Executed documentation checks

| Check executed                                                                                      | Result                                                                                                             |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Existing `tests/docs-links.test.ts` via `npx vitest run tests/docs-links.test.ts`                   | 39/39 passed: local links/anchors, documented npm scripts and existing release-policy assertions.                  |
| Targeted `npx prettier --check` on README, blueprint map and the all delivery/project/UAT documents | Passed.                                                                                                            |
| `git diff --check`                                                                                  | Passed.                                                                                                            |
| Coverage row audit against canonical IDs                                                            | All 42 numbered sections; 16 R, 8 P, 13 D, 13 I, 75 AC, 19 O and 10 G rows; no missing IDs.                        |
| Milestone/sprint structure audit                                                                    | Nine M0–M8 phase contracts and sixteen S01–S16 sprint sections.                                                    |
| Calendar review                                                                                     | 80 weekdays from 7 October 2026 to 26 January 2027; milestone and alpha/beta windows agree with sprint board.      |
| GitHub Markdown API, GFM mode with repository context                                               | README, index and all nine delivery/project/UAT documents rendered successfully to HTML.                           |
| Chromium desktop (1440px) and mobile (390px) review                                                 | Titles, tables and scrollable mobile tables render; 81 phase task checkboxes and 8 coverage checkboxes recognized. |
| Mermaid browser render and visual inspection                                                        | Both Gantt and dependency diagrams rendered as SVG; timeline and sprint-page screenshots inspected.                |

No application test suite, database migration, production build or external financial/provider operation was executed for this documentation-only change. Those remain planned gates with their own required evidence.

## GitHub Project verification

The organization Project is linked directly to `solana-hackathon-1/useRAID.fun`. It contains 165 issues, 16 native weekly iterations and repository milestones, 44 fields and 16 views including priority board, P0 triage, sprint board, two roadmaps, UAT board and business acceptance. Readback verified 164 native parent/sub-issue links and 383 blocked-by links against the manifest. The coverage index maps all 42 sections and 219 subsections. QA/UAT results begin untested; actual start/finish dates are empty. The API cannot configure or verify the roadmap date-axis picker; the guide documents the Start date/Target date selection. API readback verifies available configuration and values; this is not an authenticated screenshot of the private Project UI.

## Rendering scope

GitHub-friendly Markdown uses standard headings, relative links, tables, task lists and fenced Mermaid Gantt/dependency diagrams. Render validation used GitHub’s Markdown API HTML, GitHub Markdown CSS, Mermaid 11.17.2 and an available local headless Chromium through Playwright. The API identifies both fences as Mermaid enrichment containers; the local browser rendered and inspected their SVG output. This verifies syntax and presentation, not an authenticated screenshot of GitHub’s private-repository UI. Table fallbacks provide the timeline and dependencies if a reader disables diagram rendering. GitHub deployment checks are separate from Markdown rendering and document correctness.

## Planning limits

Dates use an illustrative 7 October kickoff, four contributors and weekday-only capacity. Provider/custody/finality/terms decisions and assurance can move dependent milestones. Cohort sizes and schedule buffers are proposals, not approved commercial limits. Stage promotion requires evidence and a recorded go/no-go; no sprint automatically becomes live-enabled.

## Detailed contracts, TDD and reuse review

All 165 issue descriptions now have 4,328 numbered criteria, source-hashed requirement statements, explicit domain entities/permission/state/recovery bindings and required completion evidence. Three new Project fields track criterion coverage, independent completion review and the exact task-contract URL. Canonical R15/R16/I13 and AC73–AC75 record the owner’s replaceable integration, reusable internal feature/documentation and test-driven development requirements. Auth is explicitly included.

Completion validator tests demonstrated RED failures for invalid TDD SHA and false acceptance-first flag, then GREEN with both gaps fixed. Canonical/packet tests demonstrated RED for missing owner requirements and explicit auth scope, then GREEN after recording them. The Python review suite has 17 passing tests; these validate planning/completion rules and do not assert application modules are implemented. Completion validation checks evidence structure; independent reviewers must verify the actual reports. GitHub issue-closing permission is not technically removed by these documents.

## Repository-wide checks and existing blockers

The complete `npm run format:check` passes after normalizing canonical blueprint Markdown. `npm run lint` passes with 24 existing warnings. `npm run typecheck` fails in existing generated `.next-db-down` types and existing TypeScript test/Prisma JSON typing; this change edits no application TypeScript, Prisma schema or dependency manifest. `npm run audit:check` fails on existing dependencies: high `braces` GHSA-vfj7-8cjw-p6xm, high `source-map-js` GHSA-68fv-2mgg-jv7q, moderate `stream-json` GHSA-hqr4-qq8f-hg3x and GHSA-mjw6-4jj6-33hc. Package manifests/lockfile are unchanged.

These failures remain tracked under T005 baseline CI repair and prevent claiming repository-wide verification or live release readiness. No test, policy assertion or audit allowlist was weakened to manufacture a passing result.

A further RED/GREEN regression proves the completion validator rejects deletion of a mandatory core contract even when the report also omits it. CI also checks that the registry covers the entire backlog and every packet retains C01–C21.

## CI coverage and issue status automation

C22 adds required CI coverage to every task: 4,493 total criteria. The Project has 49 visible fields and a CI/test coverage view. The CI feature matrix inventories 66 current test files across all 23 epics and explicitly records missing domain coverage. Dependency security runs independently; all database suites emit JUnit; Studio browser coverage is included; the final gate rejects failure, cancellation and skipped required jobs.

The status generator tracks actual GitHub epic/issue states, remaining children, next candidates and unknown/deleted issues. Regression tests cover incomplete epic closure, full closure and reopening a predecessor. The issue-event/daily workflow updates only the status document; manual GitHub closure still does not prove acceptance or live readiness. Local checks: 45 documentation tests, 27 Python tests, meaningful RED/GREEN CI-evidence regressions, JUnit report generation and whole-repository formatting. Previously documented app typecheck/audit gaps remain T005 blockers.

## AI model and capacity recommendations

All 165 issues have a proposed AI suitability, Codex and Claude model/effort, relative story-point estimate, staffing recommendation and human responsibility. Decision/release authority and representative UAT acceptance remain human. The model/effort registry test ran RED before the registry existed, then GREEN after complete mapping. Model names/settings were checked against current official guidance and the local Codex catalogue. These recommendations do not prove task completion or reserve runtime capacity. The Project uses one combined model field because GitHub rejected an additional field at its 50-field limit (49 fields are exposed by the API).

A RED/GREEN regression also rejects mixed CI candidate SHAs, preventing successful checks from different revisions being combined into one completion report.

The first hosted run caught missing Compose setup for the newly included Studio suite. A RED/GREEN CI contract regression now checks a separate test database/port, inherited Compose project/files and guaranteed cleanup. The automatic status workflow succeeded and wrote bot commit 2836c07 to main; only the status document changed.
