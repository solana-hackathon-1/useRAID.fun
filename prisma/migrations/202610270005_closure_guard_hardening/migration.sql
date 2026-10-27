BEGIN;
-- Closure insert guard (supersedes 202610260006's body): a timeout closure needs an operational deadline that exists and
-- has passed (NULL no longer passes), and the closure time is the database clock's rather than a writer-supplied value.
CREATE OR REPLACE FUNCTION raid_closure_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e record; expected text; due timestamptz;
BEGIN
 SELECT "state" INTO STRICT e FROM "Engagement" WHERE "id"=NEW."engagementId" FOR SHARE;
 expected:=CASE NEW."reason" WHEN 'ACCEPTED' THEN 'SUBMITTED' WHEN 'ACCESS_TIMEOUT' THEN 'ACCESS_PENDING' WHEN 'SUBMISSION_TIMEOUT' THEN 'IN_PROGRESS' WHEN 'REVIEW_TIMEOUT' THEN 'SUBMITTED' ELSE 'REVISION_REQUESTED' END;
 IF e."state" IS DISTINCT FROM expected THEN
  RAISE EXCEPTION 'Closure reason % does not match engagement state %', NEW."reason", e."state" USING ERRCODE='23514';
 END IF;
 IF NEW."reason"='ACCEPTED' THEN
  IF NOT EXISTS (SELECT 1 FROM "WorkReview" r JOIN "WorkSubmission" s ON s."id"=r."submissionId" WHERE s."engagementId"=NEW."engagementId" AND r."decision"='ACCEPT' AND s."submissionNumber"=(SELECT max("submissionNumber") FROM "WorkSubmission" WHERE "engagementId"=NEW."engagementId")) THEN
   RAISE EXCEPTION 'Acceptance closure requires an ACCEPT review of the latest submission' USING ERRCODE='23514';
  END IF;
 ELSE
  due:=(raid_effective_terms(NEW."engagementId")->'deadlines'->>'operationalClosure')::timestamptz;
  IF due IS NULL OR clock_timestamp()<due THEN
   RAISE EXCEPTION 'Timeout closure is not due before the accepted operational deadline' USING ERRCODE='23514';
  END IF;
 END IF;
 NEW."closedAt":=clock_timestamp();
 RETURN NEW;
END $$;
-- A terminal transition needs the closure whose reason names the state being left, checked per transition so a
-- same-transaction chain (IN_PROGRESS -> SUBMITTED -> TERMINATED) cannot borrow a closure meant for the first state.
CREATE OR REPLACE FUNCTION raid_engagement_lifecycle_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Engagement history is immutable' USING ERRCODE='23514'; END IF;
 IF (to_jsonb(NEW)-'state'-'revision') IS DISTINCT FROM (to_jsonb(OLD)-'state'-'revision') THEN
  RAISE EXCEPTION 'Accepted engagement terms and identity are immutable' USING ERRCODE='23514';
 END IF;
 IF NEW."revision"<>OLD."revision"+1 THEN
  RAISE EXCEPTION 'Engagement revision must advance exactly once per transition' USING ERRCODE='23514';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM (VALUES ('ACCESS_PENDING','IN_PROGRESS'),('IN_PROGRESS','SUBMITTED'),('REVISION_REQUESTED','SUBMITTED'),('SUBMITTED','REVISION_REQUESTED'),('SUBMITTED','ACCEPTED'),('ACCESS_PENDING','TERMINATED'),('IN_PROGRESS','TERMINATED'),('SUBMITTED','TERMINATED'),('REVISION_REQUESTED','TERMINATED')) AS allowed("fromState","toState") WHERE allowed."fromState"=OLD."state" AND allowed."toState"=NEW."state") THEN
  RAISE EXCEPTION 'Engagement transition % -> % is not permitted', OLD."state", NEW."state" USING ERRCODE='23514';
 END IF;
 IF NEW."state" IN ('ACCEPTED','TERMINATED') AND NOT EXISTS (
  SELECT 1 FROM "EngagementClosure" c WHERE c."engagementId"=NEW."id" AND c."finalState"=NEW."state"
   AND c."reason"=CASE OLD."state" WHEN 'ACCESS_PENDING' THEN 'ACCESS_TIMEOUT' WHEN 'IN_PROGRESS' THEN 'SUBMISSION_TIMEOUT' WHEN 'REVISION_REQUESTED' THEN 'REVISION_TIMEOUT'
    ELSE CASE NEW."state" WHEN 'ACCEPTED' THEN 'ACCEPTED' ELSE 'REVIEW_TIMEOUT' END END) THEN
  RAISE EXCEPTION 'Closure record does not match the state % it closes', OLD."state" USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
COMMIT;
