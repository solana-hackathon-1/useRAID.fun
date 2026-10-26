BEGIN;
-- Consented amendments version an accepted engagement without rewriting it. Engagement."acceptedTerms" stays the
-- immutable original; the effective promise is the latest ACCEPTED amendment, else that original.
CREATE TABLE "EngagementAmendment" (
 "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 "engagementId" uuid NOT NULL REFERENCES "Engagement"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "sequence" integer NOT NULL CHECK ("sequence">0),
 "snapshot" jsonb NOT NULL CHECK (jsonb_typeof("snapshot")='object'),
 "digest" text NOT NULL CHECK ("digest" ~ '^[0-9a-f]{64}$'),
 "proposedByAccountId" text NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "additionalFundingRef" text UNIQUE,
 "expiresAt" timestamptz(6) NOT NULL,
 "state" text NOT NULL DEFAULT 'PROPOSED' CHECK ("state" IN ('PROPOSED','ACCEPTED','DECLINED','WITHDRAWN')),
 "decidedByAccountId" text REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "consentRef" text,
 "decidedAt" timestamptz(6),
 "createdAt" timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT "EngagementAmendment_engagementId_sequence_key" UNIQUE ("engagementId","sequence"),
 CONSTRAINT "EngagementAmendment_decision_check" CHECK (
  ("state"='PROPOSED' AND "decidedAt" IS NULL AND "decidedByAccountId" IS NULL AND "consentRef" IS NULL)
  OR ("state"='ACCEPTED' AND "decidedAt" IS NOT NULL AND "decidedByAccountId" IS NOT NULL AND "consentRef" IS NOT NULL)
  OR ("state" IN ('DECLINED','WITHDRAWN') AND "decidedAt" IS NOT NULL AND "decidedByAccountId" IS NOT NULL AND "consentRef" IS NULL))
);
-- One open proposal per engagement.
CREATE UNIQUE INDEX "EngagementAmendment_open_key" ON "EngagementAmendment"("engagementId") WHERE "state"='PROPOSED';
CREATE INDEX "EngagementAmendment_proposedByAccountId_idx" ON "EngagementAmendment"("proposedByAccountId");

