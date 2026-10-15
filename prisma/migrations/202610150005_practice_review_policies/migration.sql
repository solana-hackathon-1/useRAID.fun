-- Explicit immutable policy approval data; no guidance/calibration/evaluator/rank seed.
BEGIN;
CREATE TABLE "PracticeReviewPolicy" (
 "id" TEXT NOT NULL,"definitionVersionId" UUID NOT NULL,"purpose" TEXT NOT NULL,"revision" INTEGER NOT NULL,"currentVersionId" UUID NOT NULL,
 CONSTRAINT "PracticeReviewPolicy_pkey" PRIMARY KEY("id"),
 CONSTRAINT "PracticeReviewPolicy_contract_check" CHECK(raid_practice_id_v1(to_jsonb("id")) IS TRUE AND "purpose" IN ('OWNERSHIP_REVIEW','ASSESSMENT_REVIEW') AND "revision">0),
 CONSTRAINT "PracticeReviewPolicy_definition_fkey" FOREIGN KEY("definitionVersionId") REFERENCES "PracticeTrialVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "PracticeReviewPolicy_scope_key" ON "PracticeReviewPolicy"("definitionVersionId","purpose");
CREATE UNIQUE INDEX "PracticeReviewPolicy_family_key" ON "PracticeReviewPolicy"("id","definitionVersionId","purpose");
CREATE TABLE "PracticeReviewPolicyVersion" (
 "id" UUID NOT NULL DEFAULT gen_random_uuid(),"policyId" TEXT NOT NULL,"definitionVersionId" UUID NOT NULL,"purpose" TEXT NOT NULL,"revision" INTEGER NOT NULL,
 "state" TEXT NOT NULL,"guidance" TEXT NOT NULL,"publishedByAccountId" TEXT NOT NULL,"publishedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),"receiptId" UUID NOT NULL,"requestId" TEXT NOT NULL,
 CONSTRAINT "PracticeReviewPolicyVersion_pkey" PRIMARY KEY("id"),
 CONSTRAINT "PracticeReviewPolicyVersion_contract_check" CHECK("revision">0 AND "state" IN ('APPROVED','WITHDRAWN') AND "purpose" IN ('OWNERSHIP_REVIEW','ASSESSMENT_REVIEW') AND raid_practice_text_v1(to_jsonb("guidance"),4000) IS TRUE AND raid_practice_id_v1(to_jsonb("requestId")) IS TRUE AND isfinite("publishedAt")),
 CONSTRAINT "PracticeReviewPolicyVersion_family_fkey" FOREIGN KEY("policyId","definitionVersionId","purpose") REFERENCES "PracticeReviewPolicy"("id","definitionVersionId","purpose") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
 CONSTRAINT "PracticeReviewPolicyVersion_actor_fkey" FOREIGN KEY("publishedByAccountId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "PracticeReviewPolicyVersion_receipt_fkey" FOREIGN KEY("receiptId") REFERENCES "CommandReceipt"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "PracticeReviewPolicyVersion_revision_key" ON "PracticeReviewPolicyVersion"("policyId","revision");
CREATE UNIQUE INDEX "PracticeReviewPolicyVersion_receipt_key" ON "PracticeReviewPolicyVersion"("receiptId");
CREATE UNIQUE INDEX "PracticeReviewPolicyVersion_pointer_key" ON "PracticeReviewPolicyVersion"("id","policyId","definitionVersionId","purpose","revision");
ALTER TABLE "PracticeReviewPolicy" ADD CONSTRAINT "PracticeReviewPolicy_version_fkey" FOREIGN KEY("currentVersionId","id","definitionVersionId","purpose","revision") REFERENCES "PracticeReviewPolicyVersion"("id","policyId","definitionVersionId","purpose","revision") ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE FUNCTION raid_review_policy_version_guard_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Review policy versions are immutable history' USING ERRCODE='23000'; END IF;
 PERFORM 1 FROM "User" WHERE "id"=NEW."publishedByAccountId" FOR NO KEY UPDATE;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW."policyId",12018));
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW."definitionVersionId"::text||':'||NEW."purpose",12019));
 IF NEW."revision"=1 AND NEW."state"<>'APPROVED' THEN RAISE EXCEPTION 'Initial review policy requires explicit approval' USING ERRCODE='23000'; END IF;
 IF NEW."revision">1 AND NOT EXISTS(SELECT 1 FROM "PracticeReviewPolicyVersion" WHERE "policyId"=NEW."policyId" AND "revision"=NEW."revision"-1 AND "definitionVersionId"=NEW."definitionVersionId" AND "purpose"=NEW."purpose" AND "publishedAt"<=NEW."publishedAt") THEN RAISE EXCEPTION 'Review policy requires contiguous immutable scope/history' USING ERRCODE='23000'; END IF;
 IF NEW."publishedAt">clock_timestamp() OR NOT EXISTS(SELECT 1 FROM "CommandReceipt" c JOIN "User" u ON u."id"=NEW."publishedByAccountId" AND u."role"='ADMIN' AND u."suspended"=false AND u."xId" IS NOT NULL AND u."xId"<>'' JOIN "PracticeTrialVersion" d ON d."id"=NEW."definitionVersionId" AND d."publishedAt"<=NEW."publishedAt" WHERE c."id"=NEW."receiptId" AND date_trunc('milliseconds',c."createdAt")<=NEW."publishedAt") THEN RAISE EXCEPTION 'Review policy requires actual administrator/definition/receipt chronology' USING ERRCODE='23000'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER review_policy_version_guard_v1 BEFORE INSERT OR UPDATE OR DELETE ON "PracticeReviewPolicyVersion" FOR EACH ROW EXECUTE FUNCTION raid_review_policy_version_guard_v1();
