-- Additive (#359 items 1-2): two indexes only; no data, guard or constraint changes.
-- The per-account submission rate-limit count reads the newest submissions of one account while holding that account's
-- row lock; the reviewer evidence-reuse read joins SkillClaim on its current-version pointer.
BEGIN;
CREATE INDEX "PracticeTrialSubmission_account_submitted_idx" ON "PracticeTrialSubmission"("accountId","submittedAt" DESC);
CREATE INDEX "SkillClaim_currentVersion_idx" ON "SkillClaim"("currentVersionId");
COMMIT;
