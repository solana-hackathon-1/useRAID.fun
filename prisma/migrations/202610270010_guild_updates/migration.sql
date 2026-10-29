-- Public project/progress updates: drafted by the Founder or a profile delegate, published only by the Founder, and
-- shown publicly as title, text and publication time alone. Private roadmap or configuration has no column here.
BEGIN;
CREATE TABLE "GuildUpdate" (
 "id" UUID NOT NULL DEFAULT gen_random_uuid(),
 "guildId" UUID NOT NULL,
 "authorAccountId" TEXT NOT NULL,
 "title" TEXT NOT NULL,
 "body" TEXT NOT NULL,
 "state" TEXT NOT NULL DEFAULT 'DRAFT',
 "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
 "publishedAt" TIMESTAMPTZ(6),
 "publishedByAccountId" TEXT,
 "withdrawnAt" TIMESTAMPTZ(6),
 "withdrawnByAccountId" TEXT,
 "draftReceiptId" UUID NOT NULL,
 "publishReceiptId" UUID,
 "withdrawReceiptId" UUID,
 CONSTRAINT "GuildUpdate_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "GuildUpdate_state_check" CHECK ("state" IN ('DRAFT','PUBLISHED','WITHDRAWN')),
 CONSTRAINT "GuildUpdate_title_check" CHECK (char_length("title") BETWEEN 1 AND 200 AND btrim("title")="title"),
 CONSTRAINT "GuildUpdate_body_check" CHECK (char_length("body") BETWEEN 1 AND 4000 AND btrim("body")="body"),
 CONSTRAINT "GuildUpdate_lifecycle_check" CHECK (
  ("state"='DRAFT' AND "publishedAt" IS NULL AND "publishedByAccountId" IS NULL AND "publishReceiptId" IS NULL AND "withdrawnAt" IS NULL AND "withdrawnByAccountId" IS NULL AND "withdrawReceiptId" IS NULL)
  OR ("state"='PUBLISHED' AND "publishedAt" IS NOT NULL AND "publishedByAccountId" IS NOT NULL AND "publishReceiptId" IS NOT NULL AND "withdrawnAt" IS NULL AND "withdrawnByAccountId" IS NULL AND "withdrawReceiptId" IS NULL)
  OR ("state"='WITHDRAWN' AND "withdrawnAt" IS NOT NULL AND "withdrawnByAccountId" IS NOT NULL AND "withdrawReceiptId" IS NOT NULL
      AND (("publishedAt" IS NULL AND "publishedByAccountId" IS NULL AND "publishReceiptId" IS NULL) OR ("publishedAt" IS NOT NULL AND "publishedByAccountId" IS NOT NULL AND "publishReceiptId" IS NOT NULL)))),
 CONSTRAINT "GuildUpdate_guild_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "GuildUpdate_author_fkey" FOREIGN KEY ("authorAccountId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "GuildUpdate_publisher_fkey" FOREIGN KEY ("publishedByAccountId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "GuildUpdate_withdrawer_fkey" FOREIGN KEY ("withdrawnByAccountId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "GuildUpdate_draftReceipt_fkey" FOREIGN KEY ("draftReceiptId") REFERENCES "CommandReceipt"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "GuildUpdate_publishReceipt_fkey" FOREIGN KEY ("publishReceiptId") REFERENCES "CommandReceipt"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "GuildUpdate_withdrawReceipt_fkey" FOREIGN KEY ("withdrawReceiptId") REFERENCES "CommandReceipt"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "GuildUpdate_draftReceiptId_key" ON "GuildUpdate"("draftReceiptId");
CREATE UNIQUE INDEX "GuildUpdate_publishReceiptId_key" ON "GuildUpdate"("publishReceiptId");
CREATE UNIQUE INDEX "GuildUpdate_withdrawReceiptId_key" ON "GuildUpdate"("withdrawReceiptId");
CREATE INDEX "GuildUpdate_public_idx" ON "GuildUpdate"("guildId","publishedAt" DESC,"id" DESC) WHERE "state"='PUBLISHED';
CREATE INDEX "GuildUpdate_author_idx" ON "GuildUpdate"("authorAccountId");
CREATE INDEX "GuildUpdate_publisher_idx" ON "GuildUpdate"("publishedByAccountId");
CREATE INDEX "GuildUpdate_withdrawer_idx" ON "GuildUpdate"("withdrawnByAccountId");
-- Content and authorship are fixed once written; the state only moves forward, an update is never deleted, and a
-- publication is made by the Guild's current Founder.
CREATE FUNCTION raid_guild_update_guard_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE founder text;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Guild updates require reviewed retention or recovery' USING ERRCODE='23000'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW."state"<>'DRAFT' THEN RAISE EXCEPTION 'A Guild update starts as a draft' USING ERRCODE='23000'; END IF;
  RETURN NEW;
 END IF;
 IF to_jsonb(NEW)-'state'-'publishedAt'-'publishedByAccountId'-'publishReceiptId'-'withdrawnAt'-'withdrawnByAccountId'-'withdrawReceiptId'
    IS DISTINCT FROM to_jsonb(OLD)-'state'-'publishedAt'-'publishedByAccountId'-'publishReceiptId'-'withdrawnAt'-'withdrawnByAccountId'-'withdrawReceiptId' THEN
  RAISE EXCEPTION 'Guild update content and authorship are immutable' USING ERRCODE='23000';
 END IF;
 IF OLD."state"='DRAFT' AND NEW."state"='PUBLISHED' THEN
  SELECT "founderAccountId" INTO founder FROM "Guild" WHERE "id"=NEW."guildId";
  IF NEW."publishedByAccountId" IS DISTINCT FROM founder THEN
   RAISE EXCEPTION 'A Guild update is published by the current Founder' USING ERRCODE='23000';
  END IF;
  RETURN NEW;
 END IF;
 IF OLD."state" IN ('DRAFT','PUBLISHED') AND NEW."state"='WITHDRAWN'
    AND to_jsonb(NEW)-'state'-'withdrawnAt'-'withdrawnByAccountId'-'withdrawReceiptId' = to_jsonb(OLD)-'state'-'withdrawnAt'-'withdrawnByAccountId'-'withdrawReceiptId' THEN
  RETURN NEW;
 END IF;
 RAISE EXCEPTION 'A Guild update only moves forward: draft, published, withdrawn' USING ERRCODE='23000';
END;
$$;
CREATE TRIGGER guild_update_guard_v1 BEFORE INSERT OR UPDATE OR DELETE ON "GuildUpdate" FOR EACH ROW EXECUTE FUNCTION raid_guild_update_guard_v1();
-- At commit: each recorded step is backed by the command receipt of the account that took it.
CREATE FUNCTION raid_guild_update_receipts_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE u record;
BEGIN
 SELECT * INTO u FROM "GuildUpdate" WHERE "id"=NEW."id";
 IF NOT EXISTS (SELECT 1 FROM "CommandReceipt" c WHERE c."id"=u."draftReceiptId" AND c."actorId"=u."authorAccountId" AND c."commandKind"='DraftGuildUpdate' AND c."resultRef"=u."id"::text) THEN
  RAISE EXCEPTION 'A Guild update needs its author''s draft command receipt' USING ERRCODE='23000';
 END IF;
 IF u."publishReceiptId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "CommandReceipt" c WHERE c."id"=u."publishReceiptId" AND c."actorId"=u."publishedByAccountId" AND c."commandKind"='PublishGuildUpdate' AND c."resultRef"=u."id"::text) THEN
  RAISE EXCEPTION 'A Guild update publication needs the publisher''s command receipt' USING ERRCODE='23000';
 END IF;
 IF u."withdrawReceiptId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "CommandReceipt" c WHERE c."id"=u."withdrawReceiptId" AND c."actorId"=u."withdrawnByAccountId" AND c."commandKind"='WithdrawGuildUpdate' AND c."resultRef"=u."id"::text) THEN
  RAISE EXCEPTION 'A Guild update withdrawal needs the withdrawer''s command receipt' USING ERRCODE='23000';
 END IF;
 RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER guild_update_receipts_v1 AFTER INSERT OR UPDATE ON "GuildUpdate" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION raid_guild_update_receipts_v1();
COMMIT;
