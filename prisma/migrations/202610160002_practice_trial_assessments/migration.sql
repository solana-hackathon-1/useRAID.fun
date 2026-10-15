-- Actual case-specific manual review and separately committed rank facts; no real seed.
BEGIN;
CREATE FUNCTION raid_assessment_criteria_v1(p jsonb, definition jsonb, verifying boolean) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE item jsonb; original jsonb; ids text[]:='{}';
BEGIN
 IF jsonb_typeof(p) IS DISTINCT FROM 'array' OR jsonb_typeof(definition->'rubric'->'criteria') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 IF jsonb_array_length(p)<>jsonb_array_length(definition->'rubric'->'criteria') THEN RETURN false; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(p) LOOP
  IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR NOT(item ?& ARRAY['criterionId','result','reason']) OR item-ARRAY['criterionId','result','reason']<>'{}'::jsonb OR raid_practice_id_v1(item->'criterionId') IS NOT TRUE OR jsonb_typeof(item->'result') IS DISTINCT FROM 'string' OR item->>'result' NOT IN ('MET','NOT_MET','UNCERTAIN') OR raid_practice_text_v1(item->'reason',2000) IS NOT TRUE OR (item->>'criterionId')=ANY(ids) THEN RETURN false; END IF;
  SELECT c INTO original FROM jsonb_array_elements(definition->'rubric'->'criteria') c WHERE c->>'id'=item->>'criterionId';
  IF original IS NULL OR (verifying AND original->'required'='true'::jsonb AND item->>'result'<>'MET') THEN RETURN false; END IF;
  ids:=array_append(ids,item->>'criterionId');
 END LOOP;
 RETURN true;
