# Local implementation test center — 10 October 2026

Owner requested the UI needed to test implemented issues. Bounded support for T004/T045,
not full acceptance of either issue or of the underlying T001–T006/T019/T029 tasks.
Status: IMPLEMENTED_UNVERIFIED for independent acceptance; author browser verification recorded below.

Delivered `/test-center`, gated by the existing server demo/sandbox policy, with dated issue coverage,
browser/backend filters, links and instructions for existing campaign fixtures, and real pure
T002/T029 amount/capacity explorers. No additional-wallet command, new business API, schema or migration.
Existing Account remains legacy wallet/X UI. T006 B2 review, revoke/session invalidation/audit, owner
decisions and B3 UI remain open; wallet linking stays off.

Maps R15/R16, I03/I05/I06/I10/I12/I13, AC29/AC69/AC70/AC74/AC75,
blueprint §§07/13/16.2–16.3/23/24/28/33.4/34.1/35/39–40.
Affected records: none from new filters/explorers; existing sandbox session, campaign, balance,
allocation and transfer APIs retain their existing origin/actor/mode checks. Pure selectors do not
reserve capacity, authorize state transitions, verify a mint, or change amounts in storage.
The fixture login is not proof of cryptographic or connected-X session authority.

## Source and verification

Implementation began on main `66d6a3a`; preserved existing edits and recorded a baseline in
`/tmp/raid-test-center-20261010/preexisting.patch` and `preexisting-status.txt`.
An owner-directed collaborator later advanced main to `736964c` while retaining the uncommitted UI
and backend work. Earlier results below apply to the earlier source; the current regression is recorded separately.
No branch, commit, push, merge, board or live-enable action was performed by this UI task.

| Check                            | Actual result                                                                          | Evidence                                                                                                     |
| -------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| RED before UI implementation     | Four desktop behavior failures: missing center/controls; no import or setup failure    | [RED](../../planning/task-evidence/local-test-center-20261010/red.log)                                       |
| GREEN                            | Eight desktop/mobile checks passed                                                     | [GREEN](../../planning/task-evidence/local-test-center-20261010/green.log)                                   |
| Earlier Studio regression        | 52 passed, no skips/failures, including campaign/review/payment                        | [Earlier regression](../../planning/task-evidence/local-test-center-20261010/regression-before-incoming.log) |
| Pure-helper / shell regression   | Three suites, 75 passed                                                                | [Unit regression](../../planning/task-evidence/local-test-center-20261010/unit-regression.log)               |
| Earlier planning checks          | 32 passed before collaborator's new planning cases                                     | [Earlier planning](../../planning/task-evidence/local-test-center-20261010/planning-before-incoming.log)     |
| Independent installed React host | Own dependency install and real component render passed without Next/DB/credentials    | [Consumer](../../planning/task-evidence/local-test-center-20261010/consumer.log)                             |
| Preview access / keyboard        | Disabled mode renders no controls/cards; API 404; keyboard filter and field order work | [Boundary](../../planning/task-evidence/local-test-center-20261010/boundary-keyboard.log)                    |
| T006 acceptance guard            | Validator exit 1, all 27 criteria NOT VERIFIED                                         | [Guard](../../planning/task-evidence/local-test-center-20261010/t006-validator-before-incoming.log)          |

The first access probe incorrectly assumed an HTTP 404 for the streamed page and stopped at actual
HTTP 200. Installed Next documentation explains streamed not-found responses; the follow-up verifies
the real denied page, absent controls/cards and noindex, plus HTTP 404 from the existing sandbox API.
No source permission check or behavior test was weakened; usage documentation was corrected.
Typecheck, scoped lint (zero errors/warnings after documenting portable-anchor routing) and scoped
format checks passed. Production build, hosted CI, independent criterion review and representative
UAT were not run for this UI extension. Final current-source checks/manifests are in its verification JSON.

## Preview and reuse

[Open the test center](http://localhost:3007/test-center), then **Enter test Creator Studio**.
Task-owned preview originally started in this checkout, Next process session 54077, loopback3007;
later collaborator reused it. Keep it running for owner inspection. Dedicated tmpfs PostgreSQL
container `raid-ui-test-center-20261010`, ID `7d42a39d118528322e0369afb37cb6eea3d7fdbf804b91c3c03c9f0fff9a2a7e`,
loopback55479, `useraid_studio_test`, image `sha256:ef738a34a8651d11b2bace81c55c7e2187f786b484add6c83070884340074368`.
Fresh bootstrap applied all22 migrations. Existing Compose DB and previous resources were untouched.
Temporary disabled-mode probe used port3009 and output directory `.next-db-down`; generated
`next-env.d.ts` changed with Next's output directory and was retained as generated state.
Exact current PID/stop instructions are in the checkpoint. Do not stop an unrelated replacement listener.

The [component contract](../raid-test-center.md) and [minimal consuming host](../../examples/test-center/README.md)
declare routing/style/optional-action responsibilities and dependencies. The example was copied with
symlinks dereferenced to `/tmp/raid-test-center-20261010/consumer`, installed its own10 packages and
ran `npm start`; the final component copy was refreshed before its final execution.

Relevant command: `DATABASE_URL=postgresql://useraid:useraid@127.0.0.1:55479/useraid_studio_test npx playwright test --config=playwright.studio.config.ts`.
This URL uses synthetic disposable test credentials only. The existing launcher is bypassed by reusing
the running preview, so it does not prepare the Compose database.

## Acceptance obligations

C01–C03: bounded testing support, recorded canonical authority and no new canonical entities.
C04/C09/C14: preview mode checked server-side; existing action APIs retain authorization; no private
backend DTO or secrets serialized. C05–C08/C10–C12: no new business transition, financial effect,
external operation, capacity reservation, concurrency or idempotency command is claimed.
C13/C16: executed browser/helper/host checks and failures above. C15: preview-only, no migration
or production enablement. C18–C21: checkpoint, genuine behavior RED/GREEN/regression, existing pure
helper reuse and consuming-host docs provided. C17/C22 and independent disposition of every
applicable criterion remain NOT VERIFIED: no representative UAT, current full CI or independent acceptance.

Next: retain preview for the owner; obtain separately authorized independent UI review if needed.
Continue the frozen B2 security review only when assigned; this support UI does not waive that gate.
