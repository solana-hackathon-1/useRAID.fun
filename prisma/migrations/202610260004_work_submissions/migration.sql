BEGIN;
-- Guarded engagement lifecycle. T020 froze Engagement; submission and review need exactly these transitions.
-- Withdrawal, cancellation, termination and deadline closure add their own reviewed guards later.
ALTER TABLE "Engagement" DROP CONSTRAINT "Engagement_revision_check";
ALTER TABLE "Engagement" DROP CONSTRAINT "Engagement_state_check";
ALTER TABLE "Engagement" ADD CONSTRAINT "Engagement_revision_check" CHECK ("revision">=1);
ALTER TABLE "Engagement" ADD CONSTRAINT "Engagement_state_check" CHECK ("state" IN ('ACCESS_PENDING','IN_PROGRESS','SUBMITTED','UNDER_REVIEW','REVISION_REQUESTED','ACCEPTED','WITHDRAWN','CANCELLED','TERMINATED'));
DROP TRIGGER "Engagement_immutable" ON "Engagement";
CREATE FUNCTION raid_engagement_lifecycle_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Engagement history is immutable' USING ERRCODE='23514'; END IF;
 IF (to_jsonb(NEW)-'state'-'revision') IS DISTINCT FROM (to_jsonb(OLD)-'state'-'revision') THEN
  RAISE EXCEPTION 'Accepted engagement terms and identity are immutable' USING ERRCODE='23514';
 END IF;
 IF NEW."revision"<>OLD."revision"+1 THEN
  RAISE EXCEPTION 'Engagement revision must advance exactly once per transition' USING ERRCODE='23514';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM (VALUES ('ACCESS_PENDING','IN_PROGRESS'),('IN_PROGRESS','SUBMITTED'),('REVISION_REQUESTED','SUBMITTED'),('SUBMITTED','REVISION_REQUESTED'),('SUBMITTED','ACCEPTED')) AS allowed("fromState","toState") WHERE allowed."fromState"=OLD."state" AND allowed."toState"=NEW."state") THEN
  RAISE EXCEPTION 'Engagement transition % -> % is not permitted', OLD."state", NEW."state" USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "Engagement_lifecycle_guard" BEFORE UPDATE OR DELETE ON "Engagement" FOR EACH ROW EXECUTE FUNCTION raid_engagement_lifecycle_guard();
-- Capacity follows state: active states hold exactly the roster; closed states hold nothing. Release matches participant and engagement.
CREATE OR REPLACE FUNCTION raid_engagement_capacity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; e "Engagement"; roster_size integer;
BEGIN
 IF TG_TABLE_NAME='Engagement' THEN target:=NEW."id";
 ELSIF TG_TABLE_NAME='RaidSlot' THEN
  SELECT "id" INTO target FROM "Engagement" WHERE "slotId"=NEW."id";
  IF NEW."state"='FILLED' AND target IS NULL THEN RAISE EXCEPTION 'FILLED slot requires engagement' USING ERRCODE='23514'; END IF;
 ELSE
  IF TG_OP='DELETE' THEN target:=OLD."engagementId"; ELSE target:=NEW."engagementId"; END IF;
 END IF;
 IF target IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO STRICT e FROM "Engagement" WHERE "id"=target;
 roster_size:=jsonb_array_length(e."acceptedTerms"->'roster');
 IF e."state" IN ('ACCEPTED','WITHDRAWN','CANCELLED','TERMINATED') THEN
  IF EXISTS (SELECT 1 FROM "ActiveCommitment" WHERE "engagementId"=target) OR (SELECT count(*) FROM "EngagementMember" WHERE "engagementId"=target)<>roster_size OR NOT EXISTS (SELECT 1 FROM "RaidSlot" WHERE "id"=e."slotId" AND "state"='FILLED') THEN
   RAISE EXCEPTION 'Closed engagement must release all of its own capacity and keep its source history' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM "RaidSlot" WHERE "id"=e."slotId" AND "state"='FILLED') OR (SELECT count(*) FROM "EngagementMember" WHERE "engagementId"=target)<>roster_size OR (SELECT count(*) FROM "ActiveCommitment" WHERE "engagementId"=target)<>roster_size OR (SELECT count(DISTINCT value->>'participantId') FROM jsonb_array_elements(e."acceptedTerms"->'roster'))<>roster_size OR EXISTS (
  SELECT 1 FROM jsonb_array_elements(e."acceptedTerms"->'roster') member WHERE NOT EXISTS (SELECT 1 FROM "EngagementMember" m JOIN "ActiveCommitment" c ON c."engagementId"=m."engagementId" AND c."participantId"=m."participantId" AND c."termsVersionId"=m."termsVersionId" WHERE m."engagementId"=target AND m."participantId"=(member->>'participantId')::uuid AND m."termsVersionId"=e."termsVersionId")
 ) THEN RAISE EXCEPTION 'Engagement, source, roster and capacity must commit atomically' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "Engagement_capacity_state_guard" AFTER UPDATE OF "state" ON "Engagement" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION raid_engagement_capacity_guard();

