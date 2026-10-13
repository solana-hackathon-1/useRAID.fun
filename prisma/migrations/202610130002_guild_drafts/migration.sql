-- Private owner drafts only. No Guild/project authority, public activation, token or money backfill.
BEGIN;
CREATE FUNCTION raid_guild_draft_profile_valid_v1(p jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN jsonb_typeof(p) <> 'object' THEN false ELSE
 p ?& ARRAY['name','slug','description'] AND p - ARRAY['name','slug','description'] = '{}'::jsonb
 AND jsonb_typeof(p->'name')='string' AND char_length(p->>'name') BETWEEN 1 AND 200
 AND btrim(p->>'name')=p->>'name' AND char_length(btrim(p->>'name'))>0
 AND jsonb_typeof(p->'slug')='string' AND char_length(p->>'slug') BETWEEN 1 AND 100
 AND p->>'slug' ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
 AND jsonb_typeof(p->'description')='string' AND char_length(p->>'description')<=4000
 AND btrim(p->>'description')=p->>'description'
 END
$$;
CREATE TABLE "GuildDraft" (
 "id" UUID NOT NULL,
 "ownerAccountId" TEXT NOT NULL,
 "slug" TEXT NOT NULL,
 "revision" INTEGER NOT NULL,
 "currentVersionId" UUID NOT NULL,
 CONSTRAINT "GuildDraft_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "GuildDraft_revision_check" CHECK ("revision">0),
 CONSTRAINT "GuildDraft_slug_check" CHECK (char_length("slug") BETWEEN 1 AND 100 AND "slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
 CONSTRAINT "GuildDraft_owner_fkey" FOREIGN KEY ("ownerAccountId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "GuildDraft_slug_key" ON "GuildDraft"("slug");
CREATE UNIQUE INDEX "GuildDraft_owner_key" ON "GuildDraft"("id","ownerAccountId");
CREATE INDEX "GuildDraft_ownerAccountId_idx" ON "GuildDraft"("ownerAccountId");
CREATE TABLE "GuildDraftVersion" (
 "id" UUID NOT NULL DEFAULT gen_random_uuid(),
 "guildDraftId" UUID NOT NULL,
 "ownerAccountId" TEXT NOT NULL,
 "revision" INTEGER NOT NULL,
 "profile" JSONB NOT NULL,
 "receiptId" UUID NOT NULL,
 "actorAccountId" TEXT NOT NULL,
 "requestId" TEXT NOT NULL,
 "recordedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT "GuildDraftVersion_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "GuildDraftVersion_actor_check" CHECK ("actorAccountId"="ownerAccountId"),
 CONSTRAINT "GuildDraftVersion_revision_check" CHECK ("revision">0),
 CONSTRAINT "GuildDraftVersion_profile_check" CHECK (raid_guild_draft_profile_valid_v1("profile") IS TRUE),
 CONSTRAINT "GuildDraftVersion_request_check" CHECK (char_length("requestId") BETWEEN 1 AND 200 AND "requestId" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'),
 -- Initial creation inserts the immutable version before its projection in the same transaction.
 CONSTRAINT "GuildDraftVersion_draft_fkey" FOREIGN KEY ("guildDraftId","ownerAccountId") REFERENCES "GuildDraft"("id","ownerAccountId") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
 CONSTRAINT "GuildDraftVersion_receipt_fkey" FOREIGN KEY ("receiptId") REFERENCES "CommandReceipt"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "GuildDraftVersion_draft_revision_key" ON "GuildDraftVersion"("guildDraftId","revision");
CREATE UNIQUE INDEX "GuildDraftVersion_receiptId_key" ON "GuildDraftVersion"("receiptId");
CREATE UNIQUE INDEX "GuildDraftVersion_pointer_key" ON "GuildDraftVersion"("id","guildDraftId","ownerAccountId","revision");
ALTER TABLE "GuildDraft" ADD CONSTRAINT "GuildDraft_version_fkey" FOREIGN KEY ("currentVersionId","id","ownerAccountId","revision") REFERENCES "GuildDraftVersion"("id","guildDraftId","ownerAccountId","revision") ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE FUNCTION raid_guild_draft_version_guard_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Guild draft versions require reviewed retention or recovery' USING ERRCODE='23000';
END;
$$;
CREATE TRIGGER guild_draft_version_guard_v1 BEFORE UPDATE OR DELETE ON "GuildDraftVersion" FOR EACH ROW EXECUTE FUNCTION raid_guild_draft_version_guard_v1();
CREATE FUNCTION raid_guild_draft_projection_guard_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Guild draft projection requires reviewed retention or recovery' USING ERRCODE='23000'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW."revision"<>1 THEN RAISE EXCEPTION 'First Guild draft revision must be one' USING ERRCODE='23000'; END IF;
 ELSE
  IF NEW."id"<>OLD."id" OR NEW."ownerAccountId"<>OLD."ownerAccountId" OR NEW."slug"<>OLD."slug" THEN RAISE EXCEPTION 'Guild draft identity/owner/slug are immutable' USING ERRCODE='23000'; END IF;
  IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  IF NEW."revision"<>OLD."revision"+1 OR NEW."currentVersionId"=OLD."currentVersionId" THEN RAISE EXCEPTION 'Guild draft needs its next immutable version' USING ERRCODE='23000'; END IF;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER guild_draft_projection_guard_v1 BEFORE INSERT OR UPDATE OR DELETE ON "GuildDraft" FOR EACH ROW EXECUTE FUNCTION raid_guild_draft_projection_guard_v1();
CREATE FUNCTION raid_guild_draft_commit_required_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM "CommandReceipt" c JOIN "AuditEvent" a ON a."receiptId"=c."id"
  JOIN "GuildDraft" d ON d."id"=NEW."guildDraftId" AND d."ownerAccountId"=NEW."ownerAccountId" AND d."revision">=NEW."revision" AND d."slug"=NEW."profile"->>'slug'
  WHERE c."id"=NEW."receiptId" AND c."actorId"=NEW."ownerAccountId" AND c."commandKind"='SaveGuildDraft'
   AND c."requestId"=NEW."requestId" AND c."resultRef"=NEW."id"::text
   AND a."ordinal"=0 AND a."eventType"='guild.draft_recorded.v1' AND a."aggregateId"=NEW."guildDraftId"::text
   AND a."aggregateVersion"=NEW."revision" AND a."actorId"=NEW."ownerAccountId" AND a."correlationId"=NEW."requestId"
   AND a."guildId" IS NULL AND a."payload"=jsonb_build_object('guildDraftVersionId',NEW."id"::text)
   AND NOT EXISTS(SELECT 1 FROM "OutboxEvent" o WHERE o."eventId"=a."id")
 ) THEN RAISE EXCEPTION 'Guild draft version requires its finalized owner receipt/private audit/projection' USING ERRCODE='23000'; END IF;
 RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER guild_draft_commit_required_v1 AFTER INSERT ON "GuildDraftVersion" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION raid_guild_draft_commit_required_v1();
COMMIT;
