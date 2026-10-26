BEGIN;
CREATE TABLE "RaidApplication" (
 "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 "slotId" uuid NOT NULL,
 "termsVersionId" uuid NOT NULL,
 "participantId" uuid NOT NULL REFERENCES "Participant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "evidenceRefs" jsonb NOT NULL CHECK (jsonb_typeof("evidenceRefs")='array' AND jsonb_array_length("evidenceRefs")<=10),
 "state" text NOT NULL DEFAULT 'SUBMITTED' CHECK ("state" IN ('SUBMITTED','WITHDRAWN','CLOSED')),
 "createdAt" timestamptz(6) NOT NULL DEFAULT now(),
 CONSTRAINT "RaidApplication_slotId_termsVersionId_fkey" FOREIGN KEY ("slotId","termsVersionId") REFERENCES "RaidSlot"("id","termsVersionId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "RaidApplication_id_slotId_participantId_termsVersionId_key" UNIQUE ("id","slotId","participantId","termsVersionId")
);
CREATE UNIQUE INDEX "RaidApplication_open_key" ON "RaidApplication"("slotId","participantId") WHERE "state"='SUBMITTED';
CREATE INDEX "RaidApplication_participantId_state_idx" ON "RaidApplication"("participantId","state");
CREATE TABLE "RaidOffer" (
 "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 "applicationId" uuid NOT NULL,
 "slotId" uuid NOT NULL,
 "termsVersionId" uuid NOT NULL,
 "participantId" uuid NOT NULL,
 "offeredByAccountId" text NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "expiresAt" timestamptz(6) NOT NULL,
 "state" text NOT NULL DEFAULT 'PENDING' CHECK ("state" IN ('PENDING','REVOKED','ACCEPTED')),
 "acceptedEngagementId" uuid UNIQUE REFERENCES "Engagement"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "createdAt" timestamptz(6) NOT NULL DEFAULT now(),
 CHECK (("state"='ACCEPTED')=("acceptedEngagementId" IS NOT NULL)),
 CONSTRAINT "RaidOffer_application_fkey" FOREIGN KEY ("applicationId","slotId","participantId","termsVersionId") REFERENCES "RaidApplication"("id","slotId","participantId","termsVersionId") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "RaidOffer_pending_key" ON "RaidOffer"("applicationId") WHERE "state"='PENDING';
CREATE INDEX "RaidOffer_slotId_state_idx" ON "RaidOffer"("slotId","state");
CREATE FUNCTION raid_admission_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; source record;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Admission history is retained' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-'state'-'acceptedEngagementId') IS DISTINCT FROM (to_jsonb(OLD)-'state'-'acceptedEngagementId') OR (TG_TABLE_NAME='RaidApplication' AND (OLD."state"<>'SUBMITTED' OR NEW."state" NOT IN ('WITHDRAWN','CLOSED'))) OR (TG_TABLE_NAME='RaidOffer' AND (OLD."state"<>'PENDING' OR NEW."state" NOT IN ('REVOKED','ACCEPTED'))) THEN
   RAISE EXCEPTION 'Admission intent is immutable; invalid transition' USING ERRCODE='23514';
  END IF;
 END IF;
 target:=NEW."slotId";
 PERFORM 1 FROM "WorkListing" WHERE "id"=(SELECT "listingId" FROM "RaidSlot" WHERE "id"=target) FOR UPDATE;
 PERFORM 1 FROM "RaidSlot" WHERE "id"=target FOR UPDATE;
 SELECT s."state",l."state" AS "listingState",l."currentTermsVersionId",l."creatorAccountId",t."snapshot" INTO STRICT source FROM "RaidSlot" s JOIN "WorkListing" l ON l."id"=s."listingId" JOIN "TermsVersion" t ON t."id"=s."termsVersionId" WHERE s."id"=target;
 IF TG_OP='INSERT' AND (source."state"<>'AVAILABLE' OR source."listingState"<>'OPEN' OR source."currentTermsVersionId"<>NEW."termsVersionId" OR source."snapshot"->>'admission'<>'APPLICATION' OR (source."snapshot"->'deadlines'->>'commitment')::timestamptz<=clock_timestamp()) THEN
  RAISE EXCEPTION 'Application source unavailable' USING ERRCODE='23514';
 END IF;
 IF TG_TABLE_NAME='RaidOffer' THEN
  IF TG_OP='INSERT' THEN
   IF NEW."state"<>'PENDING' OR NEW."offeredByAccountId"<>source."creatorAccountId" OR NEW."expiresAt"<=clock_timestamp() OR NEW."expiresAt">(source."snapshot"->'deadlines'->>'commitment')::timestamptz OR NOT EXISTS (SELECT 1 FROM "RaidApplication" WHERE "id"=NEW."applicationId" AND "state"='SUBMITTED') THEN
    RAISE EXCEPTION 'Invalid exact-source Founder offer' USING ERRCODE='23514';
   END IF;
  ELSIF NEW."state"='ACCEPTED' THEN
   IF OLD."expiresAt"<=clock_timestamp() OR NOT EXISTS (SELECT 1 FROM "RaidApplication" WHERE "id"=NEW."applicationId" AND "state"='SUBMITTED') OR NOT EXISTS (SELECT 1 FROM "Engagement" e JOIN "EngagementMember" m ON m."engagementId"=e."id" WHERE e."id"=NEW."acceptedEngagementId" AND e."slotId"=NEW."slotId" AND e."termsVersionId"=NEW."termsVersionId" AND m."participantId"=NEW."participantId") THEN
    RAISE EXCEPTION 'Offer acceptance must bind the actual exact engagement' USING ERRCODE='23514';
   END IF;
  END IF;
 ELSIF TG_OP='INSERT' AND NEW."state"<>'SUBMITTED' THEN
  RAISE EXCEPTION 'Applications start submitted' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "RaidApplication_guard" BEFORE INSERT OR UPDATE OR DELETE ON "RaidApplication" FOR EACH ROW EXECUTE FUNCTION raid_admission_guard();
CREATE TRIGGER "RaidOffer_guard" BEFORE INSERT OR UPDATE OR DELETE ON "RaidOffer" FOR EACH ROW EXECUTE FUNCTION raid_admission_guard();
-- Final assignment through an APPLICATION path must have its matching accepted offer.
CREATE FUNCTION raid_admission_engagement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (SELECT "snapshot"->>'admission' FROM "TermsVersion" WHERE "id"=NEW."termsVersionId")='APPLICATION' AND NOT EXISTS (SELECT 1 FROM "RaidOffer" WHERE "acceptedEngagementId"=NEW."id" AND "slotId"=NEW."slotId" AND "termsVersionId"=NEW."termsVersionId" AND "state"='ACCEPTED') THEN
  RAISE EXCEPTION 'Application engagement requires accepted exact offer' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "Engagement_admission_guard" AFTER INSERT ON "Engagement" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION raid_admission_engagement_guard();
COMMIT;