CREATE TABLE "WorkSubmission" (
 "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 "engagementId" uuid NOT NULL,
 "termsVersionId" uuid NOT NULL,
 "submissionNumber" integer NOT NULL CHECK ("submissionNumber">=1),
 "submitterParticipantId" uuid NOT NULL,
 "explanation" text NOT NULL CHECK (char_length("explanation") BETWEEN 1 AND 8000),
 "artifacts" jsonb NOT NULL CHECK (jsonb_typeof("artifacts")='array' AND jsonb_array_length("artifacts") BETWEEN 1 AND 20),
 "dependencies" jsonb NOT NULL CHECK (jsonb_typeof("dependencies")='array' AND jsonb_array_length("dependencies")<=50),
 "aiUsage" text CHECK ("aiUsage" IS NULL OR char_length("aiUsage") BETWEEN 1 AND 8000),
 "digest" text NOT NULL CHECK ("digest" ~ '^[0-9a-f]{64}$'),
 "createdAt" timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT "WorkSubmission_submitter_fkey" FOREIGN KEY ("engagementId","submitterParticipantId","termsVersionId") REFERENCES "EngagementMember"("engagementId","participantId","termsVersionId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "WorkSubmission_engagementId_submissionNumber_key" UNIQUE ("engagementId","submissionNumber"),
 CONSTRAINT "WorkSubmission_id_engagementId_termsVersionId_key" UNIQUE ("id","engagementId","termsVersionId")
);
CREATE TABLE "WorkReview" (
 "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 "submissionId" uuid NOT NULL UNIQUE,
 "engagementId" uuid NOT NULL,
 "termsVersionId" uuid NOT NULL,
 "reviewerAccountId" text NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "decision" text NOT NULL CHECK ("decision" IN ('ACCEPT','REQUEST_REVISION','DISPUTE')),
 "reason" text NOT NULL CHECK (char_length("reason") BETWEEN 1 AND 8000),
 "criteria" jsonb NOT NULL CHECK (jsonb_typeof("criteria")='array' AND jsonb_array_length("criteria") BETWEEN 1 AND 50),
 "revisionDeadline" timestamptz(6),
 "digest" text NOT NULL CHECK ("digest" ~ '^[0-9a-f]{64}$'),
 "createdAt" timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT "WorkReview_revisionDeadline_check" CHECK (("decision"='REQUEST_REVISION')=("revisionDeadline" IS NOT NULL)),
 CONSTRAINT "WorkReview_submission_fkey" FOREIGN KEY ("submissionId","engagementId","termsVersionId") REFERENCES "WorkSubmission"("id","engagementId","termsVersionId") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE TRIGGER "WorkSubmission_immutable" BEFORE UPDATE OR DELETE ON "WorkSubmission" FOR EACH ROW EXECUTE FUNCTION raid_engagement_immutable();
CREATE TRIGGER "WorkReview_immutable" BEFORE UPDATE OR DELETE ON "WorkReview" FOR EACH ROW EXECUTE FUNCTION raid_engagement_immutable();
CREATE FUNCTION raid_submission_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e record; due timestamptz;
BEGIN
 SELECT g."state",g."acceptedTerms",(t."snapshot"->'review'->>'maxRevisionRounds')::integer AS rounds INTO STRICT e FROM "Engagement" g JOIN "TermsVersion" t ON t."id"=g."termsVersionId" WHERE g."id"=NEW."engagementId" FOR SHARE OF g;
 IF e."state" NOT IN ('IN_PROGRESS','REVISION_REQUESTED') THEN
  RAISE EXCEPTION 'Submission requires an active IN_PROGRESS or REVISION_REQUESTED engagement' USING ERRCODE='23514';
 END IF;
 IF NEW."submissionNumber"<>COALESCE((SELECT max("submissionNumber") FROM "WorkSubmission" WHERE "engagementId"=NEW."engagementId"),0)+1 OR NEW."submissionNumber">1+e.rounds THEN
  RAISE EXCEPTION 'Submission number must be the next bounded round' USING ERRCODE='23514';
 END IF;
 -- First submission is due by the accepted submission deadline; a revision by the reviewer's recorded finite deadline.
 IF e."state"='REVISION_REQUESTED' THEN
  SELECT r."revisionDeadline" INTO due FROM "WorkReview" r JOIN "WorkSubmission" s ON s."id"=r."submissionId" WHERE s."engagementId"=NEW."engagementId" ORDER BY s."submissionNumber" DESC LIMIT 1;
 ELSE due:=(e."acceptedTerms"->'deadlines'->>'submission')::timestamptz; END IF;
 IF due IS NULL OR due<=clock_timestamp() THEN
  RAISE EXCEPTION 'Submission deadline has passed' USING ERRCODE='23514';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM "ActiveCommitment" WHERE "engagementId"=NEW."engagementId" AND "participantId"=NEW."submitterParticipantId") THEN
  RAISE EXCEPTION 'Submitter must hold this engagement''s active commitment' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "WorkSubmission_insert_guard" BEFORE INSERT ON "WorkSubmission" FOR EACH ROW EXECUTE FUNCTION raid_submission_insert_guard();
CREATE FUNCTION raid_submission_state_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (SELECT "state" FROM "Engagement" WHERE "id"=NEW."engagementId") IN ('IN_PROGRESS','REVISION_REQUESTED') THEN
  RAISE EXCEPTION 'Recording a submission must move the engagement to SUBMITTED' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "WorkSubmission_state_guard" AFTER INSERT ON "WorkSubmission" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION raid_submission_state_guard();
CREATE FUNCTION raid_review_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e record; latest integer; number integer;
BEGIN
 SELECT g."state",g."acceptedTerms",t."snapshot" AS definition INTO STRICT e FROM "Engagement" g JOIN "TermsVersion" t ON t."id"=g."termsVersionId" WHERE g."id"=NEW."engagementId" FOR SHARE OF g;
 IF e."state"<>'SUBMITTED' THEN RAISE EXCEPTION 'Review requires a SUBMITTED engagement' USING ERRCODE='23514'; END IF;
 SELECT "submissionNumber" INTO STRICT number FROM "WorkSubmission" WHERE "id"=NEW."submissionId";
 SELECT max("submissionNumber") INTO latest FROM "WorkSubmission" WHERE "engagementId"=NEW."engagementId";
 IF number<>latest THEN RAISE EXCEPTION 'Only the latest submission can be reviewed' USING ERRCODE='23514'; END IF;
 IF e.definition->'review'->>'reviewerAccountId' IS DISTINCT FROM NEW."reviewerAccountId" OR EXISTS (SELECT 1 FROM "EngagementMember" m JOIN "Participant" p ON p."id"=m."participantId" WHERE m."engagementId"=NEW."engagementId" AND p."accountId"=NEW."reviewerAccountId") THEN
  RAISE EXCEPTION 'Reviewer must be the exact independent terms reviewer' USING ERRCODE='23514';
 END IF;
 IF NEW."decision"='REQUEST_REVISION' AND (number>(e.definition->'review'->>'maxRevisionRounds')::integer OR NEW."revisionDeadline"<=clock_timestamp() OR NEW."revisionDeadline">(e.definition->'deadlines'->>'operationalClosure')::timestamptz) THEN
  RAISE EXCEPTION 'Revision request exceeds its bounded rounds or finite deadline' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "WorkReview_insert_guard" BEFORE INSERT ON "WorkReview" FOR EACH ROW EXECUTE FUNCTION raid_review_insert_guard();
CREATE FUNCTION raid_review_state_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected text;
BEGIN
 expected:=CASE NEW."decision" WHEN 'ACCEPT' THEN 'ACCEPTED' WHEN 'REQUEST_REVISION' THEN 'REVISION_REQUESTED' ELSE 'SUBMITTED' END;
 IF (SELECT "state" FROM "Engagement" WHERE "id"=NEW."engagementId") IS DISTINCT FROM expected THEN
  RAISE EXCEPTION 'Review decision and engagement state must commit together' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "WorkReview_state_guard" AFTER INSERT ON "WorkReview" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION raid_review_state_guard();
-- T020's inline CHECKs pinned new engagements to ACCESS_PENDING at revision 1; the widened CHECKs must not loosen that.
CREATE FUNCTION raid_engagement_initial_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."state"<>'ACCESS_PENDING' OR NEW."revision"<>1 THEN
  RAISE EXCEPTION 'A new engagement starts ACCESS_PENDING at revision 1' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "Engagement_initial_guard" BEFORE INSERT ON "Engagement" FOR EACH ROW EXECUTE FUNCTION raid_engagement_initial_guard();
-- Evidence also constrains the state: submission, revision request and acceptance each need their own latest record.
CREATE FUNCTION raid_lifecycle_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actual text; latest_id uuid; latest_decision text;
BEGIN
 SELECT "state" INTO STRICT actual FROM "Engagement" WHERE "id"=NEW."id";
 SELECT s."id", r."decision" INTO latest_id, latest_decision FROM "WorkSubmission" s LEFT JOIN "WorkReview" r ON r."submissionId"=s."id" WHERE s."engagementId"=NEW."id" ORDER BY s."submissionNumber" DESC LIMIT 1;
 IF (actual='SUBMITTED' AND (latest_id IS NULL OR latest_decision IS NOT NULL))
  OR (actual='REVISION_REQUESTED' AND latest_decision IS DISTINCT FROM 'REQUEST_REVISION')
  OR (actual='ACCEPTED' AND latest_decision IS DISTINCT FROM 'ACCEPT') THEN
  RAISE EXCEPTION 'Engagement state % lacks its latest submission or review evidence', actual USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "Engagement_evidence_guard" AFTER UPDATE OF "state" ON "Engagement" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION raid_lifecycle_evidence_guard();
COMMIT;