CREATE FUNCTION raid_effective_terms(target uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT COALESCE(
  (SELECT a."snapshot" FROM "EngagementAmendment" a WHERE a."engagementId"=target AND a."state"='ACCEPTED' ORDER BY a."sequence" DESC LIMIT 1),
  (SELECT e."acceptedTerms" FROM "Engagement" e WHERE e."id"=target))
$$;

CREATE FUNCTION raid_amendment_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE engagement_state text; eff jsonb; leg jsonb; old_leg jsonb; raw text; increase boolean:=false; legs integer; i integer; dl jsonb; times timestamptz[];
BEGIN
 IF NEW."state"<>'PROPOSED' THEN RAISE EXCEPTION 'A new amendment starts PROPOSED' USING ERRCODE='23514'; END IF;
 SELECT "state" INTO STRICT engagement_state FROM "Engagement" WHERE "id"=NEW."engagementId" FOR SHARE;
 IF engagement_state NOT IN ('ACCESS_PENDING','IN_PROGRESS') THEN
  RAISE EXCEPTION 'Only pending or in-progress work can be amended' USING ERRCODE='23514';
 END IF;
 IF NEW."sequence"<>COALESCE((SELECT max("sequence") FROM "EngagementAmendment" WHERE "engagementId"=NEW."engagementId"),0)+1 THEN
  RAISE EXCEPTION 'Amendment sequence must be the next version' USING ERRCODE='23514';
 END IF;
 IF EXISTS (SELECT 1 FROM "EngagementMember" m JOIN "Participant" p ON p."id"=m."participantId" WHERE m."engagementId"=NEW."engagementId" AND p."accountId"=NEW."proposedByAccountId") THEN
  RAISE EXCEPTION 'An affected member cannot propose an amendment to their own engagement' USING ERRCODE='23514';
 END IF;
 eff:=raid_effective_terms(NEW."engagementId");
 IF (NEW."snapshot"-'scope'-'acceptanceCriteria'-'rewards'-'deadlines') IS DISTINCT FROM (eff-'scope'-'acceptanceCriteria'-'rewards'-'deadlines') THEN
  RAISE EXCEPTION 'Only scope, acceptance criteria, reward amounts and deadlines are amendable' USING ERRCODE='23514';
 END IF;
 IF NEW."snapshot" IS NOT DISTINCT FROM eff THEN RAISE EXCEPTION 'Amendment changes nothing' USING ERRCODE='23514'; END IF;
 IF jsonb_typeof(NEW."snapshot"->'acceptanceCriteria') IS DISTINCT FROM 'array' OR jsonb_array_length(NEW."snapshot"->'acceptanceCriteria')<1 THEN
  RAISE EXCEPTION 'Acceptance criteria are required' USING ERRCODE='23514';
 END IF;
 IF jsonb_typeof(NEW."snapshot"->'rewards') IS DISTINCT FROM 'array' OR jsonb_array_length(NEW."snapshot"->'rewards') IS DISTINCT FROM jsonb_array_length(eff->'rewards') THEN
  RAISE EXCEPTION 'Reward legs are fixed; only their amounts may change' USING ERRCODE='23514';
 END IF;
 legs:=jsonb_array_length(eff->'rewards');
 FOR i IN 0..legs-1 LOOP
  leg:=NEW."snapshot"->'rewards'->i; old_leg:=eff->'rewards'->i;
  IF (leg-'amount') IS DISTINCT FROM (old_leg-'amount') THEN
   RAISE EXCEPTION 'Reward policy and beneficiary are fixed' USING ERRCODE='23514';
  END IF;
  raw:=leg->>'amount';
  IF jsonb_typeof(leg->'amount') IS DISTINCT FROM 'string' OR raw !~ '^[1-9][0-9]{0,19}$' OR raw::numeric>18446744073709551615 THEN
   RAISE EXCEPTION 'Reward amount must be a positive bounded base-unit integer' USING ERRCODE='23514';
  END IF;
  IF raw::numeric>(old_leg->>'amount')::numeric THEN increase:=true; END IF;
 END LOOP;
 IF increase AND NEW."additionalFundingRef" IS NULL THEN
  RAISE EXCEPTION 'A reward increase requires its exact additional funding reservation' USING ERRCODE='23514';
 END IF;
 IF NOT increase AND NEW."additionalFundingRef" IS NOT NULL THEN
  RAISE EXCEPTION 'A funding reservation requires a reward increase' USING ERRCODE='23514';
 END IF;
 IF NEW."additionalFundingRef" IS NOT NULL AND EXISTS (SELECT 1 FROM "RaidSlot" WHERE "fundingRef"=NEW."additionalFundingRef") THEN
  RAISE EXCEPTION 'Funding reference is already reserved for a slot' USING ERRCODE='23514';
 END IF;
 dl:=NEW."snapshot"->'deadlines';
 IF jsonb_typeof(dl) IS DISTINCT FROM 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(dl) k) IS DISTINCT FROM ARRAY['operationalClosure','preparation','review','submission'] THEN
  RAISE EXCEPTION 'Amended deadlines must be exactly the four accepted deadlines' USING ERRCODE='23514';
 END IF;
 times:=ARRAY[(NEW."snapshot"->>'createdAt')::timestamptz,(dl->>'preparation')::timestamptz,(dl->>'submission')::timestamptz,(dl->>'review')::timestamptz,(dl->>'operationalClosure')::timestamptz];
 IF times[2]<=times[1] OR times[3]<times[2] OR times[4]<times[3] OR times[5]<times[4] THEN
  RAISE EXCEPTION 'Deadlines must be finite and ordered' USING ERRCODE='23514';
 END IF;
 IF times[3]<=clock_timestamp() OR times[5]<=clock_timestamp() THEN
  RAISE EXCEPTION 'Amended deadlines must be in the future' USING ERRCODE='23514';
 END IF;
 IF NEW."expiresAt"<=clock_timestamp() OR NEW."expiresAt">(eff->'deadlines'->>'submission')::timestamptz THEN
  RAISE EXCEPTION 'A proposal must expire in the future and before the effective submission deadline' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "EngagementAmendment_insert_guard" BEFORE INSERT ON "EngagementAmendment" FOR EACH ROW EXECUTE FUNCTION raid_amendment_insert_guard();

