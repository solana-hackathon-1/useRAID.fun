# RAID delivery plan verification

[Two-week sprint and alpha/beta plan](raid-sprint-plan.md) · [Master timeline](raid-delivery-timeline.md) · [Phase checklists](raid-development-phases.md) · [Coverage register](raid-delivery-coverage.md)

Prepared 6 October 2026. Scope: documentation only, planned against `main` baseline `2bd3312`. No application feature, paid operation, deployment, external provider test or beta recruitment was performed by this planning task. Historical application test results remain in [verification.md](verification.md).

## Review scope

The review checks the schedule against blueprint sections 00–04, 13, 33–35 and 38–40, relevant domain/finance/access rules, actual source/schema/CI infrastructure and the user's two-week alpha/beta request.

| Review                   | Expected coverage                                                                                                      |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Blueprint domains        | All 42 numbered sections mapped to delivery or recurring use.                                                          |
| Requirement groups       | R01–R14, P01–P08, D01–D13, I01–I12 individually assigned.                                                              |
| Behavior evidence        | AC01–AC72 individually scheduled; actual application results remain PENDING.                                           |
| Decisions and enablement | O01–O19 owners/target deadlines; G01–G10 feature gates.                                                                |
| User flows               | All 16 screen contracts; loading/error/empty/stale and accessible journeys.                                            |
| Delivery schedule        | Eight ten-working-day sprints; dated milestone dependencies and testing windows.                                       |
| Test stages              | S4 internal alpha, S5 invited closed beta, S6–S8 public beta and independent feature pilots.                           |
| State and authority      | Immutable terms, canonical single capacity, exact assets, explicit grants and separate financial/work state preserved. |

## Executed documentation checks

| Check executed                                                                           | Result                                                                                                             |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Existing `tests/docs-links.test.ts` via `npx vitest run tests/docs-links.test.ts`        | 27/27 passed: local links/anchors, documented npm scripts and existing release-policy assertions.                  |
| Targeted `npx prettier --check` on README, blueprint map and the five new plan documents | Passed.                                                                                                            |
| `git diff --check`                                                                       | Passed.                                                                                                            |
| Coverage row audit against canonical IDs                                                 | All 42 numbered sections; 14 R, 8 P, 13 D, 12 I, 72 AC, 19 O and 10 G rows; no missing IDs.                        |
| Milestone/sprint structure audit                                                         | Nine M0–M8 phase contracts and eight S1–S8 sprint sections.                                                        |
| Calendar review                                                                          | 80 weekdays from 7 October 2026 to 26 January 2027; milestone and alpha/beta windows agree with sprint board.      |
| GitHub Markdown API, GFM mode with repository context                                    | README, index and all five plan documents rendered successfully to HTML.                                           |
| Chromium desktop (1440px) and mobile (390px) review                                      | Titles, tables and scrollable mobile tables render; 81 phase task checkboxes and 8 coverage checkboxes recognized. |
| Mermaid browser render and visual inspection                                             | Both Gantt and dependency diagrams rendered as SVG; timeline and sprint-page screenshots inspected.                |

No application test suite, database migration, production build or external financial/provider operation was executed for this documentation-only change. Those remain planned gates with their own required evidence.

## Rendering scope

GitHub-friendly Markdown uses standard headings, relative links, tables, task lists and fenced Mermaid Gantt/dependency diagrams. Render validation used GitHub’s Markdown API HTML, GitHub Markdown CSS, Mermaid 11.17.2 and an available local headless Chromium through Playwright. The API identifies both fences as Mermaid enrichment containers; the local browser rendered and inspected their SVG output. This verifies syntax and presentation, not an authenticated screenshot of GitHub’s private-repository UI. Table fallbacks provide the timeline and dependencies if a reader disables diagram rendering. GitHub deployment checks are separate from Markdown rendering and document correctness.

## Planning limits

Dates use an illustrative 7 October kickoff, four contributors and weekday-only capacity. Provider/custody/finality/terms decisions and assurance can move dependent milestones. Cohort sizes and schedule buffers are proposals, not approved commercial limits. Stage promotion requires evidence and a recorded go/no-go; no sprint automatically becomes live-enabled.
