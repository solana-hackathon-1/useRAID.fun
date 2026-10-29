-- Founder ownership changes only through a recorded, consented transfer: the current Founder proposes, the recipient
-- accepts, and the Guild's Founder changes in the same transaction. Nothing else may rewrite the Founder.
BEGIN;
CREATE TABLE "GuildOwnershipTransfer" (
 "id" UUID NOT NULL DEFAULT gen_random_uuid(),
 "guildId" UUID NOT NULL,
 "fromAccountId" TEXT NOT NULL,
 "toAccountId" TEXT NOT NULL,
 "state" TEXT NOT NULL DEFAULT 'PROPOSED',
 "proposedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
 "expiresAt" TIMESTAMPTZ(6) NOT NULL,
 "decidedAt" TIMESTAMPTZ(6),
 "decidedByAccountId" TEXT,
 "appliedAt" TIMESTAMPTZ(6),
 "proposeReceiptId" UUID NOT NULL,
 "decideReceiptId" UUID,
 CONSTRAINT "GuildOwnershipTransfer_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "GuildOwnershipTransfer_state_check" CHECK ("state" IN ('PROPOSED','ACCEPTED','DECLINED','WITHDRAWN','EXPIRED')),
 CONSTRAINT "GuildOwnershipTransfer_parties_check" CHECK ("fromAccountId"<>"toAccountId"),
 CONSTRAINT "GuildOwnershipTransfer_window_check" CHECK ("expiresAt">"proposedAt"),
 CONSTRAINT "GuildOwnershipTransfer_decision_check" CHECK (
  ("state"='PROPOSED' AND "decidedAt" IS NULL AND "decidedByAccountId" IS NULL AND "decideReceiptId" IS NULL)
  OR ("state"='EXPIRED' AND "decidedAt" IS NOT NULL AND "decidedByAccountId" IS NOT NULL AND "decideReceiptId" IS NOT NULL)
  OR ("state" IN ('ACCEPTED','DECLINED','WITHDRAWN') AND "decidedAt" IS NOT NULL AND "decidedByAccountId" IS NOT NULL AND "decideReceiptId" IS NOT NULL)),
 CONSTRAINT "GuildOwnershipTransfer_applied_check" CHECK ("appliedAt" IS NULL OR "state"='ACCEPTED'),
 -- Who may decide: the recipient accepts or declines, the proposer withdraws; an expiry can be recorded by either party.
 CONSTRAINT "GuildOwnershipTransfer_decider_check" CHECK (
  "state" IN ('PROPOSED','EXPIRED')
  OR ("state" IN ('ACCEPTED','DECLINED') AND "decidedByAccountId"="toAccountId")
  OR ("state"='WITHDRAWN' AND "decidedByAccountId"="fromAccountId")),
 -- An acceptance happens inside the proposal's window and an expiry is recorded after it.
 CONSTRAINT "GuildOwnershipTransfer_timing_check" CHECK (
  ("state"<>'ACCEPTED' OR "decidedAt"<="expiresAt") AND ("state"<>'EXPIRED' OR "decidedAt">="expiresAt")),
 CONSTRAINT "GuildOwnershipTransfer_guild_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "GuildOwnershipTransfer_from_fkey" FOREIGN KEY ("fromAccountId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "GuildOwnershipTransfer_to_fkey" FOREIGN KEY ("toAccountId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "GuildOwnershipTransfer_decidedBy_fkey" FOREIGN KEY ("decidedByAccountId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "GuildOwnershipTransfer_proposeReceipt_fkey" FOREIGN KEY ("proposeReceiptId") REFERENCES "CommandReceipt"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "GuildOwnershipTransfer_decideReceipt_fkey" FOREIGN KEY ("decideReceiptId") REFERENCES "CommandReceipt"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "GuildOwnershipTransfer_proposeReceiptId_key" ON "GuildOwnershipTransfer"("proposeReceiptId");
CREATE UNIQUE INDEX "GuildOwnershipTransfer_decideReceiptId_key" ON "GuildOwnershipTransfer"("decideReceiptId");
CREATE UNIQUE INDEX "GuildOwnershipTransfer_open_key" ON "GuildOwnershipTransfer"("guildId") WHERE "state"='PROPOSED';
CREATE INDEX "GuildOwnershipTransfer_guild_idx" ON "GuildOwnershipTransfer"("guildId");
CREATE INDEX "GuildOwnershipTransfer_from_idx" ON "GuildOwnershipTransfer"("fromAccountId");
CREATE INDEX "GuildOwnershipTransfer_to_idx" ON "GuildOwnershipTransfer"("toAccountId");

-- A proposal must be made by the Guild's current Founder, and a decision moves it once, out of PROPOSED.
CREATE FUNCTION raid_guild_transfer_guard_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE founder text;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Guild ownership transfers require reviewed retention or recovery' USING ERRCODE='23000'; END IF;
 IF TG_OP='INSERT' THEN
  SELECT "founderAccountId" INTO founder FROM "Guild" WHERE "id"=NEW."guildId";
  IF NEW."state"<>'PROPOSED' OR NEW."fromAccountId" IS DISTINCT FROM founder THEN
   RAISE EXCEPTION 'A Guild ownership transfer is proposed by the current Founder' USING ERRCODE='23000';
  END IF;
  RETURN NEW;
 END IF;
 IF to_jsonb(NEW)-'state'-'decidedAt'-'decidedByAccountId'-'decideReceiptId'-'appliedAt'
    IS DISTINCT FROM to_jsonb(OLD)-'state'-'decidedAt'-'decidedByAccountId'-'decideReceiptId'-'appliedAt' THEN
  RAISE EXCEPTION 'Guild ownership transfer parties and window are immutable' USING ERRCODE='23000';
 END IF;
 IF OLD."state"='PROPOSED' AND NEW."state"<>'PROPOSED' AND NEW."appliedAt" IS NULL THEN RETURN NEW; END IF;
 IF OLD."state"='ACCEPTED' AND NEW."state"='ACCEPTED' AND OLD."appliedAt" IS NULL AND NEW."appliedAt" IS NOT NULL
    AND to_jsonb(NEW)-'appliedAt' = to_jsonb(OLD)-'appliedAt' THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'A decided Guild ownership transfer is final' USING ERRCODE='23000';
END;
$$;
CREATE TRIGGER guild_transfer_guard_v1 BEFORE INSERT OR UPDATE OR DELETE ON "GuildOwnershipTransfer" FOR EACH ROW EXECUTE FUNCTION raid_guild_transfer_guard_v1();
-- At commit: an accepted transfer is applied to the Guild (no half-applied ownership change), and the proposal and any
-- decision are backed by the command receipts of the people who made them.
CREATE FUNCTION raid_guild_transfer_applied_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t record;
BEGIN
 SELECT * INTO t FROM "GuildOwnershipTransfer" WHERE "id"=NEW."id";
 IF t."state"='ACCEPTED' AND (t."appliedAt" IS NULL OR NOT EXISTS (SELECT 1 FROM "Guild" g WHERE g."id"=t."guildId" AND g."founderAccountId"=t."toAccountId")) THEN
  RAISE EXCEPTION 'An accepted Guild ownership transfer must be applied to the Guild' USING ERRCODE='23000';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM "CommandReceipt" c WHERE c."id"=t."proposeReceiptId" AND c."actorId"=t."fromAccountId"
     AND c."commandKind"='ProposeOwnershipTransfer' AND c."resultRef"=t."id"::text) THEN
  RAISE EXCEPTION 'A Guild ownership transfer needs its proposing Founder''s command receipt' USING ERRCODE='23000';
 END IF;
 IF t."state"<>'PROPOSED' AND NOT EXISTS (SELECT 1 FROM "CommandReceipt" c WHERE c."id"=t."decideReceiptId" AND c."actorId"=t."decidedByAccountId"
     AND ((c."commandKind"='RespondOwnershipTransfer' AND c."resultRef"=t."id"::text)
       OR (t."state"='EXPIRED' AND c."commandKind"='ProposeOwnershipTransfer'))) THEN
  RAISE EXCEPTION 'A Guild ownership transfer decision needs the deciding account''s command receipt' USING ERRCODE='23000';
 END IF;
 RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER guild_transfer_applied_v1 AFTER INSERT OR UPDATE ON "GuildOwnershipTransfer" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION raid_guild_transfer_applied_v1();

-- The Founder is still fixed against every write except an accepted, not yet applied transfer from that Founder to the
-- new one; such a change keeps the profile revision and version, and a profile revision still needs its own version.
CREATE OR REPLACE FUNCTION raid_guild_projection_guard_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Guild records require reviewed retention or recovery' USING ERRCODE='23000'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW."revision"<>1 THEN RAISE EXCEPTION 'First Guild revision must be one' USING ERRCODE='23000'; END IF;
  RETURN NEW;
 END IF;
 IF NEW."id"<>OLD."id" OR NEW."slug"<>OLD."slug"
  OR NEW."activationRef"<>OLD."activationRef" OR NEW."activatedByAccountId"<>OLD."activatedByAccountId"
  OR NEW."sourceDraftId"<>OLD."sourceDraftId" OR NEW."createdAt"<>OLD."createdAt" THEN
  RAISE EXCEPTION 'Guild identity, slug and activation record are immutable' USING ERRCODE='23000';
 END IF;
 IF NEW."founderAccountId"<>OLD."founderAccountId" THEN
  IF NEW."revision"<>OLD."revision" OR NEW."currentVersionId"<>OLD."currentVersionId" THEN
   RAISE EXCEPTION 'A Founder change does not change the profile revision' USING ERRCODE='23000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "GuildOwnershipTransfer" t WHERE t."guildId"=OLD."id" AND t."fromAccountId"=OLD."founderAccountId"
      AND t."toAccountId"=NEW."founderAccountId" AND t."state"='ACCEPTED' AND t."appliedAt" IS NULL) THEN
   RAISE EXCEPTION 'The Guild Founder changes only through an accepted ownership transfer' USING ERRCODE='23000';
  END IF;
  RETURN NEW;
 END IF;
 IF NEW."revision"<>OLD."revision"+1 OR NEW."currentVersionId"=OLD."currentVersionId" THEN
  RAISE EXCEPTION 'Guild needs its next immutable profile version' USING ERRCODE='23000';
 END IF;
 RETURN NEW;
END;
$$;
COMMIT;
