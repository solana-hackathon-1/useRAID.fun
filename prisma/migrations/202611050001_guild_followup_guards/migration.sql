-- Additive Guild hardening from review follow-ups (#290 items 4 and 9, #296 item 5). No table, column or data change;
-- three new guards only. Applied migrations are untouched: the update guard is replaced with CREATE OR REPLACE.
BEGIN;

-- #290 item 4. At commit, every profile version is backed by the command that wrote it (activation for revision one,
-- an edit otherwise): the actor's receipt, its first private audit event with the version id, no outbox row, and a Guild
-- projection that points at this version or has moved past it. A privileged direct writer therefore cannot leave a
-- version at revision N+1 that blocks later edits, as the draft tables already guarantee for their versions.
CREATE FUNCTION raid_guild_version_commit_required_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM "CommandReceipt" c JOIN "AuditEvent" a ON a."receiptId"=c."id"
  JOIN "Guild" g ON g."id"=NEW."guildId" AND (g."revision">NEW."revision" OR (g."revision"=NEW."revision" AND g."currentVersionId"=NEW."id"))
  WHERE c."id"=NEW."receiptId" AND c."actorId"=NEW."actorAccountId" AND c."requestId"=NEW."requestId"
   AND ((NEW."revision"=1 AND c."commandKind"='ActivateGuild' AND c."resultRef"=NEW."guildId"::text AND a."eventType"='guild.activated.v1')
     OR (NEW."revision">1 AND c."commandKind"='EditGuildProfile' AND c."resultRef"=NEW."id"::text AND a."eventType"='guild.profile_edited.v1'))
   AND a."ordinal"=0 AND a."aggregateId"=NEW."guildId"::text AND a."aggregateVersion"=NEW."revision"
   AND a."actorId"=NEW."actorAccountId" AND a."correlationId"=NEW."requestId" AND a."guildId"=NEW."guildId"::text
   AND a."payload"=jsonb_build_object('guildProfileVersionId',NEW."id"::text)
   AND NOT EXISTS (SELECT 1 FROM "OutboxEvent" o WHERE o."eventId"=a."id")
 ) THEN RAISE EXCEPTION 'Guild profile version requires its finalized actor receipt, private audit event and Guild projection' USING ERRCODE='23000'; END IF;
 RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER guild_version_commit_required_v1 AFTER INSERT ON "GuildProfileVersion" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION raid_guild_version_commit_required_v1();

-- #290 item 9. A grant is revoked at or after the moment it starts. Existing rows satisfy this: commands revoke at the
-- database clock after issuing, and no command sets a future start.
ALTER TABLE "GuildRoleGrant" ADD CONSTRAINT "GuildRoleGrant_revoked_check" CHECK ("revokedAt" IS NULL OR "revokedAt">="validFrom");

-- #296 item 5. The publication time is the database clock at the moment of publication, whatever a direct writer
-- supplies, so the public feed and its (publishedAt, id) cursor cannot be misordered. Otherwise unchanged from
-- 202610270010.
CREATE OR REPLACE FUNCTION raid_guild_update_guard_v1() RETURNS trigger LANGUAGE plpgsql AS $$
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
  NEW."publishedAt" := clock_timestamp();
  RETURN NEW;
 END IF;
 IF OLD."state" IN ('DRAFT','PUBLISHED') AND NEW."state"='WITHDRAWN'
    AND to_jsonb(NEW)-'state'-'withdrawnAt'-'withdrawnByAccountId'-'withdrawReceiptId' = to_jsonb(OLD)-'state'-'withdrawnAt'-'withdrawnByAccountId'-'withdrawReceiptId' THEN
  RETURN NEW;
 END IF;
 RAISE EXCEPTION 'A Guild update only moves forward: draft, published, withdrawn' USING ERRCODE='23000';
END;
$$;
COMMIT;