CREATE FUNCTION raid_review_policy_projection_guard_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Review policy history requires reviewed retention' USING ERRCODE='23000'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW."id",12018));
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW."definitionVersionId"::text||':'||NEW."purpose",12019));
 IF TG_OP='INSERT' THEN
  IF NEW."revision"<>1 THEN RAISE EXCEPTION 'Initial review policy pointer must be one' USING ERRCODE='23000'; END IF;
 ELSE
  IF NEW."id"<>OLD."id" OR NEW."definitionVersionId"<>OLD."definitionVersionId" OR NEW."purpose"<>OLD."purpose" THEN RAISE EXCEPTION 'Review policy canonical scope is immutable' USING ERRCODE='23000'; END IF;
  IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  IF NEW."revision"<>OLD."revision"+1 OR NEW."currentVersionId"=OLD."currentVersionId" THEN RAISE EXCEPTION 'Review policy requires next immutable version' USING ERRCODE='23000'; END IF;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER review_policy_projection_guard_v1 BEFORE INSERT OR UPDATE OR DELETE ON "PracticeReviewPolicy" FOR EACH ROW EXECUTE FUNCTION raid_review_policy_projection_guard_v1();
CREATE FUNCTION raid_review_policy_commit_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM "CommandReceipt" c JOIN "AuditEvent" a ON a."receiptId"=c."id" JOIN "PracticeReviewPolicy" p ON p."id"=NEW."policyId" AND p."definitionVersionId"=NEW."definitionVersionId" AND p."purpose"=NEW."purpose" AND p."revision">=NEW."revision" JOIN "User" u ON u."id"=NEW."publishedByAccountId" AND u."role"='ADMIN' AND u."suspended"=false AND u."xId" IS NOT NULL AND u."xId"<>''
 WHERE c."id"=NEW."receiptId" AND c."actorId"=NEW."publishedByAccountId" AND c."commandKind"='PublishPracticeReviewPolicy' AND c."requestId"=NEW."requestId" AND c."resultRef"=NEW."id"::text
 AND a."ordinal"=0 AND a."eventType"='skill.practice_review_policy_published.v1' AND a."aggregateId"=NEW."policyId" AND a."aggregateVersion"=NEW."revision" AND a."actorId"=NEW."publishedByAccountId" AND a."correlationId"=NEW."requestId" AND a."guildId" IS NULL AND a."payload"=jsonb_build_object('practiceReviewPolicyVersionId',NEW."id"::text) AND NOT EXISTS(SELECT 1 FROM "OutboxEvent" o WHERE o."eventId"=a."id")) THEN RAISE EXCEPTION 'Review policy requires finalized admin receipt/private audit/canonical projection' USING ERRCODE='23000'; END IF;
 RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER review_policy_commit_v1 AFTER INSERT ON "PracticeReviewPolicyVersion" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION raid_review_policy_commit_v1();
COMMIT;