END;
$$;
CREATE TABLE "PracticeAssessmentReview" (
 "submissionId" UUID NOT NULL,"revision" INTEGER NOT NULL,"currentVersionId" UUID NOT NULL,
 CONSTRAINT "PracticeAssessmentReview_pkey" PRIMARY KEY("submissionId"),
 CONSTRAINT "PracticeAssessmentReview_revision_check" CHECK("revision">0),
 CONSTRAINT "PracticeAssessmentReview_submission_fkey" FOREIGN KEY("submissionId") REFERENCES "PracticeTrialSubmission"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE TABLE "PracticeAssessmentReviewVersion" (
 "id" UUID NOT NULL DEFAULT gen_random_uuid(),"submissionId" UUID NOT NULL,"revision" INTEGER NOT NULL,"assignmentId" UUID NOT NULL,"definitionVersionId" UUID NOT NULL,"policyVersionId" UUID NOT NULL,"evaluatorAccountId" TEXT NOT NULL,
 "decision" TEXT NOT NULL,"reason" TEXT NOT NULL,"confidenceStatement" TEXT NOT NULL,"criteria" JSONB NOT NULL,"reassessmentAt" TIMESTAMPTZ(3),"ownershipVersionId" UUID,"assessmentVersionId" UUID,
 "caseAccessReceiptId" UUID NOT NULL,"policyAccessReceiptId" UUID NOT NULL,"ownershipAccessReceiptId" UUID,
 "reviewedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),"receiptId" UUID NOT NULL,"requestId" TEXT NOT NULL,
 CONSTRAINT "PracticeAssessmentReviewVersion_pkey" PRIMARY KEY("id"),
 CONSTRAINT "PracticeAssessmentReviewVersion_contract_check" CHECK("revision">0 AND "decision" IN ('VERIFY','MORE_EVIDENCE','NOT_DEMONSTRATED') AND raid_practice_text_v1(to_jsonb("reason"),2000) IS TRUE AND raid_practice_text_v1(to_jsonb("confidenceStatement"),2000) IS TRUE AND isfinite("reviewedAt") AND ("reassessmentAt" IS NULL OR (isfinite("reassessmentAt") AND "reassessmentAt">"reviewedAt")) AND ("decision"='VERIFY')=("assessmentVersionId" IS NOT NULL) AND ("ownershipVersionId" IS NULL)=("ownershipAccessReceiptId" IS NULL) AND raid_practice_id_v1(to_jsonb("requestId")) IS TRUE),
 CONSTRAINT "PracticeAssessmentReviewVersion_submission_fkey" FOREIGN KEY("submissionId") REFERENCES "PracticeTrialSubmission"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "PracticeAssessmentReviewVersion_assignment_fkey" FOREIGN KEY("assignmentId") REFERENCES "PracticeTrialReviewAssignment"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "PracticeAssessmentReviewVersion_definition_fkey" FOREIGN KEY("definitionVersionId") REFERENCES "PracticeTrialVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "PracticeAssessmentReviewVersion_policy_fkey" FOREIGN KEY("policyVersionId") REFERENCES "PracticeReviewPolicyVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "PracticeAssessmentReviewVersion_evaluator_fkey" FOREIGN KEY("evaluatorAccountId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "PracticeAssessmentReviewVersion_ownership_fkey" FOREIGN KEY("ownershipVersionId") REFERENCES "PracticeTrialOwnershipVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "PracticeAssessmentReviewVersion_case_access_fkey" FOREIGN KEY("caseAccessReceiptId") REFERENCES "CommandReceipt"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "PracticeAssessmentReviewVersion_policy_access_fkey" FOREIGN KEY("policyAccessReceiptId") REFERENCES "CommandReceipt"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "PracticeAssessmentReviewVersion_ownership_access_fkey" FOREIGN KEY("ownershipAccessReceiptId") REFERENCES "CommandReceipt"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "PracticeAssessmentReviewVersion_receipt_fkey" FOREIGN KEY("receiptId") REFERENCES "CommandReceipt"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "PracticeAssessmentReviewVersion_revision_key" ON "PracticeAssessmentReviewVersion"("submissionId","revision");
CREATE UNIQUE INDEX "PracticeAssessmentReviewVersion_pointer_key" ON "PracticeAssessmentReviewVersion"("id","submissionId","revision");
CREATE UNIQUE INDEX "PracticeAssessmentReviewVersion_receipt_key" ON "PracticeAssessmentReviewVersion"("receiptId");
CREATE UNIQUE INDEX "PracticeAssessmentReviewVersion_assessment_key" ON "PracticeAssessmentReviewVersion"("assessmentVersionId");
ALTER TABLE "PracticeAssessmentReview" ADD CONSTRAINT "PracticeAssessmentReview_version_fkey" FOREIGN KEY("currentVersionId","submissionId","revision") REFERENCES "PracticeAssessmentReviewVersion"("id","submissionId","revision") ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE TABLE "SkillAssessment" (
 "id" UUID NOT NULL DEFAULT gen_random_uuid(),"participantId" UUID NOT NULL,"skillId" TEXT NOT NULL,"skillDomain" TEXT NOT NULL,"taxonomyId" TEXT NOT NULL,"revision" INTEGER NOT NULL,"currentVersionId" UUID NOT NULL,
 CONSTRAINT "SkillAssessment_pkey" PRIMARY KEY("id"),
 CONSTRAINT "SkillAssessment_contract_check" CHECK("revision">0 AND raid_practice_id_v1(to_jsonb("skillId")) IS TRUE AND raid_practice_id_v1(to_jsonb("skillDomain")) IS TRUE AND raid_practice_id_v1(to_jsonb("taxonomyId")) IS TRUE),
 CONSTRAINT "SkillAssessment_participant_fkey" FOREIGN KEY("participantId") REFERENCES "Participant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "SkillAssessment_taxonomy_fkey" FOREIGN KEY("taxonomyId") REFERENCES "SkillTaxonomy"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "SkillAssessment_subject_skill_key" ON "SkillAssessment"("participantId","skillId");
CREATE UNIQUE INDEX "SkillAssessment_family_key" ON "SkillAssessment"("id","participantId","skillId","skillDomain","taxonomyId");
CREATE TABLE "SkillAssessmentVersion" (
 "id" UUID NOT NULL DEFAULT gen_random_uuid(),"assessmentId" UUID NOT NULL,"participantId" UUID NOT NULL,"skillId" TEXT NOT NULL,"skillDomain" TEXT NOT NULL,"taxonomyId" TEXT NOT NULL,"revision" INTEGER NOT NULL,
 "state" TEXT NOT NULL,"assessedRank" TEXT NOT NULL,"definitionVersionId" UUID NOT NULL,"submissionId" UUID NOT NULL,"ownershipVersionId" UUID NOT NULL,"policyVersionId" UUID NOT NULL,"evaluatorAccountId" TEXT NOT NULL,"reviewVersionId" UUID NOT NULL,
 "issuedAt" TIMESTAMPTZ(3) NOT NULL,"reassessmentAt" TIMESTAMPTZ(3),"confidenceStatement" TEXT NOT NULL,"sampleSize" INTEGER NOT NULL,
 "receiptId" UUID NOT NULL,"requestId" TEXT NOT NULL,
 CONSTRAINT "SkillAssessmentVersion_pkey" PRIMARY KEY("id"),
 CONSTRAINT "SkillAssessmentVersion_contract_check" CHECK("revision">0 AND "state"='VERIFIED' AND "assessedRank" IN ('E','D','C','B','A') AND "sampleSize"=1 AND raid_practice_text_v1(to_jsonb("confidenceStatement"),2000) IS TRUE AND isfinite("issuedAt") AND ("reassessmentAt" IS NULL OR (isfinite("reassessmentAt") AND "reassessmentAt">"issuedAt")) AND raid_practice_id_v1(to_jsonb("requestId")) IS TRUE),
 CONSTRAINT "SkillAssessmentVersion_family_fkey" FOREIGN KEY("assessmentId","participantId","skillId","skillDomain","taxonomyId") REFERENCES "SkillAssessment"("id","participantId","skillId","skillDomain","taxonomyId") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
 CONSTRAINT "SkillAssessmentVersion_review_fkey" FOREIGN KEY("reviewVersionId") REFERENCES "PracticeAssessmentReviewVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "SkillAssessmentVersion_definition_fkey" FOREIGN KEY("definitionVersionId") REFERENCES "PracticeTrialVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "SkillAssessmentVersion_submission_fkey" FOREIGN KEY("submissionId") REFERENCES "PracticeTrialSubmission"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "SkillAssessmentVersion_ownership_fkey" FOREIGN KEY("ownershipVersionId") REFERENCES "PracticeTrialOwnershipVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "SkillAssessmentVersion_policy_fkey" FOREIGN KEY("policyVersionId") REFERENCES "PracticeReviewPolicyVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "SkillAssessmentVersion_evaluator_fkey" FOREIGN KEY("evaluatorAccountId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "SkillAssessmentVersion_receipt_fkey" FOREIGN KEY("receiptId") REFERENCES "CommandReceipt"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "SkillAssessmentVersion_revision_key" ON "SkillAssessmentVersion"("assessmentId","revision");
CREATE UNIQUE INDEX "SkillAssessmentVersion_pointer_key" ON "SkillAssessmentVersion"("id","assessmentId","participantId","skillId","skillDomain","taxonomyId","revision");
CREATE UNIQUE INDEX "SkillAssessmentVersion_review_key" ON "SkillAssessmentVersion"("reviewVersionId");
CREATE UNIQUE INDEX "SkillAssessmentVersion_receipt_key" ON "SkillAssessmentVersion"("receiptId");
ALTER TABLE "SkillAssessment" ADD CONSTRAINT "SkillAssessment_version_fkey" FOREIGN KEY("currentVersionId","id","participantId","skillId","skillDomain","taxonomyId","revision") REFERENCES "SkillAssessmentVersion"("id","assessmentId","participantId","skillId","skillDomain","taxonomyId","revision") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "PracticeAssessmentReviewVersion" ADD CONSTRAINT "PracticeAssessmentReviewVersion_assessment_fkey" FOREIGN KEY("assessmentVersionId") REFERENCES "SkillAssessmentVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED;
CREATE FUNCTION raid_assessment_review_version_guard_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d jsonb; participant uuid; taxonomy text; prior_rank text;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Assessment review history is immutable' USING ERRCODE='23000'; END IF;
 PERFORM 1 FROM "User" WHERE "id"=NEW."evaluatorAccountId" FOR NO KEY UPDATE;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW."assignmentId"::text,12017));
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW."definitionVersionId"::text||':ASSESSMENT_REVIEW',12019));
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW."submissionId"::text,12020));
 SELECT s."participantId",v."definition",v."taxonomyId" INTO participant,d,taxonomy FROM "PracticeTrialSubmission" s JOIN "PracticeTrialStart" t ON t."id"=s."startId" AND t."definitionVersionId"=NEW."definitionVersionId" JOIN "PracticeTrialVersion" v ON v."id"=t."definitionVersionId" WHERE s."id"=NEW."submissionId";
 IF d IS NULL THEN RAISE EXCEPTION 'Review requires actual original case' USING ERRCODE='23000'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(participant::text||':'||(d->>'skillId'),12022));
 IF NEW."revision">1 AND NOT EXISTS(SELECT 1 FROM "PracticeAssessmentReviewVersion" WHERE "submissionId"=NEW."submissionId" AND "revision"=NEW."revision"-1 AND "definitionVersionId"=NEW."definitionVersionId" AND "reviewedAt"<=NEW."reviewedAt") THEN RAISE EXCEPTION 'Review requires contiguous original case history' USING ERRCODE='23000'; END IF;
 IF raid_assessment_criteria_v1(NEW."criteria",d,NEW."decision"='VERIFY') IS NOT TRUE OR NEW."reviewedAt">clock_timestamp() OR NEW."ownershipVersionId" IS DISTINCT FROM (SELECT "currentVersionId" FROM "PracticeTrialOwnership" WHERE "submissionId"=NEW."submissionId") THEN RAISE EXCEPTION 'Review requires original criteria/current ownership source/clock' USING ERRCODE='23000'; END IF;
 IF NOT EXISTS(SELECT 1 FROM "PracticeTrialSubmission" s JOIN "PracticeTrialReviewAssignment" g ON g."id"=NEW."assignmentId" AND g."submissionId"=s."id" AND g."evaluatorAccountId"=NEW."evaluatorAccountId" AND g."purpose"='ASSESSMENT_REVIEW' AND g."issuedAt"<=NEW."reviewedAt" AND g."expiresAt">clock_timestamp() JOIN "User" u ON u."id"=NEW."evaluatorAccountId" AND u."suspended"=false JOIN "PracticeReviewPolicyVersion" v ON v."id"=NEW."policyVersionId" AND v."definitionVersionId"=NEW."definitionVersionId" AND v."purpose"='ASSESSMENT_REVIEW' AND v."state"='APPROVED' AND v."publishedAt"<=NEW."reviewedAt" JOIN "PracticeReviewPolicy" p ON p."currentVersionId"=v."id" JOIN "CommandReceipt" c ON c."id"=NEW."receiptId" AND date_trunc('milliseconds',c."createdAt")<=NEW."reviewedAt" WHERE s."id"=NEW."submissionId" AND s."submittedAt"<=NEW."reviewedAt" AND s."accountId"<>NEW."evaluatorAccountId" AND NOT EXISTS(SELECT 1 FROM "PracticeTrialReviewRevocation" x WHERE x."assignmentId"=g."id")) THEN RAISE EXCEPTION 'Review requires current actual nonself evaluator/case/policy/receipt' USING ERRCODE='23000'; END IF;
 IF EXISTS(SELECT 1 FROM "SkillAssessment" WHERE "participantId"=participant AND "skillId"=d->>'skillId' AND ("skillDomain"<>d->>'skillDomain' OR "taxonomyId"<>taxonomy)) THEN RAISE EXCEPTION 'Assessment catalog/domain identity cannot silently change' USING ERRCODE='23000'; END IF;
 IF NEW."decision"='VERIFY' THEN
  IF d->>'targetRank' NOT IN ('E','D','C','B','A') OR d->>'evaluatorMethod'<>'MANUAL' OR NOT EXISTS(SELECT 1 FROM "PracticeTrialOwnershipVersion" WHERE "id"=NEW."ownershipVersionId" AND "submissionId"=NEW."submissionId" AND "definitionVersionId"=NEW."definitionVersionId" AND "decision"='CONFIRM') OR EXISTS(SELECT 1 FROM "PracticeTrialSubmission" s WHERE s."id"=NEW."submissionId" AND ((s."aiAssistanceUsed" AND d->'tools'->>'aiAssistance'='PROHIBITED') OR NOT(s."toolsUsed" <@ (d->'tools'->'permitted')))) THEN RAISE EXCEPTION 'Verification requires supported actual evidence/original tool conditions/confirmed ownership' USING ERRCODE='23000'; END IF;
  SELECT v."assessedRank" INTO prior_rank FROM "SkillAssessment" p JOIN "SkillAssessmentVersion" v ON v."id"=p."currentVersionId" WHERE p."participantId"=participant AND p."skillId"=d->>'skillId' AND v."state"='VERIFIED';
  IF prior_rank IS NOT NULL AND array_position(ARRAY['E','D','C','B','A','S'],prior_rank)>array_position(ARRAY['E','D','C','B','A','S'],d->>'targetRank') THEN RAISE EXCEPTION 'Lower trial cannot silently downgrade current verified capacity' USING ERRCODE='23000'; END IF;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER assessment_review_version_guard_v1 BEFORE INSERT OR UPDATE OR DELETE ON "PracticeAssessmentReviewVersion" FOR EACH ROW EXECUTE FUNCTION raid_assessment_review_version_guard_v1();
