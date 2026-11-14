# Skill-assessment appeals and independent adjudication

## Purpose and status

T014 / [#357](https://github.com/solana-hackathon-1/useRAID.fun/issues/357), blueprint 09.7 (with 08.6, 09.4, 17.4), under R15/R16, I07/I10 and [DEC-2026-11-13-12](../RAID_AGENT_BLUEPRINT.md#0222-owner-delegated-decisions--13-november-2026) as confirmed by DEC-2026-11-14-11. A participant may appeal the current decided version of their own skill assessment once; an independent adjudicator decides it once. **Default-off** behind `SKILL_ASSESSMENT_APPEALS_ENABLED`. Status: implemented and tested against real PostgreSQL; UAT, the fresh-review reopening, the adjudicator case view and the owner's confirmation of the provisional windows are **NOT VERIFIED / not delivered** (see Boundaries).

An appeal moves no money and creates no permission, capacity or rank. It never edits `SkillAssessment` or `SkillAssessmentVersion`: the appealed decision stays in effect while pending, after a denial, and after an upheld appeal until a fresh review separately issues a new version. Nothing here grants a rank automatically.

## Decisions applied (provisional values marked)

| Decision                                                       | Where it lives                                                                                                                                                                                                  |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Adjudicator on a dedicated allowlist, flag default off         | `SKILL_APPEAL_REVIEWER_ACCOUNT_IDS` (host, read per call; empty denies everyone) and `SKILL_ASSESSMENT_APPEALS_ENABLED` (exact `true`)                                                                          |
| Not the appellant, not an original reviewer, no Guild conflict | `evaluateAppealAdjudicator` (pure) applied under the locks in `adjudicateSkillAssessmentAppeal`; the appellant and original-reviewer rules are also enforced by a database trigger                              |
| **Provisional** 14-day filing window                           | `filingWindowSeconds`, host reads `SKILL_APPEAL_FILING_WINDOW_DAYS` (1-365, malformed uses 14); measured from the version's `issuedAt` (the decision time; no separate notice record exists) and stored per row |
| **Provisional** 14-day adjudication target                     | `adjudicationSeconds`, host reads `SKILL_APPEAL_ADJUDICATION_DAYS`; stored as `adjudicationDueAt`. Overdue appeals stay pending (never an automatic outcome)                                                    |
| Upheld reopens for a fresh review, grants nothing              | decision row records `freshReviewExcludedAccountIds` (every original evaluator); the assessment is untouched                                                                                                    |
| One appeal per decided version; a denial is final              | unique `assessmentVersionId`; one decision per appeal; both tables are append-only                                                                                                                              |
| Closed category list, no `OTHER`                               | `ASSESSMENT_APPEAL_REASON_CATEGORIES` (checked again by a database constraint)                                                                                                                                  |

## Interface

`src/skill-appeals/` (storage in `storage.ts`, contracts in `contracts.ts`, pure rules in `policy.ts`, transport in `http.ts`):

| Function                                                                                      | Authority                                                                                                                                  |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `fileSkillAssessmentAppeal(tx, {actor, input, idempotencyKey, requestId}, options)`           | the signed-in HUMAN participant who owns the assessment; the named reference must be the assessment's current version (`REVISION_CHANGED`) |
| `adjudicateSkillAssessmentAppeal(tx, {actor, input:{appealId, outcome, reason}, …}, options)` | a live session on the host allowlist who passes the independence rules; `UPHELD` or `DENIED`, once                                         |
| `listOverdueSkillAssessmentAppeals(tx, {limit})`                                              | trusted operator-side caller (an alert pass); ids and seconds only                                                                         |

`POST /api/v1/skill-assessment-appeals` files; `POST /api/v1/skill-assessment-appeals/{appealId}/decision` decides. Both need the session cookie, same-origin, an `Idempotency-Key` and a bounded strict JSON body; the appeal id comes only from the path. Refusals for self, original-reviewer, Guild-relationship and not-listed are one opaque `FORBIDDEN`.

Results never carry the statement, an account id, the evaluators, the adjudicator or the excluded list, and are never an authorization token (`changesAssessment`, `grantsRank`, `isAuthorizationToken` are literal `false`).

## Locks, replay and flags

Receipt, then User/Session (participant for filing), then the per-person/skill assessment advisory lock (class 12022, shared with decisions and acceptance), then the appeal row. Authority and allowlist are re-proven after every wait. The flag gates only NEW filings and decisions; an original receipt still replays. Concurrent adjudicators serialize and exactly one decides.

## Host dependencies and consuming example

A host supplies: the transaction port (`READ_COMMITTED` PostgreSQL), actor session facts, the allowlist predicate `isAdjudicator(accountId)`, the two window values, and the write switch. [Independent adjudicator host](../examples/skill-assessment-appeals/README.md) consumes the pure independence and window rules with its own synthetic facts and no application, database or environment dependency. The Root host is `src/lib/skill-appeals-host.ts` and `skill-appeals-http.ts`.

## Boundaries (not built, not decided here)

- **Reopening the assessment.** An upheld appeal records the requirement and the excluded reviewers. Issuing the fresh review (assignment to a reviewer other than the original, a new assessment version with a correcting event, 09.4) is a separate change that reads these rows; no rank is granted before it.
- **Adjudicator case view.** What an adjudicator may read of the statement, evidence and original review is an access decision (identity/access grants) not made here; there is no read route.
- **Operator alert wiring.** `listOverdueSkillAssessmentAppeals` returns the overdue set; raising the alert from the worker is not wired.
- **Conflicts beyond Guilds.** Related Party and financial-interest conflicts (17.4) are not observable for skill assessments yet. A Guild relationship is a Founder or live role grant shared with the appellant; token-holder membership is not consulted (an OPEN holder-observation matter).
- **No participant UI** and no notification of the outcome.
- The 14-day windows are provisional and the owner may revisit them; changing them never rewrites filed appeals (the deadline is stored per row).
