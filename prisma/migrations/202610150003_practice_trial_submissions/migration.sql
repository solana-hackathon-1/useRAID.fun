-- Private first submissions only; claimant declarations never confirm originality or skill.
BEGIN;
CREATE UNIQUE INDEX "PracticeTrialStart_owner_key" ON "PracticeTrialStart"("id","participantId","accountId");
CREATE FUNCTION raid_practice_private_text_v1(p text, maximum integer) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT p IS NOT NULL AND char_length(btrim(p,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'))>0
 AND raid_practice_text_v1(to_jsonb('x'||p||'x'),maximum+2) IS TRUE
$$;
CREATE FUNCTION raid_practice_submission_tools_v1(p jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE item jsonb; labels text[]:='{}';
BEGIN
 IF jsonb_typeof(p) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 IF jsonb_array_length(p)>50 THEN RETURN false; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(p) LOOP
  IF raid_practice_text_v1(item,200) IS NOT TRUE OR (item #>> '{}')=ANY(labels) THEN RETURN false; END IF;
  labels:=array_append(labels,item #>> '{}');
 END LOOP;
 RETURN true;
END;
$$;
CREATE TABLE "PracticeTrialSubmission" (
 "id" UUID NOT NULL DEFAULT gen_random_uuid(),"revision" INTEGER NOT NULL DEFAULT 1,
 "startId" UUID NOT NULL,"participantId" UUID NOT NULL,"accountId" TEXT NOT NULL,
 "answer" TEXT NOT NULL,"explanation" TEXT NOT NULL,"toolsUsed" JSONB NOT NULL,"aiAssistanceUsed" BOOLEAN NOT NULL,"assistanceDisclosure" TEXT NOT NULL,
 "submittedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),"receiptId" UUID NOT NULL,"requestId" TEXT NOT NULL,
 CONSTRAINT "PracticeTrialSubmission_pkey" PRIMARY KEY("id"),
 CONSTRAINT "PracticeTrialSubmission_contract_check" CHECK("revision"=1 AND raid_practice_private_text_v1("answer",40000) IS TRUE AND raid_practice_private_text_v1("explanation",4000) IS TRUE AND raid_practice_submission_tools_v1("toolsUsed") IS TRUE AND raid_practice_private_text_v1("assistanceDisclosure",4000) IS TRUE AND raid_practice_id_v1(to_jsonb("requestId")) IS TRUE),
 CONSTRAINT "PracticeTrialSubmission_start_fkey" FOREIGN KEY("startId","participantId","accountId") REFERENCES "PracticeTrialStart"("id","participantId","accountId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "PracticeTrialSubmission_receipt_fkey" FOREIGN KEY("receiptId") REFERENCES "CommandReceipt"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "PracticeTrialSubmission_start_key" ON "PracticeTrialSubmission"("startId");
CREATE UNIQUE INDEX "PracticeTrialSubmission_receipt_key" ON "PracticeTrialSubmission"("receiptId");
CREATE UNIQUE INDEX "PracticeTrialSubmission_reference_key" ON "PracticeTrialSubmission"("id","revision");
CREATE FUNCTION raid_practice_submission_guard_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Practice submissions are immutable private history' USING ERRCODE='23000'; END IF;
 PERFORM 1 FROM "User" WHERE "id"=NEW."accountId" FOR NO KEY UPDATE;
 PERFORM 1 FROM "Participant" WHERE "id"=NEW."participantId" AND "accountId"=NEW."accountId" FOR SHARE;
 PERFORM 1 FROM "PracticeTrialStart" WHERE "id"=NEW."startId" AND "participantId"=NEW."participantId" AND "accountId"=NEW."accountId" AND "startedAt"<=NEW."submittedAt" FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Submission requires actual owned canonical start and original time' USING ERRCODE='23000'; END IF;
 IF NEW."submittedAt">clock_timestamp() OR NOT EXISTS(SELECT 1 FROM "CommandReceipt" c WHERE c."id"=NEW."receiptId" AND date_trunc('milliseconds',c."createdAt")<=NEW."submittedAt") THEN RAISE EXCEPTION 'Submission requires receipt and database-clock chronology' USING ERRCODE='23000'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW."startId"::text,12016));
 RETURN NEW;
END;
$$;
CREATE TRIGGER practice_submission_guard_v1 BEFORE INSERT OR UPDATE OR DELETE ON "PracticeTrialSubmission" FOR EACH ROW EXECUTE FUNCTION raid_practice_submission_guard_v1();
CREATE FUNCTION raid_practice_submission_commit_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM "CommandReceipt" c JOIN "AuditEvent" a ON a."receiptId"=c."id" JOIN "User" u ON u."id"=NEW."accountId" AND u."suspended"=false
 WHERE c."id"=NEW."receiptId" AND c."actorId"=NEW."accountId" AND c."commandKind"='SubmitPracticeTrial' AND c."requestId"=NEW."requestId" AND c."resultRef"=NEW."id"::text
 AND a."ordinal"=0 AND a."eventType"='skill.practice_trial_submitted.v1' AND a."aggregateId"=NEW."id"::text AND a."aggregateVersion"=1 AND a."actorId"=NEW."accountId" AND a."correlationId"=NEW."requestId" AND a."guildId" IS NULL
 AND a."payload"=jsonb_build_object('practiceTrialSubmissionId',NEW."id"::text) AND NOT EXISTS(SELECT 1 FROM "OutboxEvent" o WHERE o."eventId"=a."id")) THEN RAISE EXCEPTION 'Submission requires finalized own receipt/private identifier audit' USING ERRCODE='23000'; END IF;
 RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER practice_submission_commit_v1 AFTER INSERT ON "PracticeTrialSubmission" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION raid_practice_submission_commit_v1();
COMMIT;