CREATE FUNCTION raid_skill_assessment_version_guard_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Committed skill assessment history is immutable' USING ERRCODE='23000'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW."participantId"::text||':'||NEW."skillId",12022));
 IF NEW."revision">1 AND NOT EXISTS(SELECT 1 FROM "SkillAssessmentVersion" WHERE "assessmentId"=NEW."assessmentId" AND "revision"=NEW."revision"-1 AND "participantId"=NEW."participantId" AND "skillId"=NEW."skillId" AND "skillDomain"=NEW."skillDomain" AND "taxonomyId"=NEW."taxonomyId" AND "issuedAt"<=NEW."issuedAt") THEN RAISE EXCEPTION 'Assessment requires contiguous stable source history' USING ERRCODE='23000'; END IF;
 IF NOT EXISTS(SELECT 1 FROM "PracticeAssessmentReviewVersion" r JOIN "PracticeTrialSubmission" s ON s."id"=r."submissionId" AND s."participantId"=NEW."participantId" JOIN "PracticeTrialVersion" d ON d."id"=r."definitionVersionId" AND d."taxonomyId"=NEW."taxonomyId" AND d."definition"->>'skillId'=NEW."skillId" AND d."definition"->>'skillDomain'=NEW."skillDomain" AND d."definition"->>'targetRank'=NEW."assessedRank" WHERE r."id"=NEW."reviewVersionId" AND r."assessmentVersionId"=NEW."id" AND r."decision"='VERIFY' AND r."definitionVersionId"=NEW."definitionVersionId" AND r."submissionId"=NEW."submissionId" AND r."ownershipVersionId"=NEW."ownershipVersionId" AND r."policyVersionId"=NEW."policyVersionId" AND r."evaluatorAccountId"=NEW."evaluatorAccountId" AND r."reviewedAt"=NEW."issuedAt" AND r."reassessmentAt" IS NOT DISTINCT FROM NEW."reassessmentAt" AND r."confidenceStatement"=NEW."confidenceStatement" AND r."receiptId"=NEW."receiptId" AND r."requestId"=NEW."requestId") THEN RAISE EXCEPTION 'Verification requires exact attributable actual review source' USING ERRCODE='23000'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER skill_assessment_version_guard_v1 BEFORE INSERT OR UPDATE OR DELETE ON "SkillAssessmentVersion" FOR EACH ROW EXECUTE FUNCTION raid_skill_assessment_version_guard_v1();
