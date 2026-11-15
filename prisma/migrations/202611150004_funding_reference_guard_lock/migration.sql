BEGIN;
-- #269-3: fold the funding-reference serialization of 202610270002 into the existing BEFORE guards from 202610260006, so
-- each table has one funding-reference check instead of a guard plus a duplicate AFTER trigger. Each guard takes the
-- transaction-scoped per-reference lock and then reads: a READ COMMITTED writer that waited on the lock re-reads in a new
-- statement snapshot, so it sees the earlier writer's committed row. The lock key is unchanged (seed 0, prefix
-- 'raid:funding-reference:'), so the application-side lockFundingReference in amendment-storage.ts still serializes with
-- it. The unique indexes on RaidSlot."fundingRef" and EngagementAmendment."additionalFundingRef" are untouched.
-- Policy is unchanged: a reference reserved for a slot cannot be reused by an amendment, and the reverse (SQLSTATE 23514).
DROP TRIGGER "EngagementAmendment_funding_serialize" ON "EngagementAmendment";
DROP TRIGGER "RaidSlot_funding_serialize" ON "RaidSlot";
DROP FUNCTION raid_amendment_funding_serialize();
DROP FUNCTION raid_slot_funding_serialize();

-- Body identical to 202610260006 except the funding-reference block, which now takes the lock before its check.
CREATE OR REPLACE FUNCTION raid_amendment_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
 IF NEW."additionalFundingRef" IS NOT NULL THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('raid:funding-reference:'||NEW."additionalFundingRef",0));
  IF EXISTS (SELECT 1 FROM "RaidSlot" WHERE "fundingRef"=NEW."additionalFundingRef") THEN
   RAISE EXCEPTION 'Funding reference is already reserved for a slot' USING ERRCODE='23514';
  END IF;
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

CREATE OR REPLACE FUNCTION raid_slot_funding_distinct() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."fundingRef" IS NOT NULL THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('raid:funding-reference:'||NEW."fundingRef",0));
  IF EXISTS (SELECT 1 FROM "EngagementAmendment" WHERE "additionalFundingRef"=NEW."fundingRef") THEN
   RAISE EXCEPTION 'Funding reference is already reserved for an amendment' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
COMMIT;
