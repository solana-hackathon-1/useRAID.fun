-- Attributable private reviewer findings; original submissions are never rewritten.
BEGIN;
CREATE FUNCTION raid_ownership_observations_v1(p jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE item jsonb;
BEGIN
 IF jsonb_typeof(p) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 IF jsonb_array_length(p)<1 OR jsonb_array_length(p)>20 THEN RETURN false; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(p) LOOP
  IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(item))<>2 OR NOT(item ?& ARRAY['kind','detail']) OR jsonb_typeof(item->'kind') IS DISTINCT FROM 'string' OR item->>'kind' NOT IN ('EXPLANATION','MODIFICATION','ATTRIBUTION','OTHER') OR raid_practice_text_v1(item->'detail',2000) IS NOT TRUE THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END;
$$;
CREATE TABLE "PracticeTrialOwnership" (
 "submissionId" UUID NOT NULL,"revision" INTEGER NOT NULL,"currentVersionId" UUID NOT NULL,
 CONSTRAINT "PracticeTrialOwnership_pkey" PRIMARY KEY("submissionId"),
 CONSTRAINT "PracticeTrialOwnership_revision_check" CHECK("revision">0),
 CONSTRAINT "PracticeTrialOwnership_submission_fkey" FOREIGN KEY("submissionId") REFERENCES "PracticeTrialSubmission"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE TABLE "PracticeTrialOwnershipVersion" (
 "id" UUID NOT NULL DEFAULT gen_random_uuid(),"submissionId" UUID NOT NULL,"revision" INTEGER NOT NULL,"assignmentId" UUID NOT NULL,"definitionVersionId" UUID NOT NULL,"policyVersionId" UUID NOT NULL,"evaluatorAccountId" TEXT NOT NULL,
 "decision" TEXT NOT NULL,"reason" TEXT NOT NULL,"observations" JSONB NOT NULL,"caseAccessReceiptId" UUID NOT NULL,"policyAccessReceiptId" UUID NOT NULL,
 "reviewedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),"receiptId" UUID NOT NULL,"requestId" TEXT NOT NULL,
 CONSTRAINT "PracticeTrialOwnershipVersion_pkey" PRIMARY KEY("id"),
 CONSTRAINT "PracticeTrialOwnershipVersion_contract_check" CHECK("revision">0 AND "decision" IN ('CONFIRM','DISPUTE','MORE_EVIDENCE') AND raid_practice_text_v1(to_jsonb("reason"),2000) IS TRUE AND raid_ownership_observations_v1("observations") IS TRUE AND isfinite("reviewedAt") AND raid_practice_id_v1(to_jsonb("requestId")) IS TRUE),
 CONSTRAINT "PracticeTrialOwnershipVersion_submission_fkey" FOREIGN KEY("submissionId") REFERENCES "PracticeTrialSubmission"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "PracticeTrialOwnershipVersion_assignment_fkey" FOREIGN KEY("assignmentId") REFERENCES "PracticeTrialReviewAssignment"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "PracticeTrialOwnershipVersion_definition_fkey" FOREIGN KEY("definitionVersionId") REFERENCES "PracticeTrialVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "PracticeTrialOwnershipVersion_policy_fkey" FOREIGN KEY("policyVersionId") REFERENCES "PracticeReviewPolicyVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "PracticeTrialOwnershipVersion_evaluator_fkey" FOREIGN KEY("evaluatorAccountId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "PracticeTrialOwnershipVersion_case_access_fkey" FOREIGN KEY("caseAccessReceiptId") REFERENCES "CommandReceipt"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "PracticeTrialOwnershipVersion_policy_access_fkey" FOREIGN KEY("policyAccessReceiptId") REFERENCES "CommandReceipt"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "PracticeTrialOwnershipVersion_receipt_fkey" FOREIGN KEY("receiptId") REFERENCES "CommandReceipt"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "PracticeTrialOwnershipVersion_revision_key" ON "PracticeTrialOwnershipVersion"("submissionId","revision");
CREATE UNIQUE INDEX "PracticeTrialOwnershipVersion_pointer_key" ON "PracticeTrialOwnershipVersion"("id","submissionId","revision");
CREATE UNIQUE INDEX "PracticeTrialOwnershipVersion_receipt_key" ON "PracticeTrialOwnershipVersion"("receiptId");
ALTER TABLE "PracticeTrialOwnership" ADD CONSTRAINT "PracticeTrialOwnership_version_fkey" FOREIGN KEY("currentVersionId","submissionId","revision") REFERENCES "PracticeTrialOwnershipVersion"("id","submissionId","revision") ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE FUNCTION raid_trial_ownership_version_guard_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Ownership findings are immutable history' USING ERRCODE='23000'; END IF;
 PERFORM 1 FROM "User" WHERE "id"=NEW."evaluatorAccountId" FOR NO KEY UPDATE;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW."assignmentId"::text,12017));
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW."definitionVersionId"::text||':OWNERSHIP_REVIEW',12019));
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW."submissionId"::text,12020));
 IF NEW."revision">1 AND NOT EXISTS(SELECT 1 FROM "PracticeTrialOwnershipVersion" WHERE "submissionId"=NEW."submissionId" AND "revision"=NEW."revision"-1 AND "definitionVersionId"=NEW."definitionVersionId" AND "reviewedAt"<=NEW."reviewedAt") THEN RAISE EXCEPTION 'Ownership findings require contiguous original case history' USING ERRCODE='23000'; END IF;
 IF NEW."reviewedAt">clock_timestamp() OR NOT EXISTS(SELECT 1 FROM "PracticeTrialSubmission" s JOIN "PracticeTrialStart" t ON t."id"=s."startId" AND t."definitionVersionId"=NEW."definitionVersionId" JOIN "PracticeTrialReviewAssignment" g ON g."id"=NEW."assignmentId" AND g."submissionId"=s."id" AND g."evaluatorAccountId"=NEW."evaluatorAccountId" AND g."purpose"='OWNERSHIP_REVIEW' AND g."issuedAt"<=NEW."reviewedAt" AND g."expiresAt">clock_timestamp() JOIN "User" u ON u."id"=g."evaluatorAccountId" AND u."suspended"=false JOIN "PracticeReviewPolicyVersion" v ON v."id"=NEW."policyVersionId" AND v."definitionVersionId"=NEW."definitionVersionId" AND v."purpose"='OWNERSHIP_REVIEW' AND v."state"='APPROVED' AND v."publishedAt"<=NEW."reviewedAt" JOIN "PracticeReviewPolicy" p ON p."currentVersionId"=v."id" JOIN "CommandReceipt" c ON c."id"=NEW."receiptId" AND date_trunc('milliseconds',c."createdAt")<=NEW."reviewedAt" WHERE s."id"=NEW."submissionId" AND s."submittedAt"<=NEW."reviewedAt" AND s."accountId"<>NEW."evaluatorAccountId" AND NOT EXISTS(SELECT 1 FROM "PracticeTrialReviewRevocation" r WHERE r."assignmentId"=g."id")) THEN RAISE EXCEPTION 'Ownership finding requires current actual nonself assignment/policy/original case/clock' USING ERRCODE='23000'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER trial_ownership_version_guard_v1 BEFORE INSERT OR UPDATE OR DELETE ON "PracticeTrialOwnershipVersion" FOR EACH ROW EXECUTE FUNCTION raid_trial_ownership_version_guard_v1();
