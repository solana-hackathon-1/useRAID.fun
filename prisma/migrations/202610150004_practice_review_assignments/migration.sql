-- Explicit per-submission/per-purpose reviewer appointments, never confirmed ownership or rank.
BEGIN;
CREATE TABLE "PracticeTrialReviewAssignment" (
 "id" UUID NOT NULL DEFAULT gen_random_uuid(),"submissionId" UUID NOT NULL,"evaluatorAccountId" TEXT NOT NULL,
 "purpose" TEXT NOT NULL,"expiresAt" TIMESTAMPTZ(3) NOT NULL,"reason" TEXT NOT NULL,
 "issuedByAccountId" TEXT NOT NULL,"issuedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
 "receiptId" UUID NOT NULL,"requestId" TEXT NOT NULL,
 CONSTRAINT "PracticeTrialReviewAssignment_pkey" PRIMARY KEY("id"),
 CONSTRAINT "PracticeTrialReviewAssignment_contract_check" CHECK("purpose" IN ('OWNERSHIP_REVIEW','ASSESSMENT_REVIEW') AND isfinite("expiresAt") AND isfinite("issuedAt") AND "expiresAt">"issuedAt" AND raid_practice_text_v1(to_jsonb("reason"),2000) IS TRUE AND raid_practice_id_v1(to_jsonb("requestId")) IS TRUE),
 CONSTRAINT "PracticeTrialReviewAssignment_submission_fkey" FOREIGN KEY("submissionId") REFERENCES "PracticeTrialSubmission"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "PracticeTrialReviewAssignment_evaluator_fkey" FOREIGN KEY("evaluatorAccountId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "PracticeTrialReviewAssignment_issuer_fkey" FOREIGN KEY("issuedByAccountId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "PracticeTrialReviewAssignment_receipt_fkey" FOREIGN KEY("receiptId") REFERENCES "CommandReceipt"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "PracticeTrialReviewAssignment_receipt_key" ON "PracticeTrialReviewAssignment"("receiptId");
CREATE INDEX "PracticeTrialReviewAssignment_scope_idx" ON "PracticeTrialReviewAssignment"("evaluatorAccountId","submissionId","purpose");
CREATE TABLE "PracticeTrialReviewRevocation" (
 "id" UUID NOT NULL DEFAULT gen_random_uuid(),"assignmentId" UUID NOT NULL,"reason" TEXT NOT NULL,"revokedByAccountId" TEXT NOT NULL,
 "revokedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),"receiptId" UUID NOT NULL,"requestId" TEXT NOT NULL,
 CONSTRAINT "PracticeTrialReviewRevocation_pkey" PRIMARY KEY("id"),
 CONSTRAINT "PracticeTrialReviewRevocation_contract_check" CHECK(isfinite("revokedAt") AND raid_practice_text_v1(to_jsonb("reason"),2000) IS TRUE AND raid_practice_id_v1(to_jsonb("requestId")) IS TRUE),
 CONSTRAINT "PracticeTrialReviewRevocation_assignment_fkey" FOREIGN KEY("assignmentId") REFERENCES "PracticeTrialReviewAssignment"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "PracticeTrialReviewRevocation_actor_fkey" FOREIGN KEY("revokedByAccountId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "PracticeTrialReviewRevocation_receipt_fkey" FOREIGN KEY("receiptId") REFERENCES "CommandReceipt"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "PracticeTrialReviewRevocation_assignment_key" ON "PracticeTrialReviewRevocation"("assignmentId");
CREATE UNIQUE INDEX "PracticeTrialReviewRevocation_receipt_key" ON "PracticeTrialReviewRevocation"("receiptId");
CREATE FUNCTION raid_practice_review_assignment_guard_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE subject text;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Review appointments and revocations are immutable history' USING ERRCODE='23000'; END IF;
 IF TG_TABLE_NAME='PracticeTrialReviewAssignment' THEN
  SELECT "accountId" INTO subject FROM "PracticeTrialSubmission" WHERE "id"=NEW."submissionId";
  PERFORM 1 FROM "User" WHERE "id" IN (subject,NEW."evaluatorAccountId",NEW."issuedByAccountId") ORDER BY "id" FOR NO KEY UPDATE;
  IF subject IS NULL OR subject=NEW."evaluatorAccountId" OR NOT EXISTS(SELECT 1 FROM "User" WHERE "id"=NEW."evaluatorAccountId" AND "suspended"=false) OR NOT EXISTS(SELECT 1 FROM "PracticeTrialSubmission" s JOIN "Participant" p ON p."id"=s."participantId" AND p."accountId"=s."accountId" AND p."kind"='HUMAN' WHERE s."id"=NEW."submissionId" AND s."submittedAt"<=NEW."issuedAt") THEN RAISE EXCEPTION 'Review requires actual distinct subject and current evaluator' USING ERRCODE='23000'; END IF;
  IF NEW."issuedAt">clock_timestamp() OR NOT EXISTS(SELECT 1 FROM "CommandReceipt" c JOIN "User" u ON u."id"=NEW."issuedByAccountId" AND u."role"='ADMIN' AND u."suspended"=false AND u."xId" IS NOT NULL AND u."xId"<>'' WHERE c."id"=NEW."receiptId" AND date_trunc('milliseconds',c."createdAt")<=NEW."issuedAt") THEN RAISE EXCEPTION 'Appointment requires actual administrator and receipt chronology' USING ERRCODE='23000'; END IF;
 ELSE
  SELECT s."accountId" INTO subject FROM "PracticeTrialReviewAssignment" g JOIN "PracticeTrialSubmission" s ON s."id"=g."submissionId" WHERE g."id"=NEW."assignmentId";
  PERFORM 1 FROM "User" WHERE "id" IN (subject,NEW."revokedByAccountId",(SELECT "evaluatorAccountId" FROM "PracticeTrialReviewAssignment" WHERE "id"=NEW."assignmentId")) ORDER BY "id" FOR NO KEY UPDATE;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW."assignmentId"::text,12017));
  IF NEW."revokedAt">clock_timestamp() OR NOT EXISTS(SELECT 1 FROM "PracticeTrialReviewAssignment" WHERE "id"=NEW."assignmentId" AND "issuedAt"<=NEW."revokedAt") OR NOT EXISTS(SELECT 1 FROM "CommandReceipt" c JOIN "User" u ON u."id"=NEW."revokedByAccountId" AND u."role"='ADMIN' AND u."suspended"=false AND u."xId" IS NOT NULL AND u."xId"<>'' WHERE c."id"=NEW."receiptId" AND date_trunc('milliseconds',c."createdAt")<=NEW."revokedAt") THEN RAISE EXCEPTION 'Revocation requires actual assignment/admin and receipt chronology' USING ERRCODE='23000'; END IF;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER practice_review_assignment_guard_v1 BEFORE INSERT OR UPDATE OR DELETE ON "PracticeTrialReviewAssignment" FOR EACH ROW EXECUTE FUNCTION raid_practice_review_assignment_guard_v1();
CREATE TRIGGER practice_review_revocation_guard_v1 BEFORE INSERT OR UPDATE OR DELETE ON "PracticeTrialReviewRevocation" FOR EACH ROW EXECUTE FUNCTION raid_practice_review_assignment_guard_v1();
CREATE FUNCTION raid_practice_review_assignment_commit_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor text; kind text; event_type text; aggregate text; expected_payload jsonb;
BEGIN
 IF TG_TABLE_NAME='PracticeTrialReviewAssignment' THEN
  actor:=NEW."issuedByAccountId";kind:='IssuePracticeReviewAssignment';event_type:='skill.practice_review_assignment_issued.v1';aggregate:=NEW."id"::text;expected_payload:=jsonb_build_object('practiceReviewAssignmentId',NEW."id"::text);
 ELSE
  actor:=NEW."revokedByAccountId";kind:='RevokePracticeReviewAssignment';event_type:='skill.practice_review_assignment_revoked.v1';aggregate:=NEW."assignmentId"::text;expected_payload:=jsonb_build_object('practiceReviewRevocationId',NEW."id"::text);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM "CommandReceipt" c JOIN "AuditEvent" a ON a."receiptId"=c."id" JOIN "User" u ON u."id"=actor AND u."role"='ADMIN' AND u."suspended"=false AND u."xId" IS NOT NULL AND u."xId"<>''
 WHERE c."id"=NEW."receiptId" AND c."actorId"=actor AND c."commandKind"=kind AND c."requestId"=NEW."requestId" AND c."resultRef"=NEW."id"::text
 AND a."ordinal"=0 AND a."eventType"=event_type AND a."aggregateId"=aggregate AND a."aggregateVersion"=1 AND a."actorId"=actor AND a."correlationId"=NEW."requestId" AND a."guildId" IS NULL AND a."payload"=expected_payload AND NOT EXISTS(SELECT 1 FROM "OutboxEvent" o WHERE o."eventId"=a."id")) THEN RAISE EXCEPTION 'Review authority requires finalized receipt and private identifier audit' USING ERRCODE='23000'; END IF;
 RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER practice_review_assignment_commit_v1 AFTER INSERT ON "PracticeTrialReviewAssignment" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION raid_practice_review_assignment_commit_v1();
CREATE CONSTRAINT TRIGGER practice_review_revocation_commit_v1 AFTER INSERT ON "PracticeTrialReviewRevocation" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION raid_practice_review_assignment_commit_v1();
COMMIT;