CREATE FUNCTION raid_amendment_update_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE engagement_state text; dl jsonb;
BEGIN
 IF (to_jsonb(NEW)-'state'-'decidedByAccountId'-'consentRef'-'decidedAt') IS DISTINCT FROM (to_jsonb(OLD)-'state'-'decidedByAccountId'-'consentRef'-'decidedAt') THEN
  RAISE EXCEPTION 'Amendment content is immutable' USING ERRCODE='23514';
 END IF;
 IF OLD."state"<>'PROPOSED' THEN RAISE EXCEPTION 'A decided amendment is final' USING ERRCODE='23514'; END IF;
 IF NEW."state"='WITHDRAWN' THEN
  IF NEW."decidedByAccountId" IS DISTINCT FROM NEW."proposedByAccountId" THEN
   RAISE EXCEPTION 'Only the proposer can withdraw a proposal' USING ERRCODE='23514';
  END IF;
 ELSIF NEW."state" IN ('ACCEPTED','DECLINED') THEN
  IF NOT EXISTS (SELECT 1 FROM "EngagementMember" m JOIN "Participant" p ON p."id"=m."participantId" WHERE m."engagementId"=NEW."engagementId" AND p."accountId"=NEW."decidedByAccountId") THEN
   RAISE EXCEPTION 'Only an affected member can consent to or decline an amendment' USING ERRCODE='23514';
  END IF;
  IF NEW."state"='ACCEPTED' THEN
   SELECT "state" INTO STRICT engagement_state FROM "Engagement" WHERE "id"=NEW."engagementId" FOR SHARE;
   IF engagement_state NOT IN ('ACCESS_PENDING','IN_PROGRESS') THEN
    RAISE EXCEPTION 'Only pending or in-progress work can accept an amendment' USING ERRCODE='23514';
   END IF;
   dl:=NEW."snapshot"->'deadlines';
   IF NEW."expiresAt"<=clock_timestamp() OR (dl->>'submission')::timestamptz<=clock_timestamp() OR (dl->>'operationalClosure')::timestamptz<=clock_timestamp() THEN
    RAISE EXCEPTION 'The proposal or its amended deadlines have expired' USING ERRCODE='23514';
   END IF;
  END IF;
 ELSE
  RAISE EXCEPTION 'A proposal can only be accepted, declined or withdrawn' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "EngagementAmendment_update_guard" BEFORE UPDATE ON "EngagementAmendment" FOR EACH ROW EXECUTE FUNCTION raid_amendment_update_guard();
CREATE TRIGGER "EngagementAmendment_immutable_delete" BEFORE DELETE ON "EngagementAmendment" FOR EACH ROW EXECUTE FUNCTION raid_engagement_immutable();
-- Slot reservations and amendment reservations are distinct funds, in both directions.
CREATE FUNCTION raid_slot_funding_distinct() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."fundingRef" IS NOT NULL AND EXISTS (SELECT 1 FROM "EngagementAmendment" WHERE "additionalFundingRef"=NEW."fundingRef") THEN
  RAISE EXCEPTION 'Funding reference is already reserved for an amendment' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "RaidSlot_funding_distinct" BEFORE INSERT OR UPDATE OF "fundingRef" ON "RaidSlot" FOR EACH ROW EXECUTE FUNCTION raid_slot_funding_distinct();

-- Effective (possibly amended) deadlines govern submission, review revision bounds and operations closure.
CREATE OR REPLACE FUNCTION raid_submission_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e record; due timestamptz;
BEGIN
 SELECT g."state",(t."snapshot"->'review'->>'maxRevisionRounds')::integer AS rounds INTO STRICT e FROM "Engagement" g JOIN "TermsVersion" t ON t."id"=g."termsVersionId" WHERE g."id"=NEW."engagementId" FOR SHARE OF g;
 IF e."state" NOT IN ('IN_PROGRESS','REVISION_REQUESTED') THEN
  RAISE EXCEPTION 'Submission requires an active IN_PROGRESS or REVISION_REQUESTED engagement' USING ERRCODE='23514';
 END IF;
 IF NEW."submissionNumber"<>COALESCE((SELECT max("submissionNumber") FROM "WorkSubmission" WHERE "engagementId"=NEW."engagementId"),0)+1 OR NEW."submissionNumber">1+e.rounds THEN
  RAISE EXCEPTION 'Submission number must be the next bounded round' USING ERRCODE='23514';
 END IF;
 -- First submission is due by the effective submission deadline; a revision by the reviewer's recorded finite deadline.
 IF e."state"='REVISION_REQUESTED' THEN
  SELECT r."revisionDeadline" INTO due FROM "WorkReview" r JOIN "WorkSubmission" s ON s."id"=r."submissionId" WHERE s."engagementId"=NEW."engagementId" ORDER BY s."submissionNumber" DESC LIMIT 1;
 ELSE due:=(raid_effective_terms(NEW."engagementId")->'deadlines'->>'submission')::timestamptz; END IF;
 IF due IS NULL OR due<=clock_timestamp() THEN
  RAISE EXCEPTION 'Submission deadline has passed' USING ERRCODE='23514';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM "ActiveCommitment" WHERE "engagementId"=NEW."engagementId" AND "participantId"=NEW."submitterParticipantId") THEN
  RAISE EXCEPTION 'Submitter must hold this engagement''s active commitment' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION raid_review_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e record; latest integer; number integer;
