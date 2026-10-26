BEGIN;
-- Enforce exact positive u64 base-unit rewards even for direct SQL writes.
CREATE FUNCTION raid_terms_reward_bounds(snapshot jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE reward jsonb; raw text;
BEGIN
 IF jsonb_typeof(snapshot->'rewards') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 IF jsonb_array_length(snapshot->'rewards') NOT BETWEEN 1 AND 10 THEN RETURN false; END IF;
 FOR reward IN SELECT * FROM jsonb_array_elements(snapshot->'rewards') LOOP
  raw := reward->>'amount';
  IF jsonb_typeof(reward->'amount') IS DISTINCT FROM 'string' OR raw !~ '^[1-9][0-9]{0,19}$' THEN RETURN false; END IF;
  IF raw::numeric > 18446744073709551615 THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END $$;
-- Additive work lifecycle; legacy social campaigns and financial tables are untouched.
CREATE TABLE "WorkListing" (
 "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 "guildId" text NOT NULL,
 "creatorAccountId" text NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "revision" integer NOT NULL DEFAULT 0 CHECK ("revision">=0),
 "currentTermsVersionId" uuid,
 "state" text NOT NULL DEFAULT 'DRAFT' CHECK ("state" IN ('DRAFT','OPEN','PAUSED','CLOSED','CANCELLED','ARCHIVED')),
 "createdAt" timestamptz(6) NOT NULL DEFAULT now(),
 CONSTRAINT "WorkListing_current_check" CHECK (("currentTermsVersionId" IS NULL AND "revision"=0 AND "state"='DRAFT') OR ("currentTermsVersionId" IS NOT NULL AND "revision">0))
);
CREATE TABLE "TermsVersion" (
 "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 "listingId" uuid NOT NULL REFERENCES "WorkListing"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "revision" integer NOT NULL CHECK ("revision">0),
 "snapshot" jsonb NOT NULL CHECK (jsonb_typeof("snapshot")='object' AND coalesce("snapshot"->>'version'='v1',false) AND raid_terms_reward_bounds("snapshot") AND coalesce("snapshot"->>'settlementMechanism'='SIMULATED',false) AND coalesce("snapshot"->'fees'->>'amount'='0',false)),
 "digest" text NOT NULL CHECK ("digest" ~ '^[0-9a-f]{64}$'),
 "createdAt" timestamptz(6) NOT NULL DEFAULT now(),
 CONSTRAINT "TermsVersion_listingId_revision_key" UNIQUE ("listingId","revision"),
 CONSTRAINT "TermsVersion_id_listingId_key" UNIQUE ("id","listingId"),
 CONSTRAINT "TermsVersion_id_listingId_revision_key" UNIQUE ("id","listingId","revision")
);
ALTER TABLE "WorkListing" ADD CONSTRAINT "WorkListing_currentTermsVersionId_id_revision_fkey" FOREIGN KEY ("currentTermsVersionId","id","revision") REFERENCES "TermsVersion"("id","listingId","revision") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE "RaidSlot" (
 "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 "listingId" uuid NOT NULL REFERENCES "WorkListing"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "termsVersionId" uuid NOT NULL,
 "slotNumber" integer NOT NULL CHECK ("slotNumber">0),
 "state" text NOT NULL DEFAULT 'AVAILABLE' CHECK ("state" IN ('AVAILABLE','FILLED','CLOSED')),
 "fundingMode" text NOT NULL DEFAULT 'SIMULATED' CHECK ("fundingMode"='SIMULATED'),
 "fundingRef" text UNIQUE,
 "createdAt" timestamptz(6) NOT NULL DEFAULT now(),
 CONSTRAINT "RaidSlot_termsVersionId_listingId_fkey" FOREIGN KEY ("termsVersionId","listingId") REFERENCES "TermsVersion"("id","listingId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "RaidSlot_listingId_termsVersionId_slotNumber_key" UNIQUE ("listingId","termsVersionId","slotNumber"),
 CONSTRAINT "RaidSlot_id_termsVersionId_key" UNIQUE ("id","termsVersionId")
);
CREATE INDEX "WorkListing_creatorAccountId_createdAt_idx" ON "WorkListing"("creatorAccountId","createdAt");
CREATE INDEX "RaidSlot_listingId_state_idx" ON "RaidSlot"("listingId","state");
CREATE FUNCTION raid_terms_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'TermsVersion is immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER "TermsVersion_immutable" BEFORE UPDATE OR DELETE ON "TermsVersion" FOR EACH ROW EXECUTE FUNCTION raid_terms_immutable();
CREATE FUNCTION raid_terms_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source "WorkListing";
BEGIN
 SELECT * INTO STRICT source FROM "WorkListing" WHERE "id"=NEW."listingId" FOR UPDATE;
 IF NEW."revision"<>source."revision"+1 OR EXISTS (SELECT 1 FROM "RaidSlot" WHERE "listingId"=source."id" AND "state"='FILLED') THEN
  RAISE EXCEPTION 'Terms revision conflict or assigned source' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "TermsVersion_insert_guard" BEFORE INSERT ON "TermsVersion" FOR EACH ROW EXECUTE FUNCTION raid_terms_insert_guard();
CREATE FUNCTION raid_listing_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."id"<>OLD."id" OR NEW."guildId"<>OLD."guildId" OR NEW."creatorAccountId"<>OLD."creatorAccountId" OR NEW."createdAt"<>OLD."createdAt" THEN
  RAISE EXCEPTION 'Listing identity is immutable' USING ERRCODE='23514';
 END IF;
 IF (NEW."revision",NEW."currentTermsVersionId") IS DISTINCT FROM (OLD."revision",OLD."currentTermsVersionId") THEN
  IF NEW."revision"<>OLD."revision"+1 OR NEW."state"<>'DRAFT' OR EXISTS (SELECT 1 FROM "RaidSlot" WHERE "listingId"=OLD."id" AND "state"='FILLED') THEN
   RAISE EXCEPTION 'Assigned listing cannot be amended' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "WorkListing_guard" BEFORE UPDATE ON "WorkListing" FOR EACH ROW EXECUTE FUNCTION raid_listing_guard();
CREATE FUNCTION raid_slot_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 -- All source commands lock listing before slot, including raw updates guarded here.
 PERFORM 1 FROM "WorkListing" WHERE "id"=OLD."listingId" FOR UPDATE;
 IF NEW."id"<>OLD."id" OR NEW."listingId"<>OLD."listingId" OR NEW."termsVersionId"<>OLD."termsVersionId" OR NEW."slotNumber"<>OLD."slotNumber" OR NEW."fundingMode"<>OLD."fundingMode" OR NEW."createdAt"<>OLD."createdAt" OR (OLD."fundingRef" IS NOT NULL AND NEW."fundingRef" IS DISTINCT FROM OLD."fundingRef") OR (OLD."state" IN ('FILLED','CLOSED') AND NEW."state"<>OLD."state") THEN
  RAISE EXCEPTION 'Slot binding/history is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "RaidSlot_guard" BEFORE UPDATE ON "RaidSlot" FOR EACH ROW EXECUTE FUNCTION raid_slot_guard();

COMMIT;
