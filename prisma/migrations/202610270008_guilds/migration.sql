-- Persisted Guilds: an operator-attested activation of an owner's draft, immutable profile history and scoped role
-- grants. Founder authority here is not a token balance, market metadata or a draft: it is the activation record.
-- Treasury and dispute authority are separate grant kinds and are never implied by profile administration.
BEGIN;
CREATE TABLE "Guild" (
 "id" UUID NOT NULL DEFAULT gen_random_uuid(),
 "slug" TEXT NOT NULL,
 "founderAccountId" TEXT NOT NULL,
 "revision" INTEGER NOT NULL,
 "currentVersionId" UUID NOT NULL,
 "activationRef" TEXT NOT NULL,
 "activatedByAccountId" TEXT NOT NULL,
 "sourceDraftId" UUID NOT NULL,
 "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT "Guild_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "Guild_revision_check" CHECK ("revision">0),
 CONSTRAINT "Guild_slug_check" CHECK (char_length("slug") BETWEEN 1 AND 100 AND "slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
 CONSTRAINT "Guild_activationRef_check" CHECK (char_length("activationRef") BETWEEN 1 AND 200 AND "activationRef" ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$'),
 CONSTRAINT "Guild_founder_fkey" FOREIGN KEY ("founderAccountId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "Guild_activatedBy_fkey" FOREIGN KEY ("activatedByAccountId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "Guild_sourceDraft_fkey" FOREIGN KEY ("sourceDraftId") REFERENCES "GuildDraft"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "Guild_slug_key" ON "Guild"("slug");
CREATE UNIQUE INDEX "Guild_sourceDraftId_key" ON "Guild"("sourceDraftId");
CREATE INDEX "Guild_founderAccountId_idx" ON "Guild"("founderAccountId");

CREATE TABLE "GuildProfileVersion" (
 "id" UUID NOT NULL DEFAULT gen_random_uuid(),
 "guildId" UUID NOT NULL,
 "revision" INTEGER NOT NULL,
 "name" TEXT NOT NULL,
 "description" TEXT NOT NULL,
 "receiptId" UUID NOT NULL,
 "actorAccountId" TEXT NOT NULL,
 "requestId" TEXT NOT NULL,
 "recordedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT "GuildProfileVersion_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "GuildProfileVersion_revision_check" CHECK ("revision">0),
 CONSTRAINT "GuildProfileVersion_name_check" CHECK (char_length("name") BETWEEN 1 AND 200 AND btrim("name")="name"),
 CONSTRAINT "GuildProfileVersion_description_check" CHECK (char_length("description")<=4000 AND btrim("description")="description"),
 CONSTRAINT "GuildProfileVersion_request_check" CHECK (char_length("requestId") BETWEEN 1 AND 200 AND "requestId" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'),
 CONSTRAINT "GuildProfileVersion_actor_fkey" FOREIGN KEY ("actorAccountId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "GuildProfileVersion_receipt_fkey" FOREIGN KEY ("receiptId") REFERENCES "CommandReceipt"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 -- The first version is inserted before its Guild in the activation transaction.
 CONSTRAINT "GuildProfileVersion_guild_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX "GuildProfileVersion_guild_revision_key" ON "GuildProfileVersion"("guildId","revision");
CREATE UNIQUE INDEX "GuildProfileVersion_receiptId_key" ON "GuildProfileVersion"("receiptId");
CREATE UNIQUE INDEX "GuildProfileVersion_pointer_key" ON "GuildProfileVersion"("id","guildId","revision");
ALTER TABLE "Guild" ADD CONSTRAINT "Guild_version_fkey" FOREIGN KEY ("currentVersionId","id","revision") REFERENCES "GuildProfileVersion"("id","guildId","revision") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE "GuildRoleGrant" (
 "id" UUID NOT NULL DEFAULT gen_random_uuid(),
 "guildId" UUID NOT NULL,
 "granteeAccountId" TEXT NOT NULL,
 "kind" TEXT NOT NULL,
 "fields" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
 "canDelegate" BOOLEAN NOT NULL DEFAULT false,
 "validFrom" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
 "expiresAt" TIMESTAMPTZ(6),
 "revokedAt" TIMESTAMPTZ(6),
 "grantedByAccountId" TEXT NOT NULL,
 "receiptId" UUID,
 CONSTRAINT "GuildRoleGrant_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "GuildRoleGrant_kind_check" CHECK ("kind" IN ('PROFILE','WORK','TREASURY','DISPUTE')),
 -- Only profile grants name profile fields; the other kinds are whole-scope and carry none.
 CONSTRAINT "GuildRoleGrant_fields_check" CHECK (
  ("kind"='PROFILE' AND cardinality("fields") BETWEEN 1 AND 2 AND "fields" <@ ARRAY['name','description']::TEXT[] AND (cardinality("fields")=1 OR "fields"[1]<>"fields"[2]))
  OR ("kind"<>'PROFILE' AND cardinality("fields")=0 AND NOT "canDelegate")),
 CONSTRAINT "GuildRoleGrant_window_check" CHECK ("expiresAt" IS NULL OR "expiresAt">"validFrom"),
 CONSTRAINT "GuildRoleGrant_guild_fkey" FOREIGN KEY ("guildId") REFERENCES "Guild"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "GuildRoleGrant_grantee_fkey" FOREIGN KEY ("granteeAccountId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "GuildRoleGrant_grantedBy_fkey" FOREIGN KEY ("grantedByAccountId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "GuildRoleGrant_receipt_fkey" FOREIGN KEY ("receiptId") REFERENCES "CommandReceipt"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX "GuildRoleGrant_guild_grantee_idx" ON "GuildRoleGrant"("guildId","granteeAccountId");
CREATE UNIQUE INDEX "GuildRoleGrant_receiptId_key" ON "GuildRoleGrant"("receiptId");

-- Identity, activation record and Founder are fixed here; a Founder change belongs to the reviewed ownership-transfer
-- process. A Guild is never deleted, and every revision needs its own immutable profile version.
CREATE FUNCTION raid_guild_projection_guard_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Guild records require reviewed retention or recovery' USING ERRCODE='23000'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW."revision"<>1 THEN RAISE EXCEPTION 'First Guild revision must be one' USING ERRCODE='23000'; END IF;
 ELSE
  IF NEW."id"<>OLD."id" OR NEW."slug"<>OLD."slug" OR NEW."founderAccountId"<>OLD."founderAccountId"
   OR NEW."activationRef"<>OLD."activationRef" OR NEW."activatedByAccountId"<>OLD."activatedByAccountId"
   OR NEW."sourceDraftId"<>OLD."sourceDraftId" OR NEW."createdAt"<>OLD."createdAt" THEN
   RAISE EXCEPTION 'Guild identity, slug, Founder and activation record are immutable' USING ERRCODE='23000';
  END IF;
  IF NEW."revision"<>OLD."revision"+1 OR NEW."currentVersionId"=OLD."currentVersionId" THEN
   RAISE EXCEPTION 'Guild needs its next immutable profile version' USING ERRCODE='23000';
  END IF;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER guild_projection_guard_v1 BEFORE INSERT OR UPDATE OR DELETE ON "Guild" FOR EACH ROW EXECUTE FUNCTION raid_guild_projection_guard_v1();
CREATE FUNCTION raid_guild_version_guard_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Guild profile versions require reviewed retention or recovery' USING ERRCODE='23000';
END;
$$;
CREATE TRIGGER guild_version_guard_v1 BEFORE UPDATE OR DELETE ON "GuildProfileVersion" FOR EACH ROW EXECUTE FUNCTION raid_guild_version_guard_v1();
-- A grant's scope, grantee and window are fixed once issued; only revocation (once) changes it, and it is never deleted.
CREATE FUNCTION raid_guild_grant_guard_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Guild grants require reviewed retention or recovery' USING ERRCODE='23000'; END IF;
 IF OLD."revokedAt" IS NOT NULL OR to_jsonb(NEW)-'revokedAt' IS DISTINCT FROM to_jsonb(OLD)-'revokedAt' OR NEW."revokedAt" IS NULL THEN
  RAISE EXCEPTION 'A Guild grant can only be revoked, once' USING ERRCODE='23000';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER guild_grant_guard_v1 BEFORE UPDATE OR DELETE ON "GuildRoleGrant" FOR EACH ROW EXECUTE FUNCTION raid_guild_grant_guard_v1();
COMMIT;
