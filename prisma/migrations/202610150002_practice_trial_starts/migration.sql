-- Additive immutable unpaid start history. No actual rubric/evaluator/participant seed.
BEGIN;
CREATE TABLE "PracticeTrialStart" (
 "id" UUID NOT NULL DEFAULT gen_random_uuid(), "participantId" UUID NOT NULL, "accountId" TEXT NOT NULL,
 "trialId" TEXT NOT NULL, "definitionVersionId" UUID NOT NULL,
 "taxonomyId" TEXT NOT NULL, "taxonomyRevision" INTEGER NOT NULL, "taxonomyVersionId" UUID NOT NULL,
 "attemptNumber" INTEGER NOT NULL, "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
 "receiptId" UUID NOT NULL, "requestId" TEXT NOT NULL,
 CONSTRAINT "PracticeTrialStart_pkey" PRIMARY KEY("id"),
 CONSTRAINT "PracticeTrialStart_contract_check" CHECK("attemptNumber" BETWEEN 1 AND 10000 AND "taxonomyRevision">0 AND raid_practice_id_v1(to_jsonb("requestId")) IS TRUE),
 CONSTRAINT "PracticeTrialStart_participant_fkey" FOREIGN KEY("participantId","accountId") REFERENCES "Participant"("id","accountId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "PracticeTrialStart_trial_fkey" FOREIGN KEY("trialId") REFERENCES "PracticeTrial"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "PracticeTrialStart_definition_fkey" FOREIGN KEY("definitionVersionId") REFERENCES "PracticeTrialVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "PracticeTrialStart_taxonomy_fkey" FOREIGN KEY("taxonomyVersionId","taxonomyId","taxonomyRevision") REFERENCES "SkillTaxonomyVersion"("id","taxonomyId","revision") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "PracticeTrialStart_receipt_fkey" FOREIGN KEY("receiptId") REFERENCES "CommandReceipt"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "PracticeTrialStart_receipt_key" ON "PracticeTrialStart"("receiptId");
CREATE UNIQUE INDEX "PracticeTrialStart_family_number_key" ON "PracticeTrialStart"("participantId","trialId","attemptNumber");
CREATE FUNCTION raid_practice_start_guard_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE definition jsonb; catalog jsonb; count_used integer; last_start timestamptz;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Practice starts are immutable history' USING ERRCODE='23000'; END IF;
 -- Keep privileged SQL on the same serialization path. Session policy still belongs to the host.
 PERFORM 1 FROM "User" WHERE "id"=NEW."accountId" FOR NO KEY UPDATE;
 PERFORM 1 FROM "Participant" WHERE "id"=NEW."participantId" AND "accountId"=NEW."accountId" FOR SHARE;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW."taxonomyId",12012));
 PERFORM 1 FROM "SkillTaxonomy" WHERE "id"=NEW."taxonomyId" FOR SHARE;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW."trialId",12013));
 SELECT v."definition" INTO definition FROM "PracticeTrialVersion" v JOIN "PracticeTrial" p ON p."id"=v."trialId" AND p."currentVersionId"=v."id"
 WHERE v."id"=NEW."definitionVersionId" AND v."trialId"=NEW."trialId" AND v."taxonomyId"=NEW."taxonomyId" AND v."availability"='AVAILABLE' AND v."publishedAt"<=NEW."startedAt" FOR SHARE OF p;
 IF definition IS NULL THEN RAISE EXCEPTION 'Start requires actual current available definition' USING ERRCODE='23000'; END IF;
 SELECT v."skills" INTO catalog FROM "SkillTaxonomyVersion" v JOIN "SkillTaxonomy" p ON p."id"=v."taxonomyId" AND p."currentVersionId"=v."id"
 WHERE v."id"=NEW."taxonomyVersionId" AND v."taxonomyId"=NEW."taxonomyId" AND v."revision"=NEW."taxonomyRevision" AND v."publishedAt"<=NEW."startedAt";
 IF catalog IS NULL OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(catalog) s WHERE s->>'id'=definition->>'skillId' AND s->>'domain'=definition->>'skillDomain' AND s->>'status'='ACTIVE') THEN RAISE EXCEPTION 'Start requires current relevant active taxonomy' USING ERRCODE='23000'; END IF;
 IF NEW."startedAt">clock_timestamp() OR NOT EXISTS(SELECT 1 FROM "CommandReceipt" c WHERE c."id"=NEW."receiptId" AND date_trunc('milliseconds',c."createdAt")<=NEW."startedAt") THEN RAISE EXCEPTION 'Start requires a current receipt and database-clock time' USING ERRCODE='23000'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW."participantId"::text||':'||NEW."trialId",12015));
 SELECT count(*)::int,max("startedAt") INTO count_used,last_start FROM "PracticeTrialStart" WHERE "participantId"=NEW."participantId" AND "trialId"=NEW."trialId";
 IF NEW."attemptNumber"<>count_used+1 OR count_used>=(definition->>'maximumAttempts')::int THEN RAISE EXCEPTION 'Start exceeds canonical family attempt limit or sequence' USING ERRCODE='23000'; END IF;
 IF last_start IS NOT NULL AND (NEW."startedAt"<last_start OR NEW."startedAt"-last_start<make_interval(secs=>(definition->>'cooldownSeconds')::int)) THEN RAISE EXCEPTION 'Start requires canonical family cooldown' USING ERRCODE='23000'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER practice_start_guard_v1 BEFORE INSERT OR UPDATE OR DELETE ON "PracticeTrialStart" FOR EACH ROW EXECUTE FUNCTION raid_practice_start_guard_v1();
CREATE FUNCTION raid_practice_start_commit_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM "CommandReceipt" c JOIN "AuditEvent" a ON a."receiptId"=c."id" JOIN "User" u ON u."id"=NEW."accountId" AND u."suspended"=false
 JOIN "PracticeTrial" p ON p."id"=NEW."trialId" AND p."currentVersionId"=NEW."definitionVersionId" JOIN "PracticeTrialVersion" v ON v."id"=p."currentVersionId" AND v."availability"='AVAILABLE'
 JOIN "SkillTaxonomy" t ON t."id"=NEW."taxonomyId" AND t."currentVersionId"=NEW."taxonomyVersionId" AND t."revision"=NEW."taxonomyRevision"
 WHERE c."id"=NEW."receiptId" AND c."actorId"=NEW."accountId" AND c."commandKind"='StartPracticeTrial' AND c."requestId"=NEW."requestId" AND c."resultRef"=NEW."id"::text
 AND a."ordinal"=0 AND a."eventType"='skill.practice_trial_started.v1' AND a."aggregateId"=NEW."id"::text AND a."aggregateVersion"=1 AND a."actorId"=NEW."accountId" AND a."correlationId"=NEW."requestId" AND a."guildId" IS NULL
 AND a."payload"=jsonb_build_object('practiceTrialStartId',NEW."id"::text) AND NOT EXISTS(SELECT 1 FROM "OutboxEvent" o WHERE o."eventId"=a."id")) THEN RAISE EXCEPTION 'Start requires finalized own receipt/private audit/current versions' USING ERRCODE='23000'; END IF;
 RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER practice_start_commit_v1 AFTER INSERT ON "PracticeTrialStart" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION raid_practice_start_commit_v1();
COMMIT;
