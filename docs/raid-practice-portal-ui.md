# Practice trial portal UI (T013)

Browser surface over the protected [practice portal API](raid-practice-portal.md): `/raider/practice` (browse and start) and `/raider/practice/[startId]` (original terms, private submission, saved result). Requirements: R06/R12/R15/R16/I05/I06/I07/I10, blueprint §08.3–08.5, AC03/AC05/AC06/AC73–75.

## What it does and does not do

- Shows each available trial's saved terms exactly (brief, materials, tools/AI policy, rubric, pass conditions, attempt limits, accommodation text). `expectedMinutes` is shown as an expectation, never a deadline. Accommodations are not selectable here (the API only supports `accommodationReference: null`).
- Start posts the exact definition reference with a stable `Idempotency-Key`; an unconfirmed result keeps the key and offers **Retry start**. Submit does the same and offers **Check saved status** that adopts an already-saved submission.
- Practice never verifies a skill, rank, access grant, capacity or money; the client contracts keep those flags literally `false` and fail closed. Submitted work is shown as unreviewed with unconfirmed ownership.
- Retired or changed trials are not offered for new starts; an accepted attempt keeps its original terms and stays submittable/readable.
- All saved text is rendered as escaped text. Submission answers are private to the owner; foreign/malformed attempt ids render the repository's soft not-found (root `loading.tsx` streams first, so the page status is 200; the API returns the hard 404).

## Modules

| Path                                       | Role                                                                                                                                                                                                                               |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/skills/practice-portal-client.ts`     | Portable DTO schemas (parity-tested against server schemas), `buildSubmitInput`, `describePracticeFailure`, injectable `PracticePortalTransport` + default same-origin fetch transport. Imports only zod and owned pure contracts. |
| `src/components/practice-trial-portal.tsx` | `PracticeTrialCatalog`, `PracticeTrialWorkspace` (client components; React + the client module only).                                                                                                                              |
| `src/lib/practice-portal-page.ts`          | Host loaders for the pages (current session, read gate, no error detail).                                                                                                                                                          |
| `src/app/raider/practice/**`               | Next.js pages.                                                                                                                                                                                                                     |
| `examples/practice-trial-portal/`          | Independent consuming host (declared deps, injected transport, no network).                                                                                                                                                        |

## Host contract

Supply server-read `initial` data for the configured taxonomy plus `readsAvailable`/`writesAvailable` (from `PRACTICE_PORTAL_READS_ENABLED`+`PRACTICE_TRIAL_CATALOG_ID`, `PRACTICE_TRIAL_ATTEMPTS_ENABLED`, `PRACTICE_TRIAL_SUBMISSIONS_ENABLED`; all default off). Authorization, origin, rate limit and receipts remain server-side in the API; the UI is not authority. Inject `api` to use another transport.

## Verification

`tests/practice-trial-portal-client.test.ts`, `-ui.test.ts`, `-page.test.ts`, `-host.test.ts`; Playwright `playwright.practice-portal.config.ts` (synthetic PostgreSQL, desktop + mobile, dev and production servers) with `DATABASE_URL` pointing at a local `useraid_test` database. Limitations: no independent review, UAT or hosted CI recorded; no real Phantom/X; flags stay off in deployed environments.