CREATE FUNCTION raid_assessment_projection_guard_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Assessment history requires reviewed retention' USING ERRCODE='23000'; END IF;
 IF TG_TABLE_NAME='PracticeAssessmentReview' THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW."submissionId"::text,12020));
  IF TG_OP='UPDATE' AND NEW."submissionId"<>OLD."submissionId" THEN RAISE EXCEPTION 'Review case is immutable' USING ERRCODE='23000'; END IF;
 ELSE
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW."participantId"::text||':'||NEW."skillId",12022));
  IF TG_OP='UPDATE' AND (NEW."id"<>OLD."id" OR NEW."participantId"<>OLD."participantId" OR NEW."skillId"<>OLD."skillId" OR NEW."skillDomain"<>OLD."skillDomain" OR NEW."taxonomyId"<>OLD."taxonomyId") THEN RAISE EXCEPTION 'Assessment family is immutable' USING ERRCODE='23000'; END IF;
 END IF;
 IF TG_OP='INSERT' THEN
  IF NEW."revision"<>1 THEN RAISE EXCEPTION 'Initial assessment pointer requires revision one' USING ERRCODE='23000'; END IF;
 ELSE
  IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  IF NEW."revision"<>OLD."revision"+1 OR NEW."currentVersionId"=OLD."currentVersionId" THEN RAISE EXCEPTION 'Assessment pointer requires next immutable version' USING ERRCODE='23000'; END IF;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER assessment_review_projection_guard_v1 BEFORE INSERT OR UPDATE OR DELETE ON "PracticeAssessmentReview" FOR EACH ROW EXECUTE FUNCTION raid_assessment_projection_guard_v1();
