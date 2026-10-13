-- Admin-published catalogs only. No seeded categories/admins, claims, assessments or public effects.
BEGIN;
-- Extend the shared audit namespace without rewriting old migrations or records.
ALTER TABLE "AuditEvent" DROP CONSTRAINT "AuditEvent_type_check";
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_type_check" CHECK ("eventType" ~ '^(identity|guild|skill|launch|work|treasury|access|challenge|execution)\.[a-z][a-z_]*\.v1$');
CREATE FUNCTION raid_skill_categories_valid_v1(p jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE s jsonb; a jsonb; ids text[] := '{}'; aliases text[] := '{}';
BEGIN
 IF jsonb_typeof(p) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 IF jsonb_array_length(p) NOT BETWEEN 1 AND 1000 THEN RETURN false; END IF;
 FOR s IN SELECT value FROM jsonb_array_elements(p) LOOP
  IF jsonb_typeof(s) IS DISTINCT FROM 'object' OR NOT s ?& ARRAY['id','domain','name','status','aliases'] OR s-ARRAY['id','domain','name','status','aliases']<>'{}'::jsonb THEN RETURN false; END IF;
  IF jsonb_typeof(s->'id') IS DISTINCT FROM 'string' OR char_length(s->>'id') NOT BETWEEN 1 AND 200 OR s->>'id' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$' OR (s->>'id')=ANY(ids) THEN RETURN false; END IF;
  IF jsonb_typeof(s->'domain') IS DISTINCT FROM 'string' OR char_length(s->>'domain') NOT BETWEEN 1 AND 200 OR s->>'domain' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$' THEN RETURN false; END IF;
  IF jsonb_typeof(s->'name') IS DISTINCT FROM 'string' OR char_length(s->>'name') NOT BETWEEN 1 AND 200 OR btrim(s->>'name')<>s->>'name' THEN RETURN false; END IF;
  IF jsonb_typeof(s->'status') IS DISTINCT FROM 'string' OR s->>'status' NOT IN ('ACTIVE','RETIRED') THEN RETURN false; END IF;
  IF jsonb_typeof(s->'aliases') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(s->'aliases') NOT BETWEEN 1 AND 100 THEN RETURN false; END IF;
  ids := array_append(ids,s->>'id');
  FOR a IN SELECT value FROM jsonb_array_elements(s->'aliases') LOOP
   IF jsonb_typeof(a) IS DISTINCT FROM 'string' OR char_length(a #>> '{}') NOT BETWEEN 1 AND 100 OR (a #>> '{}') !~ '^[a-z0-9][a-z0-9._-]*$' OR (a #>> '{}')=ANY(aliases) THEN RETURN false; END IF;
   aliases := array_append(aliases,a #>> '{}');
  END LOOP;
 END LOOP;
 RETURN true;
END;
$$;
CREATE FUNCTION raid_skill_history_preserved_v1(previous jsonb, candidate jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT NOT EXISTS(SELECT 1 FROM jsonb_array_elements(previous) old WHERE NOT EXISTS(
 SELECT 1 FROM jsonb_array_elements(candidate) current WHERE current->>'id'=old->>'id' AND current->>'domain'=old->>'domain' AND (old->'aliases') <@ (current->'aliases')))
$$;
CREATE TABLE "SkillTaxonomy" (
 "id" TEXT NOT NULL,"revision" INTEGER NOT NULL,"currentVersionId" UUID NOT NULL,
 CONSTRAINT "SkillTaxonomy_pkey" PRIMARY KEY("id"),
 CONSTRAINT "SkillTaxonomy_id_check" CHECK(char_length("id") BETWEEN 1 AND 200 AND "id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'),
 CONSTRAINT "SkillTaxonomy_revision_check" CHECK("revision">0)
);
CREATE TABLE "SkillTaxonomyVersion" (
 "id" UUID NOT NULL DEFAULT gen_random_uuid(),"taxonomyId" TEXT NOT NULL,"revision" INTEGER NOT NULL,"skills" JSONB NOT NULL,
 "receiptId" UUID NOT NULL,"publishedByAccountId" TEXT NOT NULL,"requestId" TEXT NOT NULL,
 "publishedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
 CONSTRAINT "SkillTaxonomyVersion_pkey" PRIMARY KEY("id"),
 CONSTRAINT "SkillTaxonomyVersion_revision_check" CHECK("revision">0),
 CONSTRAINT "SkillTaxonomyVersion_categories_check" CHECK(raid_skill_categories_valid_v1("skills") IS TRUE),
 CONSTRAINT "SkillTaxonomyVersion_request_check" CHECK(char_length("requestId") BETWEEN 1 AND 200 AND "requestId" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'),
 CONSTRAINT "SkillTaxonomyVersion_catalog_fkey" FOREIGN KEY("taxonomyId") REFERENCES "SkillTaxonomy"("id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
 CONSTRAINT "SkillTaxonomyVersion_actor_fkey" FOREIGN KEY("publishedByAccountId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "SkillTaxonomyVersion_receipt_fkey" FOREIGN KEY("receiptId") REFERENCES "CommandReceipt"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "SkillTaxonomyVersion_revision_key" ON "SkillTaxonomyVersion"("taxonomyId","revision");
CREATE UNIQUE INDEX "SkillTaxonomyVersion_receiptId_key" ON "SkillTaxonomyVersion"("receiptId");
CREATE UNIQUE INDEX "SkillTaxonomyVersion_pointer_key" ON "SkillTaxonomyVersion"("id","taxonomyId","revision");
ALTER TABLE "SkillTaxonomy" ADD CONSTRAINT "SkillTaxonomy_version_fkey" FOREIGN KEY("currentVersionId","id","revision") REFERENCES "SkillTaxonomyVersion"("id","taxonomyId","revision") ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE FUNCTION raid_skill_version_guard_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous jsonb;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Skill catalog versions require reviewed retention or recovery' USING ERRCODE='23000'; END IF;
 IF NEW."revision">1 THEN
  SELECT "skills" INTO previous FROM "SkillTaxonomyVersion" WHERE "taxonomyId"=NEW."taxonomyId" AND "revision"=NEW."revision"-1;
  IF previous IS NULL OR raid_skill_history_preserved_v1(previous,NEW."skills") IS NOT TRUE THEN RAISE EXCEPTION 'Skill catalog IDs/domains/aliases and contiguous history must survive' USING ERRCODE='23000'; END IF;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER skill_version_guard_v1 BEFORE INSERT OR UPDATE OR DELETE ON "SkillTaxonomyVersion" FOR EACH ROW EXECUTE FUNCTION raid_skill_version_guard_v1();
CREATE FUNCTION raid_skill_projection_guard_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Skill catalogs require reviewed retention or recovery' USING ERRCODE='23000'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW."revision"<>1 THEN RAISE EXCEPTION 'First catalog revision must be one' USING ERRCODE='23000'; END IF;
 ELSE
  IF NEW."id"<>OLD."id" THEN RAISE EXCEPTION 'Catalog identity is immutable' USING ERRCODE='23000'; END IF;
  IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  IF NEW."revision"<>OLD."revision"+1 OR NEW."currentVersionId"=OLD."currentVersionId" THEN RAISE EXCEPTION 'Catalog requires next immutable version' USING ERRCODE='23000'; END IF;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER skill_projection_guard_v1 BEFORE INSERT OR UPDATE OR DELETE ON "SkillTaxonomy" FOR EACH ROW EXECUTE FUNCTION raid_skill_projection_guard_v1();
CREATE FUNCTION raid_skill_commit_required_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM "CommandReceipt" c JOIN "AuditEvent" a ON a."receiptId"=c."id" JOIN "SkillTaxonomy" t ON t."id"=NEW."taxonomyId" AND t."revision">=NEW."revision" JOIN "User" u ON u."id"=NEW."publishedByAccountId"
 WHERE c."id"=NEW."receiptId" AND c."actorId"=NEW."publishedByAccountId" AND c."commandKind"='PublishSkillTaxonomy' AND c."requestId"=NEW."requestId" AND c."resultRef"=NEW."id"::text
 AND u."role"='ADMIN' AND u."suspended"=false AND u."xId" IS NOT NULL AND u."xId"<>''
 AND a."ordinal"=0 AND a."eventType"='skill.taxonomy_published.v1' AND a."aggregateId"=NEW."taxonomyId" AND a."aggregateVersion"=NEW."revision" AND a."actorId"=NEW."publishedByAccountId" AND a."correlationId"=NEW."requestId"
 AND a."guildId" IS NULL AND a."payload"=jsonb_build_object('skillTaxonomyVersionId',NEW."id"::text) AND NOT EXISTS(SELECT 1 FROM "OutboxEvent" o WHERE o."eventId"=a."id"))
 THEN RAISE EXCEPTION 'Catalog requires finalized admin receipt/private audit/projection' USING ERRCODE='23000'; END IF;
 RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER skill_commit_required_v1 AFTER INSERT ON "SkillTaxonomyVersion" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION raid_skill_commit_required_v1();
COMMIT;
