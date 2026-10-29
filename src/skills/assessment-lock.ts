/**
 * Per-person, per-skill assessment advisory lock. Decisions (verify, reassess, revoke) and Root acceptance take it so
 * an acceptance either commits before a decision reads its evidence or waits for it. The migrations' triggers take the
 * same key in SQL (`participantId || ':' || skillId`, class 12022), so every TypeScript caller must use this helper.
 */
export const ASSESSMENT_LOCK_CLASS = 12022;
export const ASSESSMENT_LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtextextended($1,${ASSESSMENT_LOCK_CLASS}))::text`;
export const assessmentLockKey = (participantId: string, skillId: string) =>
  participantId + ':' + skillId;