CREATE TRIGGER skill_assessment_projection_guard_v1 BEFORE INSERT OR UPDATE OR DELETE ON "SkillAssessment" FOR EACH ROW EXECUTE FUNCTION raid_assessment_projection_guard_v1();
CREATE FUNCTION raid_assessment_review_commit_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM "CommandReceipt" c JOIN "AuditEvent" a ON a."receiptId"=c."id" JOIN "PracticeAssessmentReview" p ON p."submissionId"=NEW."submissionId" AND p."revision">=NEW."revision" WHERE c."id"=NEW."receiptId" AND c."actorId"=NEW."evaluatorAccountId" AND c."commandKind"='RecordPracticeTrialAssessment' AND c."requestId"=NEW."requestId" AND c."resultRef"=NEW."id"::text AND a."ordinal"=0 AND a."eventType"='skill.practice_assessment_review_recorded.v1' AND a."aggregateId"=NEW."submissionId"::text AND a."aggregateVersion"=NEW."revision" AND a."actorId"=NEW."evaluatorAccountId" AND a."correlationId"=NEW."requestId" AND a."guildId" IS NULL AND a."payload"=jsonb_build_object('practiceAssessmentReviewVersionId',NEW."id"::text) AND NOT EXISTS(SELECT 1 FROM "OutboxEvent" o WHERE o."eventId"=a."id")) THEN RAISE EXCEPTION 'Review requires finalized private receipt/audit/current projection' USING ERRCODE='23000'; END IF;
 IF NOT EXISTS(SELECT 1 FROM "CommandReceipt" c JOIN "AuditEvent" a ON a."receiptId"=c."id" WHERE c."id"=NEW."caseAccessReceiptId" AND c."actorId"=NEW."evaluatorAccountId" AND c."commandKind"='ReadPracticeTrialForReview' AND c."resultRef"=NEW."submissionId"::text AND date_trunc('milliseconds',c."createdAt")<=NEW."reviewedAt" AND a."ordinal"=0 AND a."eventType"='skill.practice_review_access_authorized.v1' AND a."aggregateId"=NEW."submissionId"::text AND a."aggregateVersion"=1 AND a."actorId"=NEW."evaluatorAccountId" AND a."correlationId"=c."requestId" AND a."guildId" IS NULL AND a."payload"=jsonb_build_object('practiceReviewAssignmentId',NEW."assignmentId"::text) AND NOT EXISTS(SELECT 1 FROM "OutboxEvent" o WHERE o."eventId"=a."id")) THEN RAISE EXCEPTION 'Review requires actual case access provenance' USING ERRCODE='23000'; END IF;
 IF NOT EXISTS(SELECT 1 FROM "CommandReceipt" c JOIN "AuditEvent" a ON a."receiptId"=c."id" WHERE c."id"=NEW."policyAccessReceiptId" AND c."actorId"=NEW."evaluatorAccountId" AND c."commandKind"='ReadApprovedPracticeReviewPolicy' AND c."resultRef"=NEW."policyVersionId"::text AND date_trunc('milliseconds',c."createdAt")<=NEW."reviewedAt" AND a."ordinal"=0 AND a."eventType"='skill.practice_review_policy_use_authorized.v1' AND a."aggregateId"=NEW."submissionId"::text AND a."aggregateVersion"=1 AND a."actorId"=NEW."evaluatorAccountId" AND a."correlationId"=c."requestId" AND a."guildId" IS NULL AND a."payload"=jsonb_build_object('practiceReviewPolicyVersionId',NEW."policyVersionId"::text) AND NOT EXISTS(SELECT 1 FROM "OutboxEvent" o WHERE o."eventId"=a."id")) THEN RAISE EXCEPTION 'Review requires actual policy use provenance' USING ERRCODE='23000'; END IF;
 IF NEW."ownershipVersionId" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM "CommandReceipt" c JOIN "AuditEvent" a ON a."receiptId"=c."id" WHERE c."id"=NEW."ownershipAccessReceiptId" AND c."actorId"=NEW."evaluatorAccountId" AND c."commandKind"='ReadPracticeTrialOwnership' AND c."resultRef"=NEW."ownershipVersionId"::text AND date_trunc('milliseconds',c."createdAt")<=NEW."reviewedAt" AND a."ordinal"=0 AND a."eventType"='skill.practice_trial_ownership_access_authorized.v1' AND a."aggregateId"=NEW."submissionId"::text AND a."aggregateVersion"=(SELECT ov."revision" FROM "PracticeTrialOwnershipVersion" ov WHERE ov."id"=NEW."ownershipVersionId" AND ov."submissionId"=NEW."submissionId") AND a."actorId"=NEW."evaluatorAccountId" AND a."correlationId"=c."requestId" AND a."guildId" IS NULL AND a."payload"=jsonb_build_object('practiceTrialOwnershipVersionId',NEW."ownershipVersionId"::text) AND NOT EXISTS(SELECT 1 FROM "OutboxEvent" o WHERE o."eventId"=a."id")) THEN RAISE EXCEPTION 'Review requires actual ownership access provenance' USING ERRCODE='23000'; END IF;
 IF NOT EXISTS(SELECT 1 FROM "PracticeTrialReviewAssignment" g JOIN "User" u ON u."id"=g."evaluatorAccountId" AND u."suspended"=false JOIN "PracticeReviewPolicy" p ON p."currentVersionId"=NEW."policyVersionId" WHERE g."id"=NEW."assignmentId" AND g."expiresAt">clock_timestamp() AND NOT EXISTS(SELECT 1 FROM "PracticeTrialReviewRevocation" x WHERE x."assignmentId"=g."id")) THEN RAISE EXCEPTION 'Review authority must remain current through commit' USING ERRCODE='23000'; END IF;
 RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER assessment_review_commit_v1 AFTER INSERT ON "PracticeAssessmentReviewVersion" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION raid_assessment_review_commit_v1();