CREATE FUNCTION raid_trial_ownership_projection_guard_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Ownership history requires reviewed retention' USING ERRCODE='23000'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW."submissionId"::text,12020));
 IF TG_OP='INSERT' THEN
  IF NEW."revision"<>1 THEN RAISE EXCEPTION 'Initial ownership pointer must be one' USING ERRCODE='23000'; END IF;
 ELSE
  IF NEW."submissionId"<>OLD."submissionId" THEN RAISE EXCEPTION 'Ownership case is immutable' USING ERRCODE='23000'; END IF;
  IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  IF NEW."revision"<>OLD."revision"+1 OR NEW."currentVersionId"=OLD."currentVersionId" THEN RAISE EXCEPTION 'Ownership pointer requires next immutable version' USING ERRCODE='23000'; END IF;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER trial_ownership_projection_guard_v1 BEFORE INSERT OR UPDATE OR DELETE ON "PracticeTrialOwnership" FOR EACH ROW EXECUTE FUNCTION raid_trial_ownership_projection_guard_v1();
CREATE FUNCTION raid_trial_ownership_commit_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM "CommandReceipt" c JOIN "AuditEvent" a ON a."receiptId"=c."id" JOIN "PracticeTrialOwnership" p ON p."submissionId"=NEW."submissionId" AND p."revision">=NEW."revision"
 WHERE c."id"=NEW."receiptId" AND c."actorId"=NEW."evaluatorAccountId" AND c."commandKind"='RecordPracticeTrialOwnership' AND c."requestId"=NEW."requestId" AND c."resultRef"=NEW."id"::text AND a."ordinal"=0 AND a."eventType"='skill.practice_trial_ownership_recorded.v1' AND a."aggregateId"=NEW."submissionId"::text AND a."aggregateVersion"=NEW."revision" AND a."actorId"=NEW."evaluatorAccountId" AND a."correlationId"=NEW."requestId" AND a."guildId" IS NULL AND a."payload"=jsonb_build_object('practiceTrialOwnershipVersionId',NEW."id"::text) AND NOT EXISTS(SELECT 1 FROM "OutboxEvent" o WHERE o."eventId"=a."id")) THEN RAISE EXCEPTION 'Ownership finding requires finalized receipt/private audit/projection' USING ERRCODE='23000'; END IF;
 IF NOT EXISTS(SELECT 1 FROM "CommandReceipt" c JOIN "AuditEvent" a ON a."receiptId"=c."id" WHERE c."id"=NEW."caseAccessReceiptId" AND c."actorId"=NEW."evaluatorAccountId" AND c."commandKind"='ReadPracticeTrialForReview' AND c."resultRef"=NEW."submissionId"::text AND date_trunc('milliseconds',c."createdAt")<=NEW."reviewedAt" AND a."ordinal"=0 AND a."eventType"='skill.practice_review_access_authorized.v1' AND a."aggregateId"=NEW."submissionId"::text AND a."aggregateVersion"=1 AND a."actorId"=NEW."evaluatorAccountId" AND a."correlationId"=c."requestId" AND a."guildId" IS NULL AND a."payload"=jsonb_build_object('practiceReviewAssignmentId',NEW."assignmentId"::text) AND NOT EXISTS(SELECT 1 FROM "OutboxEvent" o WHERE o."eventId"=a."id")) THEN RAISE EXCEPTION 'Ownership finding requires actual private case access provenance' USING ERRCODE='23000'; END IF;
 IF NOT EXISTS(SELECT 1 FROM "CommandReceipt" c JOIN "AuditEvent" a ON a."receiptId"=c."id" WHERE c."id"=NEW."policyAccessReceiptId" AND c."actorId"=NEW."evaluatorAccountId" AND c."commandKind"='ReadApprovedPracticeReviewPolicy' AND c."resultRef"=NEW."policyVersionId"::text AND date_trunc('milliseconds',c."createdAt")<=NEW."reviewedAt" AND a."ordinal"=0 AND a."eventType"='skill.practice_review_policy_use_authorized.v1' AND a."aggregateId"=NEW."submissionId"::text AND a."aggregateVersion"=1 AND a."actorId"=NEW."evaluatorAccountId" AND a."correlationId"=c."requestId" AND a."guildId" IS NULL AND a."payload"=jsonb_build_object('practiceReviewPolicyVersionId',NEW."policyVersionId"::text) AND NOT EXISTS(SELECT 1 FROM "OutboxEvent" o WHERE o."eventId"=a."id")) THEN RAISE EXCEPTION 'Ownership finding requires actual approved policy use provenance' USING ERRCODE='23000'; END IF;
 IF NOT EXISTS(SELECT 1 FROM "PracticeTrialReviewAssignment" g JOIN "User" u ON u."id"=g."evaluatorAccountId" AND u."suspended"=false JOIN "PracticeReviewPolicy" p ON p."currentVersionId"=NEW."policyVersionId" WHERE g."id"=NEW."assignmentId" AND g."expiresAt">clock_timestamp() AND NOT EXISTS(SELECT 1 FROM "PracticeTrialReviewRevocation" r WHERE r."assignmentId"=g."id")) THEN RAISE EXCEPTION 'Ownership authority must remain current through commit' USING ERRCODE='23000'; END IF;
 RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER trial_ownership_commit_v1 AFTER INSERT ON "PracticeTrialOwnershipVersion" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION raid_trial_ownership_commit_v1();
COMMIT;
