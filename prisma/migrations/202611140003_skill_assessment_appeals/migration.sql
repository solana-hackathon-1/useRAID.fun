-- Skill-assessment appeals (#357, T014, blueprint 09.7; DEC-2026-11-13-12 and DEC-2026-11-14-11). Additive only: two new
-- append-only tables, no change to any existing table, row or trigger. An appeal records a filing and one independent
-- decision. It never edits SkillAssessment/SkillAssessmentVersion, grants a rank, reserves capacity, creates a permission
-- or touches money; an upheld appeal only records that a fresh review by someone other than the original reviewers is
-- required (the reopening itself is a separate, later change). The windows are provisional and are chosen by the host
-- at filing time and stored per row, so changing them later never rewrites an appeal already filed.
BEGIN;
CREATE TABLE "SkillAssessmentAppeal" (
 "id" UUID NOT NULL DEFAULT gen_random_uuid(),
 "assessmentVersionId" UUID NOT NULL,
 "participantId" UUID NOT NULL,
 "appellantAccountId" TEXT NOT NULL,
 "reasonCategory" TEXT NOT NULL,
 "statement" TEXT NOT NULL,
 "decisionNoticeAt" TIMESTAMPTZ(3) NOT NULL,
 "filingDeadlineAt" TIMESTAMPTZ(3) NOT NULL,
 "filedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
 "adjudicationDueAt" TIMESTAMPTZ(3) NOT NULL,
 "receiptId" UUID NOT NULL,
 "requestId" TEXT NOT NULL,
 CONSTRAINT "SkillAssessmentAppeal_pkey" PRIMARY KEY("id"),
 CONSTRAINT "SkillAssessmentAppeal_contract_check" CHECK("reasonCategory" IN ('FACTUAL_ERROR','RUBRIC_MISAPPLIED','NEW_EVIDENCE','CONFLICT_OF_INTEREST','OWNERSHIP_DISPUTE','PROCESS_IRREGULARITY','SIGNAL_MISINTERPRETED') AND raid_practice_text_v1(to_jsonb("statement"),2000) IS TRUE AND isfinite("decisionNoticeAt") AND isfinite("filingDeadlineAt") AND isfinite("filedAt") AND isfinite("adjudicationDueAt") AND "filedAt">="decisionNoticeAt" AND "filedAt"<="filingDeadlineAt" AND "adjudicationDueAt">"filedAt" AND raid_practice_id_v1(to_jsonb("requestId")) IS TRUE),
 CONSTRAINT "SkillAssessmentAppeal_version_fkey" FOREIGN KEY("assessmentVersionId") REFERENCES "SkillAssessmentVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "SkillAssessmentAppeal_participant_fkey" FOREIGN KEY("participantId","appellantAccountId") REFERENCES "Participant"("id","accountId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "SkillAssessmentAppeal_receipt_fkey" FOREIGN KEY("receiptId") REFERENCES "CommandReceipt"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
-- One appeal per decided assessment version, whatever the category or the key used.
CREATE UNIQUE INDEX "SkillAssessmentAppeal_version_key" ON "SkillAssessmentAppeal"("assessmentVersionId");
CREATE UNIQUE INDEX "SkillAssessmentAppeal_receipt_key" ON "SkillAssessmentAppeal"("receiptId");
CREATE INDEX "SkillAssessmentAppeal_due_idx" ON "SkillAssessmentAppeal"("adjudicationDueAt");
CREATE INDEX "SkillAssessmentAppeal_participant_idx" ON "SkillAssessmentAppeal"("participantId","appellantAccountId");

CREATE TABLE "SkillAssessmentAppealDecision" (
 "id" UUID NOT NULL DEFAULT gen_random_uuid(),
 "appealId" UUID NOT NULL,
 "outcome" TEXT NOT NULL,
 "adjudicatorAccountId" TEXT NOT NULL,
 "reason" TEXT NOT NULL,
 "freshReviewExcludedAccountIds" TEXT[] NOT NULL,
 "decidedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
 "receiptId" UUID NOT NULL,
 "requestId" TEXT NOT NULL,
 CONSTRAINT "SkillAssessmentAppealDecision_pkey" PRIMARY KEY("id"),
 CONSTRAINT "SkillAssessmentAppealDecision_contract_check" CHECK("outcome" IN ('UPHELD','DENIED') AND raid_practice_text_v1(to_jsonb("reason"),2000) IS TRUE AND isfinite("decidedAt") AND ("outcome"='UPHELD')=(cardinality("freshReviewExcludedAccountIds")>0) AND raid_practice_id_v1(to_jsonb("requestId")) IS TRUE),
 CONSTRAINT "SkillAssessmentAppealDecision_appeal_fkey" FOREIGN KEY("appealId") REFERENCES "SkillAssessmentAppeal"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "SkillAssessmentAppealDecision_adjudicator_fkey" FOREIGN KEY("adjudicatorAccountId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "SkillAssessmentAppealDecision_receipt_fkey" FOREIGN KEY("receiptId") REFERENCES "CommandReceipt"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
-- An appeal is decided at most once; a denial is final for that decision version.
CREATE UNIQUE INDEX "SkillAssessmentAppealDecision_appeal_key" ON "SkillAssessmentAppealDecision"("appealId");
CREATE UNIQUE INDEX "SkillAssessmentAppealDecision_receipt_key" ON "SkillAssessmentAppealDecision"("receiptId");
CREATE INDEX "SkillAssessmentAppealDecision_adjudicator_idx" ON "SkillAssessmentAppealDecision"("adjudicatorAccountId");

-- Filing guard: history is immutable; a filing must name the participant's CURRENT decided version, owned by the
-- participant recorded on the row, with the notice time equal to that version's issue time. It takes the same
-- per-person/skill assessment lock (class 12022) as decisions, so a filing and a new decision serialize.
CREATE FUNCTION raid_skill_appeal_guard_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE version "SkillAssessmentVersion"%ROWTYPE;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Skill assessment appeal history is immutable' USING ERRCODE='23000'; END IF;
 SELECT * INTO version FROM "SkillAssessmentVersion" WHERE "id"=NEW."assessmentVersionId";
 IF version."id" IS NULL THEN RAISE EXCEPTION 'Appeal requires an actual committed assessment version' USING ERRCODE='23000'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(version."participantId"::text||':'||version."skillId",12022));
 IF version."participantId"<>NEW."participantId" OR version."issuedAt"<>NEW."decisionNoticeAt" OR NOT EXISTS(SELECT 1 FROM "SkillAssessment" a WHERE a."id"=version."assessmentId" AND a."currentVersionId"=version."id" AND a."revision"=version."revision") THEN
  RAISE EXCEPTION 'Appeal requires the participant''s own current decided version' USING ERRCODE='23000';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER skill_assessment_appeal_guard_v1 BEFORE INSERT OR UPDATE OR DELETE ON "SkillAssessmentAppeal" FOR EACH ROW EXECUTE FUNCTION raid_skill_appeal_guard_v1();

-- Decision guard (defence in depth behind the application's independence check): history is immutable; the adjudicator
-- is never the appellant and never any evaluator who issued, reviewed or decided this assessment's versions or reviewed
-- its submission; an upheld appeal records every one of those evaluators as excluded from the fresh review; the decision
-- cannot precede the filing. A Guild relationship and the allowlist are application/host facts and are not enforced here.
CREATE FUNCTION raid_skill_appeal_decision_guard_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE appeal "SkillAssessmentAppeal"%ROWTYPE; version "SkillAssessmentVersion"%ROWTYPE; reviewers text[];
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Skill assessment appeal decisions are immutable' USING ERRCODE='23000'; END IF;
 SELECT * INTO appeal FROM "SkillAssessmentAppeal" WHERE "id"=NEW."appealId";
 SELECT * INTO version FROM "SkillAssessmentVersion" WHERE "id"=appeal."assessmentVersionId";
 IF appeal."id" IS NULL OR version."id" IS NULL THEN RAISE EXCEPTION 'Decision requires an actual filed appeal' USING ERRCODE='23000'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(version."participantId"::text||':'||version."skillId",12022));
 SELECT COALESCE(array_agg(DISTINCT x."accountId"),'{}'::text[]) INTO reviewers FROM (
  SELECT v."evaluatorAccountId" AS "accountId" FROM "SkillAssessmentVersion" v WHERE v."assessmentId"=version."assessmentId"
  UNION SELECT d."evaluatorAccountId" FROM "PracticeAssessmentDecision" d WHERE d."assessmentId"=version."assessmentId"
  UNION SELECT g."evaluatorAccountId" FROM "PracticeTrialReviewAssignment" g WHERE g."submissionId" IN (SELECT v."submissionId" FROM "SkillAssessmentVersion" v WHERE v."assessmentId"=version."assessmentId")
  UNION SELECT r."evaluatorAccountId" FROM "PracticeAssessmentReviewVersion" r WHERE r."submissionId" IN (SELECT v."submissionId" FROM "SkillAssessmentVersion" v WHERE v."assessmentId"=version."assessmentId")
 ) x;
 IF NEW."adjudicatorAccountId"=appeal."appellantAccountId" OR NEW."adjudicatorAccountId"=ANY(reviewers) THEN
  RAISE EXCEPTION 'Appeal adjudicator must be independent of the appellant and the original reviewers' USING ERRCODE='23000';
 END IF;
 IF NEW."decidedAt"<appeal."filedAt" THEN RAISE EXCEPTION 'Decision cannot precede the filing' USING ERRCODE='23000'; END IF;
 IF NEW."outcome"='UPHELD' AND NOT(NEW."freshReviewExcludedAccountIds"@>reviewers) THEN
  RAISE EXCEPTION 'An upheld appeal must exclude every original reviewer from the fresh review' USING ERRCODE='23000';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER skill_assessment_appeal_decision_guard_v1 BEFORE INSERT OR UPDATE OR DELETE ON "SkillAssessmentAppealDecision" FOR EACH ROW EXECUTE FUNCTION raid_skill_appeal_decision_guard_v1();
COMMIT;
