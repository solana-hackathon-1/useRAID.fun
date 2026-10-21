# Protected evaluator case HTTP

This bounded T013 interface supplies the case-reading prerequisite for the evaluator screen. It exposes the existing current, explicitly assigned, audited private review reader. R06/R11/R12/R15/R16, I05/I06/I10/I11/I13 and blueprint sections 07/08/13/24/26/28 apply. See [storage authority and audit contract](raid-practice-review-reads.md) and [task/evidence scope](tasks/2026-10-21-T013-review-http.md). Independent review, UAT, operating approval and full T013 acceptance remain NOT VERIFIED.

## Route and response

`GET /api/v1/practice/reviews/{assignmentId}/submissions/{submissionId}?purpose=OWNERSHIP_REVIEW`

Both path IDs must be UUIDs. Exactly one `purpose` query field is required, using the existing `OWNERSHIP_REVIEW` or `ASSESSMENT_REVIEW` contract. Unknown or repeated fields fail422; callers cannot supply actor IDs, policy flags or authorization. GET reads have no business command/body/CSRF intent; audit records an access attempt. Root supplies no cross-origin permission. Cookies and existing same-origin browser confidentiality remain required; a read result never grants authority for a later action.

Successful JSON has `version: v1`, `readsAvailable: true`, `unavailableReason: null`, and `review` validated by the canonical `PracticeReviewReadRecordSchema`. It contains the original full definition/rubric, exact saved answer/explanation/tool and AI declarations, historical assignment and server-generated access correlation. Submission ownership remains UNCONFIRMED. Literal code/HTML is JSON data, never executed or fetched. A future screen must render it as escaped text, without public metadata, previews, logging or analytics.

All handler responses, including errors, carry `Cache-Control: private, no-store` and `Vary: Cookie`. Missing authentication401, restricted/forbidden403, rate limit429, malformed input422, unavailable/denied case404, disabled or invalid storage/host503. Error envelopes contain only canonical safe messages and request correlation, never callback/driver diagnostics or private text. Null case output hides whether an assignment/submission exists. Unexpected, excessive or inconsistent host output fails closed503; returned evaluator, assignment, submission and purpose must match the actual actor and requested target. Schema validation alone is not authorization.

## Replaceable host

`src/skills/practice-review-http.ts` exports `createPracticeReviewHandlers`, `PracticeReviewHttpHost`, `PracticeReviewHttpError` and private response headers. It uses Web Request/Response, Zod and the declared canonical storage/contracts dependency tree; it is server-only (storage uses Node crypto), with no Next, Prisma or Root auth dependency. The host supplies:

- `version: v1` and an opaque `requestId()`; malformed/throwing correlation callbacks fall back to a generated UUID.
- `actor()` resolving the actual current account/session hash. Authentication errors use typed401/403/429.
- `rateLimit(actor)` enforcing the current account quota before private storage.
- `read(actor, input)` returning the existing v1 storage-host envelope **after its transaction commits**. It owns current actor/assignment/purpose/policy/expiry/revocation checks, audit-before-body, post-wait rechecks, rollback and whole-transaction retries. The HTTP validator cannot certify those host responsibilities.

Root `src/lib/practice-review-http.ts` resolves `requireUser()` plus hashed actual session cookie, limits `practice-review:{accountId}` to30 requests/60 seconds using the existing limiter, and calls `readPracticeTrialForReviewFromHost`. An ordinary current evaluator needs the actual finite assignment; admin role alone confers no case access. Root Node route is explicitly dynamic. `PRACTICE_REVIEW_READS_ENABLED` retains its existing exact-true/default-off/current-recheck behavior. No flag or real appointment is enabled here. No schema/migration, new business event, assessment, access grant, capacity, money or external provider effect.

The [separately installable PostgreSQL example](../examples/practice-review-reads/README.md) now consumes the HTTP handler with its own dependencies and actual synthetic persisted cases. It verifies commit-before-delivery, original bytes/rubric, admin-without-assignment and wrong-purpose denial, disabled reads, authentication and actual saved revocation. Existing reader tests verify audit-before-body and expiry/revocation while SQL waits; adapter tests verify Root cookie/rate/route composition. The example invokes Web handlers directly; it is not a deployed browser or real-provider test.

Rollback disables review reads and retains immutable cases, appointments/revocations, receipts/audits and separate owner-only submission access. Revocation cannot recall material already disclosed. The evaluator screen, review submission API, notice/appeal model, calibration/retention policy and independent/UAT/release acceptance remain subsequent work.