BEGIN
 SELECT g."state",t."snapshot" AS definition INTO STRICT e FROM "Engagement" g JOIN "TermsVersion" t ON t."id"=g."termsVersionId" WHERE g."id"=NEW."engagementId" FOR SHARE OF g;
 IF e."state"<>'SUBMITTED' THEN RAISE EXCEPTION 'Review requires a SUBMITTED engagement' USING ERRCODE='23514'; END IF;
 SELECT "submissionNumber" INTO STRICT number FROM "WorkSubmission" WHERE "id"=NEW."submissionId";
 SELECT max("submissionNumber") INTO latest FROM "WorkSubmission" WHERE "engagementId"=NEW."engagementId";
 IF number<>latest THEN RAISE EXCEPTION 'Only the latest submission can be reviewed' USING ERRCODE='23514'; END IF;
 IF e.definition->'review'->>'reviewerAccountId' IS DISTINCT FROM NEW."reviewerAccountId" OR EXISTS (SELECT 1 FROM "EngagementMember" m JOIN "Participant" p ON p."id"=m."participantId" WHERE m."engagementId"=NEW."engagementId" AND p."accountId"=NEW."reviewerAccountId") THEN
  RAISE EXCEPTION 'Reviewer must be the exact independent terms reviewer' USING ERRCODE='23514';
 END IF;
 IF NEW."decision"='REQUEST_REVISION' AND (number>(e.definition->'review'->>'maxRevisionRounds')::integer OR NEW."revisionDeadline"<=clock_timestamp() OR NEW."revisionDeadline">(raid_effective_terms(NEW."engagementId")->'deadlines'->>'operationalClosure')::timestamptz) THEN
  RAISE EXCEPTION 'Revision request exceeds its bounded rounds or finite deadline' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION raid_closure_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e record; expected text;
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
 ELSIF clock_timestamp()<(raid_effective_terms(NEW."engagementId")->'deadlines'->>'operationalClosure')::timestamptz THEN
  RAISE EXCEPTION 'Timeout closure is not due before the accepted operational deadline' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;

-- A replacement is a fresh slot with its own terms and reservation, linked to the closed attempt it follows.
CREATE TABLE "RaidReplacement" (
 "originalEngagementId" uuid PRIMARY KEY REFERENCES "Engagement"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "originalSlotId" uuid NOT NULL UNIQUE REFERENCES "RaidSlot"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "replacementSlotId" uuid NOT NULL UNIQUE REFERENCES "RaidSlot"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "createdByAccountId" text NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "createdAt" timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT "RaidReplacement_distinct_check" CHECK ("originalSlotId"<>"replacementSlotId")
);
CREATE INDEX "RaidReplacement_createdByAccountId_idx" ON "RaidReplacement"("createdByAccountId");
CREATE FUNCTION raid_replacement_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original record; replacement record;
BEGIN
 SELECT e."state",e."slotId",e."guildId",l."creatorAccountId",l."id" AS "listingId",s."fundingRef" INTO original
  FROM "Engagement" e JOIN "RaidSlot" s ON s."id"=e."slotId" JOIN "WorkListing" l ON l."id"=s."listingId" WHERE e."id"=NEW."originalEngagementId" FOR SHARE OF e;
 IF NOT FOUND OR original."state"<>'TERMINATED' OR original."slotId"<>NEW."originalSlotId"
   OR NOT EXISTS (SELECT 1 FROM "EngagementClosure" WHERE "engagementId"=NEW."originalEngagementId" AND "finalState"='TERMINATED') THEN
  RAISE EXCEPTION 'Only a terminated, closed engagement can be replaced' USING ERRCODE='23514';
 END IF;
 SELECT s."state",s."fundingRef",l."id" AS "listingId",l."guildId",l."creatorAccountId",l."state" AS "listingState" INTO replacement
  FROM "RaidSlot" s JOIN "WorkListing" l ON l."id"=s."listingId" WHERE s."id"=NEW."replacementSlotId" FOR SHARE OF s;
 IF NOT FOUND OR replacement."state"<>'AVAILABLE' OR replacement."listingState"<>'OPEN' OR replacement."fundingRef" IS NULL
   OR replacement."fundingRef" IS NOT DISTINCT FROM original."fundingRef"
   OR replacement."listingId"=original."listingId" OR replacement."guildId"<>original."guildId"
   OR replacement."creatorAccountId"<>original."creatorAccountId" OR NEW."createdByAccountId"<>original."creatorAccountId"
   OR EXISTS (SELECT 1 FROM "Engagement" WHERE "slotId"=NEW."replacementSlotId") THEN
  RAISE EXCEPTION 'A replacement must be a distinct, funded, open slot of the same Founder and Guild' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "RaidReplacement_insert_guard" BEFORE INSERT ON "RaidReplacement" FOR EACH ROW EXECUTE FUNCTION raid_replacement_insert_guard();
CREATE TRIGGER "RaidReplacement_immutable" BEFORE UPDATE OR DELETE ON "RaidReplacement" FOR EACH ROW EXECUTE FUNCTION raid_engagement_immutable();
COMMIT;
