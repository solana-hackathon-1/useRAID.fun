# RAID delivery plan verification

[One-week sprint and alpha/beta plan](raid-sprint-plan.md) · [Master timeline](raid-delivery-timeline.md) · [Phase checklists](raid-development-phases.md) · [Coverage register](raid-delivery-coverage.md)

Prepared 6 October 2026. Scope: documentation only, planned against `main` baseline `9ffe5b8`. No application feature, paid operation, deployment, external provider test or beta recruitment was performed by this planning task. Historical application test results remain in [verification.md](verification.md).

## Review scope

The review checks the schedule against blueprint sections 00–04, 13, 33–35 and 38–40, relevant domain/finance/access rules, actual source/schema/CI infrastructure and the user's one-week sprint request, dedicated alpha/beta windows and full GitHub Project scope.

| Review                   | Expected coverage                                                                                                      |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Blueprint domains        | All 42 numbered sections mapped to delivery or recurring use.                                                          |
| Requirement groups       | R01–R14, P01–P08, D01–D13, I01–I12 individually assigned.                                                              |
| Behavior evidence        | AC01–AC72 individually scheduled; actual application results remain PENDING.                                           |
| Decisions and enablement | O01–O19 owners/target deadlines; G01–G10 feature gates.                                                                |
| User flows               | All 16 screen contracts; loading/error/empty/stale and accessible journeys.                                            |
| Delivery schedule        | Sixteen five-working-day sprints; dated milestone dependencies and testing windows.                                    |
| Test stages              | S07–S08 internal alpha, S09–S10 invited closed beta, S11–S16 public beta and independent feature pilots.               |
| State and authority      | Immutable terms, canonical single capacity, exact assets, explicit grants and separate financial/work state preserved. |

## Executed documentation checks

| Check executed                                                                                      | Result                                                                                                             |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Existing `tests/docs-links.test.ts` via `npx vitest run tests/docs-links.test.ts`                   | 35/35 passed: local links/anchors, documented npm scripts and existing release-policy assertions.                  |
| Targeted `npx prettier --check` on README, blueprint map and the all delivery/project/UAT documents | Passed.                                                                                                            |
| `git diff --check`                                                                                  | Passed.                                                                                                            |
| Coverage row audit against canonical IDs                                                            | All 42 numbered sections; 14 R, 8 P, 13 D, 12 I, 72 AC, 19 O and 10 G rows; no missing IDs.                        |
| Milestone/sprint structure audit                                                                    | Nine M0–M8 phase contracts and sixteen S01–S16 sprint sections.                                                    |
| Calendar review                                                                                     | 80 weekdays from 7 October 2026 to 26 January 2027; milestone and alpha/beta windows agree with sprint board.      |
| GitHub Markdown API, GFM mode with repository context                                               | README, index and all nine delivery/project/UAT documents rendered successfully to HTML.                           |
| Chromium desktop (1440px) and mobile (390px) review                                                 | Titles, tables and scrollable mobile tables render; 81 phase task checkboxes and 8 coverage checkboxes recognized. |
| Mermaid browser render and visual inspection                                                        | Both Gantt and dependency diagrams rendered as SVG; timeline and sprint-page screenshots inspected.                |

No application test suite, database migration, production build or external financial/provider operation was executed for this documentation-only change. Those remain planned gates with their own required evidence.

## GitHub Project verification

The organization Project is linked directly to `solana-hackathon-1/useRAID.fun`. It contains 165 issues, 16 native weekly iterations and repository milestones, 41 fields and 16 views including priority board, P0 triage, sprint board, two roadmaps, UAT board and business acceptance. Readback verified 164 native parent/sub-issue links and 383 blocked-by links against the manifest. The coverage index maps all 42 sections and 216 subsections. QA/UAT results begin untested; actual start/finish dates are empty. The API cannot configure or verify the roadmap date-axis picker; the guide documents the Start date/Target date selection. API readback verifies available configuration and values; this is not an authenticated screenshot of the private Project UI.

## Rendering scope

GitHub-friendly Markdown uses standard headings, relative links, tables, task lists and fenced Mermaid Gantt/dependency diagrams. Render validation used GitHub’s Markdown API HTML, GitHub Markdown CSS, Mermaid 11.17.2 and an available local headless Chromium through Playwright. The API identifies both fences as Mermaid enrichment containers; the local browser rendered and inspected their SVG output. This verifies syntax and presentation, not an authenticated screenshot of GitHub’s private-repository UI. Table fallbacks provide the timeline and dependencies if a reader disables diagram rendering. GitHub deployment checks are separate from Markdown rendering and document correctness.

## Planning limits

Dates use an illustrative 7 October kickoff, four contributors and weekday-only capacity. Provider/custody/finality/terms decisions and assurance can move dependent milestones. Cohort sizes and schedule buffers are proposals, not approved commercial limits. Stage promotion requires evidence and a recorded go/no-go; no sprint automatically becomes live-enabled.
