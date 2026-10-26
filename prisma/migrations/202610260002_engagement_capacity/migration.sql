BEGIN;
CREATE TABLE "Engagement" (
 "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 "slotId" uuid NOT NULL UNIQUE,
 "termsVersionId" uuid NOT NULL,
 "guildId" text NOT NULL,
 "revision" integer NOT NULL DEFAULT 1 CHECK ("revision"=1),
 "generation" integer NOT NULL DEFAULT 1 CHECK ("generation"=1),
 "state" text NOT NULL DEFAULT 'ACCESS_PENDING' CHECK ("state"='ACCESS_PENDING'),
 "acceptedTerms" jsonb NOT NULL CHECK (jsonb_typeof("acceptedTerms")='object'),
 "acceptedDigest" text NOT NULL CHECK ("acceptedDigest" ~ '^[0-9a-f]{64}$'),
 "createdAt" timestamptz(6) NOT NULL DEFAULT now(),
 CONSTRAINT "Engagement_slotId_termsVersionId_fkey" FOREIGN KEY ("slotId","termsVersionId") REFERENCES "RaidSlot"("id","termsVersionId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "Engagement_id_termsVersionId_key" UNIQUE ("id","termsVersionId")
);
CREATE TABLE "EngagementMember" (
 "engagementId" uuid NOT NULL,
 "participantId" uuid NOT NULL REFERENCES "Participant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "termsVersionId" uuid NOT NULL,
 PRIMARY KEY ("engagementId","participantId"),
 CONSTRAINT "EngagementMember_engagementId_termsVersionId_fkey" FOREIGN KEY ("engagementId","termsVersionId") REFERENCES "Engagement"("id","termsVersionId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "EngagementMember_engagementId_participantId_termsVersionId_key" UNIQUE ("engagementId","participantId","termsVersionId")
);
CREATE TABLE "ActiveCommitment" (
 "participantId" uuid PRIMARY KEY REFERENCES "Participant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "engagementId" uuid NOT NULL,
 "termsVersionId" uuid NOT NULL,
 "acquiredAt" timestamptz(6) NOT NULL DEFAULT now(),
 CONSTRAINT "ActiveCommitment_engagementId_participantId_termsVersionId_fkey" FOREIGN KEY ("engagementId","participantId","termsVersionId") REFERENCES "EngagementMember"("engagementId","participantId","termsVersionId") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX "ActiveCommitment_engagementId_idx" ON "ActiveCommitment"("engagementId");
CREATE INDEX "EngagementMember_participantId_idx" ON "EngagementMember"("participantId");
CREATE FUNCTION raid_engagement_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source record; leg record;
BEGIN
 -- Match every existing source writer's listing -> slot order.
 PERFORM 1 FROM "WorkListing" WHERE "id"=(SELECT "listingId" FROM "RaidSlot" WHERE "id"=NEW."slotId") FOR UPDATE;
 PERFORM 1 FROM "RaidSlot" WHERE "id"=NEW."slotId" FOR UPDATE;
 SELECT s."state",s."fundingRef",l."guildId",l."state" AS "listingState",l."currentTermsVersionId",t."revision",t."snapshot" AS definition INTO STRICT source FROM "RaidSlot" s JOIN "WorkListing" l ON l."id"=s."listingId" JOIN "TermsVersion" t ON t."id"=s."termsVersionId" WHERE s."id"=NEW."slotId";
 IF source."state"<>'AVAILABLE' OR source."listingState"<>'OPEN' OR source."fundingRef" IS NULL OR source."currentTermsVersionId"<>NEW."termsVersionId" OR source."guildId"<>NEW."guildId" THEN
  RAISE EXCEPTION 'Engagement source is unavailable or mismatched' USING ERRCODE='23514';
 END IF;
 IF NEW."acceptedTerms"->>'id' IS DISTINCT FROM NEW."termsVersionId"::text OR NEW."acceptedTerms"->>'guildId' IS DISTINCT FROM NEW."guildId" OR (NEW."acceptedTerms"->>'revision')::integer IS DISTINCT FROM source."revision" OR NEW."acceptedTerms"->'acceptanceCriteria' IS DISTINCT FROM source.definition->'acceptanceCriteria' OR NEW."acceptedTerms"->'requiredSkills' IS DISTINCT FROM source.definition->'requiredSkills' OR NEW."acceptedTerms"->'deadlines' IS DISTINCT FROM ((source.definition->'deadlines') - 'commitment'::text) THEN
  RAISE EXCEPTION 'Accepted contract is not the immutable source version' USING ERRCODE='23514';
 END IF;
 IF jsonb_typeof(NEW."acceptedTerms"->'roster') IS DISTINCT FROM 'array' OR jsonb_array_length(NEW."acceptedTerms"->'roster')<1 OR (source.definition->>'execution'='SOLO' AND jsonb_array_length(NEW."acceptedTerms"->'roster')<>1) OR jsonb_typeof(NEW."acceptedTerms"->'rewards') IS DISTINCT FROM 'array' OR jsonb_array_length(NEW."acceptedTerms"->'rewards')<>jsonb_array_length(source.definition->'rewards') THEN
  RAISE EXCEPTION 'Unsupported roster or reward shape' USING ERRCODE='23514';
 END IF;
 FOR leg IN SELECT value,ordinality FROM jsonb_array_elements(NEW."acceptedTerms"->'rewards') WITH ORDINALITY LOOP
  IF leg.value->'policy' IS DISTINCT FROM (source.definition->'rewards'->(leg.ordinality::int-1)->'policy') OR leg.value->>'amount' IS DISTINCT FROM (source.definition->'rewards'->(leg.ordinality::int-1)->>'amount') OR leg.value->>'beneficiaryParticipantId' IS DISTINCT FROM (NEW."acceptedTerms"->'roster'->0->>'participantId') THEN
   RAISE EXCEPTION 'Accepted reward/beneficiary differs from source' USING ERRCODE='23514';
  END IF;
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER "Engagement_insert_guard" BEFORE INSERT ON "Engagement" FOR EACH ROW EXECUTE FUNCTION raid_engagement_insert_guard();
CREATE FUNCTION raid_engagement_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% history is immutable in this milestone',TG_TABLE_NAME USING ERRCODE='23514'; END $$;
-- No StartEngagement, member amendment or closure exists in T020. Subsequent commands require their own reviewed guards.
CREATE TRIGGER "Engagement_immutable" BEFORE UPDATE OR DELETE ON "Engagement" FOR EACH ROW EXECUTE FUNCTION raid_engagement_immutable();
CREATE TRIGGER "EngagementMember_immutable" BEFORE UPDATE OR DELETE ON "EngagementMember" FOR EACH ROW EXECUTE FUNCTION raid_engagement_immutable();
CREATE TRIGGER "ActiveCommitment_immutable" BEFORE UPDATE ON "ActiveCommitment" FOR EACH ROW EXECUTE FUNCTION raid_engagement_immutable();
CREATE FUNCTION raid_engagement_capacity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
 IF NOT EXISTS (SELECT 1 FROM "RaidSlot" WHERE "id"=e."slotId" AND "state"='FILLED') OR (SELECT count(*) FROM "EngagementMember" WHERE "engagementId"=target)<>roster_size OR (SELECT count(*) FROM "ActiveCommitment" WHERE "engagementId"=target)<>roster_size OR (SELECT count(DISTINCT value->>'participantId') FROM jsonb_array_elements(e."acceptedTerms"->'roster'))<>roster_size OR EXISTS (
  SELECT 1 FROM jsonb_array_elements(e."acceptedTerms"->'roster') member WHERE NOT EXISTS (SELECT 1 FROM "EngagementMember" m JOIN "ActiveCommitment" c ON c."engagementId"=m."engagementId" AND c."participantId"=m."participantId" AND c."termsVersionId"=m."termsVersionId" WHERE m."engagementId"=target AND m."participantId"=(member->>'participantId')::uuid AND m."termsVersionId"=e."termsVersionId")
 ) THEN RAISE EXCEPTION 'Engagement, source, roster and capacity must commit atomically' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "Engagement_capacity_guard" AFTER INSERT ON "Engagement" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION raid_engagement_capacity_guard();
CREATE CONSTRAINT TRIGGER "EngagementMember_capacity_guard" AFTER INSERT ON "EngagementMember" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION raid_engagement_capacity_guard();
CREATE CONSTRAINT TRIGGER "ActiveCommitment_capacity_guard" AFTER INSERT OR DELETE ON "ActiveCommitment" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION raid_engagement_capacity_guard();
CREATE CONSTRAINT TRIGGER "RaidSlot_capacity_guard" AFTER UPDATE ON "RaidSlot" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION raid_engagement_capacity_guard();
COMMIT;
