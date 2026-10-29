BEGIN;
-- Party rosters, the immutable roster/split snapshot and per-member consent (blueprint §14.2-14.3). A Party label is only
-- a coordinator: the leader proposes, but each HUMAN member consents under their own session to the exact snapshot digest,
-- terms version, role and per-asset allocation. Nothing here accepts work, holds capacity or moves money.
CREATE TABLE "Party" (
 "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 "name" text NOT NULL CHECK (char_length("name") BETWEEN 1 AND 200 AND btrim("name")="name"),
 "leaderParticipantId" uuid NOT NULL REFERENCES "Participant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "receiptId" uuid NOT NULL UNIQUE REFERENCES "CommandReceipt"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "createdAt" timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT "Party_leader_key" UNIQUE ("id","leaderParticipantId")
);
CREATE INDEX "Party_leaderParticipantId_idx" ON "Party"("leaderParticipantId");

-- snapshot: {"members":[{"participantId","role","allocations":[{"amount":"<integer base units>"}, ...]}]}, one allocation per
-- reward leg of the proposal's terms, in leg order. The relational mirror below carries the foreign keys.
CREATE TABLE "PartyProposal" (
 "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 "partyId" uuid NOT NULL,
 "leaderParticipantId" uuid NOT NULL,
 "slotId" uuid NOT NULL,
 "termsVersionId" uuid NOT NULL,
 "termsDigest" text NOT NULL CHECK ("termsDigest" ~ '^[0-9a-f]{64}$'),
 "snapshot" jsonb NOT NULL CHECK (jsonb_typeof("snapshot")='object'),
 "snapshotDigest" text NOT NULL CHECK ("snapshotDigest" ~ '^[0-9a-f]{64}$'),
 "receiptId" uuid NOT NULL UNIQUE REFERENCES "CommandReceipt"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "createdAt" timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT "PartyProposal_party_fkey" FOREIGN KEY ("partyId","leaderParticipantId") REFERENCES "Party"("id","leaderParticipantId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "PartyProposal_slot_fkey" FOREIGN KEY ("slotId","termsVersionId") REFERENCES "RaidSlot"("id","termsVersionId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "PartyProposal_digest_key" UNIQUE ("id","snapshotDigest")
);
CREATE INDEX "PartyProposal_partyId_idx" ON "PartyProposal"("partyId");
CREATE INDEX "PartyProposal_slotId_idx" ON "PartyProposal"("slotId");

CREATE TABLE "PartyProposalMember" (
 "proposalId" uuid NOT NULL REFERENCES "PartyProposal"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "participantId" uuid NOT NULL REFERENCES "Participant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "role" text NOT NULL CHECK (char_length("role") BETWEEN 1 AND 100 AND btrim("role")="role"),
 "allocations" jsonb NOT NULL CHECK (jsonb_typeof("allocations")='array' AND jsonb_array_length("allocations") BETWEEN 1 AND 10),
 PRIMARY KEY ("proposalId","participantId")
);
CREATE INDEX "PartyProposalMember_participantId_idx" ON "PartyProposalMember"("participantId");

CREATE TABLE "PartyMemberConsent" (
 "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 "proposalId" uuid NOT NULL,
 "participantId" uuid NOT NULL,
 "snapshotDigest" text NOT NULL,
 "receiptId" uuid NOT NULL UNIQUE REFERENCES "CommandReceipt"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 "consentedAt" timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT "PartyMemberConsent_member_fkey" FOREIGN KEY ("proposalId","participantId") REFERENCES "PartyProposalMember"("proposalId","participantId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "PartyMemberConsent_proposal_fkey" FOREIGN KEY ("proposalId","snapshotDigest") REFERENCES "PartyProposal"("id","snapshotDigest") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "PartyMemberConsent_subject_key" UNIQUE ("proposalId","participantId")
);

-- The leader of a new Party is the commanding account's own participant, never another person's.
CREATE FUNCTION raid_party_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor record;
BEGIN
 SELECT r."actorId",r."commandKind",p."accountId",p."kind" INTO STRICT actor
  FROM "CommandReceipt" r, "Participant" p WHERE r."id"=NEW."receiptId" AND p."id"=NEW."leaderParticipantId";
 IF actor."actorId"<>actor."accountId" OR actor."kind"<>'HUMAN' OR actor."commandKind"<>'CreateParty' THEN
  RAISE EXCEPTION 'A Party leader is the commanding human participant' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "Party_guard" BEFORE INSERT ON "Party" FOR EACH ROW EXECUTE FUNCTION raid_party_guard();
CREATE TRIGGER "Party_immutable" BEFORE UPDATE OR DELETE ON "Party" FOR EACH ROW EXECUTE FUNCTION raid_engagement_immutable();

-- Only the Party's leader proposes, for the available slot's current PARTY terms, naming the exact stored digest.
CREATE FUNCTION raid_party_proposal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor record; source record;
BEGIN
 SELECT r."actorId",r."commandKind",p."accountId" INTO STRICT actor
  FROM "CommandReceipt" r, "Participant" p WHERE r."id"=NEW."receiptId" AND p."id"=NEW."leaderParticipantId";
 IF actor."actorId"<>actor."accountId" OR actor."commandKind"<>'ProposePartyRoster' THEN
  RAISE EXCEPTION 'Only the Party leader proposes its roster' USING ERRCODE='23514';
 END IF;
 SELECT s."state",l."state" AS "listingState",l."currentTermsVersionId",t."digest",t."snapshot"->>'execution' AS "execution" INTO STRICT source
  FROM "RaidSlot" s JOIN "WorkListing" l ON l."id"=s."listingId" JOIN "TermsVersion" t ON t."id"=s."termsVersionId"
  WHERE s."id"=NEW."slotId" AND s."termsVersionId"=NEW."termsVersionId";
 IF source."state"<>'AVAILABLE' OR source."listingState"<>'OPEN' OR source."currentTermsVersionId"<>NEW."termsVersionId" THEN
  RAISE EXCEPTION 'A roster is proposed for an available slot on the current terms' USING ERRCODE='23514';
 END IF;
 IF source."execution"<>'PARTY' THEN RAISE EXCEPTION 'Only PARTY terms take a roster' USING ERRCODE='23514'; END IF;
 IF source."digest" IS DISTINCT FROM NEW."termsDigest" THEN
  RAISE EXCEPTION 'A roster names the exact stored terms digest' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "PartyProposal_guard" BEFORE INSERT ON "PartyProposal" FOR EACH ROW EXECUTE FUNCTION raid_party_proposal_guard();
CREATE TRIGGER "PartyProposal_immutable" BEFORE UPDATE OR DELETE ON "PartyProposal" FOR EACH ROW EXECUTE FUNCTION raid_engagement_immutable();

-- A mirrored member must be exactly a human member of the immutable snapshot, with one exact-units allocation per reward leg.
CREATE FUNCTION raid_party_member_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE proposal record; entry jsonb; legs integer; kind text; i integer;
BEGIN
 SELECT p."snapshot",t."snapshot"->'rewards' AS "rewards" INTO STRICT proposal
  FROM "PartyProposal" p JOIN "TermsVersion" t ON t."id"=p."termsVersionId" WHERE p."id"=NEW."proposalId";
 SELECT e INTO entry FROM jsonb_array_elements(proposal."snapshot"->'members') e WHERE e->>'participantId'=NEW."participantId"::text;
 IF entry IS NULL OR entry->>'role' IS DISTINCT FROM NEW."role" OR entry->'allocations' IS DISTINCT FROM NEW."allocations" THEN
  RAISE EXCEPTION 'A roster member must match the immutable snapshot' USING ERRCODE='23514';
 END IF;
 SELECT p."kind" INTO kind FROM "Participant" p WHERE p."id"=NEW."participantId";
 IF kind IS DISTINCT FROM 'HUMAN' THEN RAISE EXCEPTION 'Only human members consent in this milestone' USING ERRCODE='23514'; END IF;
 legs := jsonb_array_length(proposal."rewards");
 IF jsonb_array_length(NEW."allocations")<>legs THEN
  RAISE EXCEPTION 'A member needs one allocation per reward leg' USING ERRCODE='23514';
 END IF;
 FOR i IN 0..legs-1 LOOP
  IF jsonb_typeof(NEW."allocations"->i)<>'object' OR (SELECT array_agg(k) FROM jsonb_object_keys(NEW."allocations"->i) k) IS DISTINCT FROM ARRAY['amount']
   OR jsonb_typeof(NEW."allocations"->i->'amount')<>'string' OR NEW."allocations"->i->>'amount' !~ '^(0|[1-9][0-9]{0,77})$' THEN
   RAISE EXCEPTION 'An allocation is an exact integer amount of base units' USING ERRCODE='23514';
  END IF;
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER "PartyProposalMember_guard" BEFORE INSERT ON "PartyProposalMember" FOR EACH ROW EXECUTE FUNCTION raid_party_member_guard();
CREATE TRIGGER "PartyProposalMember_immutable" BEFORE UPDATE OR DELETE ON "PartyProposalMember" FOR EACH ROW EXECUTE FUNCTION raid_engagement_immutable();

-- At commit the mirror must be the whole snapshot and each reward leg must be allocated exactly: no dust, no shortfall.
CREATE FUNCTION raid_party_proposal_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rewards jsonb; i integer;
BEGIN
 SELECT t."snapshot"->'rewards' INTO STRICT rewards FROM "TermsVersion" t WHERE t."id"=NEW."termsVersionId";
 IF jsonb_typeof(NEW."snapshot"->'members')<>'array' OR jsonb_array_length(NEW."snapshot"->'members') NOT BETWEEN 1 AND 20
  OR (SELECT count(*) FROM "PartyProposalMember" m WHERE m."proposalId"=NEW."id")<>jsonb_array_length(NEW."snapshot"->'members') THEN
  RAISE EXCEPTION 'A roster is its whole snapshot, one to twenty members' USING ERRCODE='23514';
 END IF;
 FOR i IN 0..jsonb_array_length(rewards)-1 LOOP
  IF (SELECT COALESCE(sum((m."allocations"->i->>'amount')::numeric),0) FROM "PartyProposalMember" m WHERE m."proposalId"=NEW."id")
     <>(rewards->i->>'amount')::numeric THEN
   RAISE EXCEPTION 'Allocations must sum exactly to each reward leg' USING ERRCODE='23514';
  END IF;
 END LOOP;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "PartyProposal_complete" AFTER INSERT ON "PartyProposal" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION raid_party_proposal_complete();

-- Consent is the member's own act: the commanding account must own the consenting participant. A leader (or anyone else)
-- cannot record it for another human, and consent cannot outlive the slot, the current terms or the snapshot digest.
CREATE FUNCTION raid_party_consent_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor record; source record;
BEGIN
 SELECT r."actorId",r."commandKind",p."accountId" INTO STRICT actor
  FROM "CommandReceipt" r, "Participant" p WHERE r."id"=NEW."receiptId" AND p."id"=NEW."participantId";
 IF actor."actorId"<>actor."accountId" OR actor."commandKind"<>'RecordPartyMemberConsent' THEN
  RAISE EXCEPTION 'Party consent is recorded only by the consenting member' USING ERRCODE='23514';
 END IF;
 SELECT s."state",l."state" AS "listingState",l."currentTermsVersionId",p."termsVersionId" INTO STRICT source
  FROM "PartyProposal" p JOIN "RaidSlot" s ON s."id"=p."slotId" JOIN "WorkListing" l ON l."id"=s."listingId" WHERE p."id"=NEW."proposalId";
 IF source."state"<>'AVAILABLE' OR source."listingState"<>'OPEN' OR source."currentTermsVersionId"<>source."termsVersionId" THEN
  RAISE EXCEPTION 'Consent requires an available slot on the proposal terms' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "PartyMemberConsent_guard" BEFORE INSERT ON "PartyMemberConsent" FOR EACH ROW EXECUTE FUNCTION raid_party_consent_guard();
CREATE TRIGGER "PartyMemberConsent_immutable" BEFORE UPDATE OR DELETE ON "PartyMemberConsent" FOR EACH ROW EXECUTE FUNCTION raid_engagement_immutable();
COMMIT;