CREATE FUNCTION raid_skill_assessment_commit_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM "CommandReceipt" c JOIN "AuditEvent" a ON a."receiptId"=c."id" JOIN "SkillAssessment" p ON p."id"=NEW."assessmentId" AND p."revision">=NEW."revision" WHERE c."id"=NEW."receiptId" AND c."actorId"=NEW."evaluatorAccountId" AND c."commandKind"='RecordPracticeTrialAssessment' AND c."requestId"=NEW."requestId" AND c."resultRef"=NEW."reviewVersionId"::text AND a."ordinal"=1 AND a."eventType"='skill.assessment_issued.v1' AND a."aggregateId"=NEW."assessmentId"::text AND a."aggregateVersion"=NEW."revision" AND a."actorId"=NEW."evaluatorAccountId" AND a."correlationId"=NEW."requestId" AND a."guildId" IS NULL AND a."payload"=jsonb_build_object('skillAssessmentVersionId',NEW."id"::text) AND NOT EXISTS(SELECT 1 FROM "OutboxEvent" o WHERE o."eventId"=a."id")) THEN RAISE EXCEPTION 'Committed assessment requires exact finalized private review/audit/projection' USING ERRCODE='23000'; END IF;
 RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER skill_assessment_commit_v1 AFTER INSERT ON "SkillAssessmentVersion" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION raid_skill_assessment_commit_v1();
COMMIT;
