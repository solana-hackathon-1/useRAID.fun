# T013 — protected administrator issue/revoke practice-review assignment HTTP

Claude sole writer on `claude/t013-practice-trial-ui` over uncommitted Codex work (HEAD 1877b2a). Owner direction 2026-10-21: "continue with the admin issue/revoke route, review-and-commit then" (commit authority for this bounded change only; no push/merge). SELF-EVALUATED; full T013, independent review, hosted Node 22 CI, UAT, operating and release remain NOT VERIFIED.

Outcome: an X-authenticated administrator can issue and revoke finite practice-review appointments over HTTP using the existing transaction-held storage commands. No new appointment policy, schema, real appointment, flag default, rank, grant, capacity, money or provider effect.

Mapping: R04/R06/R11/R12/R15/R16/I05/I10/I11/I13; D07/D08; blueprint 07, 08.3, 10, 26.1–26.4, 28.1, 29.3–29.4, 33.4–5, AC04–07, AC42–43, AC73–75. Existing entities: `PracticeTrialReviewAssignment`, `PracticeTrialReviewRevocation`, `CommandReceipt`, `AuditEvent`. Existing authority: `issuePracticeReviewAssignment` / `revokePracticeReviewAssignment` (admin role + X session + `adminXIds` + subject≠evaluator + `PRACTICE_REVIEW_ASSIGNMENTS_ENABLED === 'true'`) — HTTP adds no authority of its own, only a pre-check that mirrors the taxonomy admin routes.

Acceptance (defined before implementation):

- `POST /api/v1/admin/practice/review-assignments` issues; `POST /api/v1/admin/practice/review-assignments/{assignmentId}/revocations` revokes. No GET/HEAD/PATCH/DELETE and no generic state setter.
- Order: origin check → actual X-admin actor → per-account rate limit → path/query → `Idempotency-Key` → origin-first bounded JSON (≤16 KiB) → strict `v1` input → committed host command. Query strings, unknown fields, wrong version, bad key, path/body id mismatch are 422 before any host call.
- Response is private/no-store/`Vary: Cookie`, strict `v1` result, bound to the request: issue echoes submission/evaluator/purpose/expiry/reason and `issuedByAccountId === actor`; revoke echoes assignment id/reason and `revokedByAccountId === actor`. Any mismatch or malformed host result fails closed as 503, never a success.
- Typed denials: 401/403/429 from Root authority; storage `INVALID_INPUT`/`EXPIRY_INVALID`→422, `AUTHENTICATION_REQUIRED`→401, `ACCOUNT_RESTRICTED`/`FORBIDDEN`/`SELF_REVIEW_FORBIDDEN`→403, `RESOURCE_UNAVAILABLE`→404, `ALREADY_REVOKED`→409, `IDEMPOTENCY_KEY_REUSED`→409, `WRITES_DISABLED`/storage faults/unknown→503. Messages come from the protocol contract only; no driver text, ids or SQL leak.
- Retry with the same key replays the original result (storage receipt); a different body with the same key is 409.
- Root adapter: `requireUser(true)` + `adminXIds()` membership + live cookie hash, rate key `practice-review-assignments:<account>` 30/60; wallet-only, non-admin, suspended and missing-cookie sessions denied.
- Genuine failing-first transport and Root tests; existing storage/host tests reused (unchanged). R15/R16: module guide updated, consuming-host example extended and independently installed.

Check selection: new transport + Root unit tests; existing assignment storage/host/DB tests reused only if their source is unchanged; types, owned lint/format, planning, docs tests. Full parent suite not claimed. Task-owned servers/containers stop after use.
