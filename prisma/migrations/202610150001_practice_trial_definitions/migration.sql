-- Explicit admin publication only; no trial/answer/evaluator/rank/provider seed or public outbox.
BEGIN;
CREATE FUNCTION raid_practice_id_v1(p jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT jsonb_typeof(p)='string' AND char_length(p #>> '{}') BETWEEN 1 AND 200 AND (p #>> '{}') ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
$$;
CREATE FUNCTION raid_practice_text_v1(p jsonb, maximum integer) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE value text; units integer;
BEGIN
 IF jsonb_typeof(p) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
 value:=p #>> '{}';
 IF value<>btrim(value,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') THEN RETURN false; END IF;
 units:=char_length(value);
 IF octet_length(value)<>units THEN
  SELECT units+COALESCE(sum(CASE WHEN ascii(c)>65535 THEN 1 ELSE 0 END),0)::int INTO units FROM regexp_split_to_table(value,'') c;
 END IF;
 RETURN units BETWEEN 1 AND maximum;
END;
$$;
CREATE FUNCTION raid_practice_int_v1(p jsonb, minimum bigint, maximum bigint) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
 IF jsonb_typeof(p) IS DISTINCT FROM 'number' OR p::text !~ '^(0|[1-9][0-9]{0,9})$' THEN RETURN false; END IF;
 RETURN p::text::bigint BETWEEN minimum AND maximum;
END;
$$;
CREATE FUNCTION raid_practice_reference_v1(p jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT jsonb_typeof(p)='object' AND p ?& ARRAY['recordId','revision'] AND p-ARRAY['recordId','revision']='{}'::jsonb
 AND raid_practice_id_v1(p->'recordId') IS TRUE AND raid_practice_int_v1(p->'revision',1,2147483647) IS TRUE
$$;
CREATE FUNCTION raid_practice_criteria_v1(p jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE c jsonb; ids text[]:='{}';
BEGIN
 IF jsonb_typeof(p) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 IF jsonb_array_length(p) NOT BETWEEN 1 AND 50 THEN RETURN false; END IF;
 FOR c IN SELECT value FROM jsonb_array_elements(p) LOOP
  IF jsonb_typeof(c) IS DISTINCT FROM 'object' OR NOT c ?& ARRAY['id','description','required'] OR c-ARRAY['id','description','required']<>'{}'::jsonb THEN RETURN false; END IF;
  IF raid_practice_id_v1(c->'id') IS NOT TRUE OR (c->>'id')=ANY(ids) OR raid_practice_text_v1(c->'description',4000) IS NOT TRUE OR jsonb_typeof(c->'required') IS DISTINCT FROM 'boolean' THEN RETURN false; END IF;
  ids:=array_append(ids,c->>'id');
 END LOOP;
 RETURN true;
END;
$$;
CREATE FUNCTION raid_practice_definition_v1(p jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE keys text[]:=ARRAY['version','reference','state','publishedAt','purpose','skillId','skillDomain','targetRank','title','brief','variantId','inputs','tools','expectedMinutes','rubric','evaluatorMethod','passConditions','maximumAttempts','cooldownSeconds','accommodationPolicy']; i jsonb; t jsonb; tools text[]:='{}';
BEGIN
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT p ?& keys OR p-keys<>'{}'::jsonb THEN RETURN false; END IF;
 IF p->>'version' IS DISTINCT FROM 'v1' OR p->>'state' IS DISTINCT FROM 'PUBLISHED' OR p->>'purpose' IS DISTINCT FROM 'UNPAID_PLATFORM_PRACTICE' THEN RETURN false; END IF;
 IF raid_practice_reference_v1(p->'reference') IS NOT TRUE OR raid_practice_id_v1(p->'skillId') IS NOT TRUE OR raid_practice_id_v1(p->'skillDomain') IS NOT TRUE OR raid_practice_id_v1(p->'variantId') IS NOT TRUE THEN RETURN false; END IF;
 IF (p->>'targetRank' IN ('E','D','C','B','A','S')) IS NOT TRUE OR (p->>'evaluatorMethod' IN ('MANUAL','AUTOMATED_WITH_MANUAL_REVIEW')) IS NOT TRUE THEN RETURN false; END IF;
 IF raid_practice_text_v1(p->'title',200) IS NOT TRUE OR raid_practice_text_v1(p->'brief',4000) IS NOT TRUE OR raid_practice_text_v1(p->'passConditions',4000) IS NOT TRUE OR raid_practice_text_v1(p->'accommodationPolicy',4000) IS NOT TRUE THEN RETURN false; END IF;
 IF jsonb_typeof(p->'publishedAt') IS DISTINCT FROM 'string' OR p->>'publishedAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' THEN RETURN false; END IF;
 IF raid_practice_int_v1(p->'expectedMinutes',1,10080) IS NOT TRUE OR raid_practice_int_v1(p->'maximumAttempts',1,10000) IS NOT TRUE OR raid_practice_int_v1(p->'cooldownSeconds',0,2147483647) IS NOT TRUE THEN RETURN false; END IF;
 IF jsonb_typeof(p->'inputs') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 IF jsonb_array_length(p->'inputs') NOT BETWEEN 1 AND 50 THEN RETURN false; END IF;
 FOR i IN SELECT value FROM jsonb_array_elements(p->'inputs') LOOP
  IF jsonb_typeof(i) IS DISTINCT FROM 'object' OR NOT i ?& ARRAY['label','material','content'] OR i-ARRAY['label','material','content']<>'{}'::jsonb OR (i->>'material' IN ('PUBLIC','SYNTHETIC')) IS NOT TRUE THEN RETURN false; END IF;
  IF raid_practice_text_v1(i->'label',200) IS NOT TRUE OR raid_practice_text_v1(i->'content',4000) IS NOT TRUE THEN RETURN false; END IF;
 END LOOP;
 t:=p->'tools';
 IF jsonb_typeof(t) IS DISTINCT FROM 'object' OR NOT t ?& ARRAY['permitted','aiAssistance','disclosure'] OR t-ARRAY['permitted','aiAssistance','disclosure']<>'{}'::jsonb OR (t->>'aiAssistance' IN ('ALLOWED','PROHIBITED')) IS NOT TRUE OR raid_practice_text_v1(t->'disclosure',4000) IS NOT TRUE THEN RETURN false; END IF;
 IF jsonb_typeof(t->'permitted') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 IF jsonb_array_length(t->'permitted')>50 THEN RETURN false; END IF;
 FOR i IN SELECT value FROM jsonb_array_elements(t->'permitted') LOOP
  IF raid_practice_text_v1(i,200) IS NOT TRUE OR (i #>> '{}')=ANY(tools) THEN RETURN false; END IF;
  tools:=array_append(tools,i #>> '{}');
 END LOOP;
 t:=p->'rubric';
 RETURN jsonb_typeof(t)='object' AND t ?& ARRAY['reference','criteria'] AND t-ARRAY['reference','criteria']='{}'::jsonb AND raid_practice_reference_v1(t->'reference') IS TRUE AND raid_practice_criteria_v1(t->'criteria') IS TRUE;
END;
$$;
CREATE TABLE "PracticeTrial" (
 "id" TEXT NOT NULL,"skillId" TEXT NOT NULL,"skillDomain" TEXT NOT NULL,"taxonomyId" TEXT NOT NULL,
 "revision" INTEGER NOT NULL,"currentVersionId" UUID NOT NULL,
 CONSTRAINT "PracticeTrial_pkey" PRIMARY KEY("id"),
 CONSTRAINT "PracticeTrial_identity_check" CHECK(raid_practice_id_v1(to_jsonb("id")) IS TRUE AND raid_practice_id_v1(to_jsonb("skillId")) IS TRUE AND raid_practice_id_v1(to_jsonb("skillDomain")) IS TRUE),
 CONSTRAINT "PracticeTrial_revision_check" CHECK("revision">0)
);
CREATE UNIQUE INDEX "PracticeTrial_family_key" ON "PracticeTrial"("id","skillId","skillDomain","taxonomyId");
CREATE TABLE "SkillRubricVersion" (
 "id" UUID NOT NULL DEFAULT gen_random_uuid(),"rubricId" TEXT NOT NULL,"revision" INTEGER NOT NULL,"criteria" JSONB NOT NULL,"introducedByTrialVersionId" UUID NOT NULL,
 CONSTRAINT "SkillRubricVersion_pkey" PRIMARY KEY("id"),
 CONSTRAINT "SkillRubricVersion_contract_check" CHECK(raid_practice_id_v1(to_jsonb("rubricId")) IS TRUE AND "revision">0 AND raid_practice_criteria_v1("criteria") IS TRUE)
);
CREATE UNIQUE INDEX "SkillRubricVersion_revision_key" ON "SkillRubricVersion"("rubricId","revision");
CREATE UNIQUE INDEX "SkillRubricVersion_pointer_key" ON "SkillRubricVersion"("id","rubricId","revision");
CREATE UNIQUE INDEX "SkillRubricVersion_introduction_key" ON "SkillRubricVersion"("introducedByTrialVersionId");
CREATE TABLE "PracticeTrialVersion" (
 "id" UUID NOT NULL DEFAULT gen_random_uuid(),"trialId" TEXT NOT NULL,"revision" INTEGER NOT NULL,"skillId" TEXT NOT NULL,"skillDomain" TEXT NOT NULL,
 "taxonomyId" TEXT NOT NULL,"taxonomyRevision" INTEGER NOT NULL,"taxonomyVersionId" UUID NOT NULL,
 "rubricId" TEXT NOT NULL,"rubricRevision" INTEGER NOT NULL,"rubricVersionId" UUID NOT NULL,
 "definition" JSONB NOT NULL,"availability" TEXT NOT NULL,"receiptId" UUID NOT NULL,"publishedByAccountId" TEXT NOT NULL,"requestId" TEXT NOT NULL,
 "publishedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
 CONSTRAINT "PracticeTrialVersion_pkey" PRIMARY KEY("id"),
 CONSTRAINT "PracticeTrialVersion_contract_check" CHECK("revision">0 AND "availability" IN ('AVAILABLE','RETIRED') AND raid_practice_definition_v1("definition") IS TRUE AND raid_practice_id_v1(to_jsonb("requestId")) IS TRUE),
 CONSTRAINT "PracticeTrialVersion_binding_check" CHECK("definition"#>>'{reference,recordId}'="trialId" AND ("definition"#>>'{reference,revision}')::int="revision" AND "definition"->>'skillId'="skillId" AND "definition"->>'skillDomain'="skillDomain" AND "definition"#>>'{rubric,reference,recordId}'="rubricId" AND ("definition"#>>'{rubric,reference,revision}')::int="rubricRevision" AND "definition"->>'publishedAt'=to_char("publishedAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
 CONSTRAINT "PracticeTrialVersion_family_fkey" FOREIGN KEY("trialId","skillId","skillDomain","taxonomyId") REFERENCES "PracticeTrial"("id","skillId","skillDomain","taxonomyId") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
 CONSTRAINT "PracticeTrialVersion_taxonomy_fkey" FOREIGN KEY("taxonomyVersionId","taxonomyId","taxonomyRevision") REFERENCES "SkillTaxonomyVersion"("id","taxonomyId","revision") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "PracticeTrialVersion_rubric_fkey" FOREIGN KEY("rubricVersionId","rubricId","rubricRevision") REFERENCES "SkillRubricVersion"("id","rubricId","revision") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "PracticeTrialVersion_actor_fkey" FOREIGN KEY("publishedByAccountId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "PracticeTrialVersion_receipt_fkey" FOREIGN KEY("receiptId") REFERENCES "CommandReceipt"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "PracticeTrialVersion_revision_key" ON "PracticeTrialVersion"("trialId","revision");
CREATE UNIQUE INDEX "PracticeTrialVersion_receipt_key" ON "PracticeTrialVersion"("receiptId");
CREATE UNIQUE INDEX "PracticeTrialVersion_pointer_key" ON "PracticeTrialVersion"("id","trialId","skillId","skillDomain","taxonomyId","revision");
ALTER TABLE "PracticeTrial" ADD CONSTRAINT "PracticeTrial_version_fkey" FOREIGN KEY("currentVersionId","id","skillId","skillDomain","taxonomyId","revision") REFERENCES "PracticeTrialVersion"("id","trialId","skillId","skillDomain","taxonomyId","revision") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "SkillRubricVersion" ADD CONSTRAINT "SkillRubricVersion_introduction_fkey" FOREIGN KEY("introducedByTrialVersionId") REFERENCES "PracticeTrialVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED;
CREATE FUNCTION raid_practice_rubric_guard_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Rubric versions are immutable' USING ERRCODE='23000'; END IF;
 IF NEW."revision">1 AND NOT EXISTS(SELECT 1 FROM "SkillRubricVersion" WHERE "rubricId"=NEW."rubricId" AND "revision"=NEW."revision"-1) THEN RAISE EXCEPTION 'Rubric versions must be contiguous' USING ERRCODE='23000'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER practice_rubric_guard_v1 BEFORE INSERT OR UPDATE OR DELETE ON "SkillRubricVersion" FOR EACH ROW EXECUTE FUNCTION raid_practice_rubric_guard_v1();
CREATE FUNCTION raid_practice_version_guard_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Practice versions require reviewed retention or recovery' USING ERRCODE='23000'; END IF;
 IF NEW."revision"=1 AND NEW."availability"<>'AVAILABLE' THEN RAISE EXCEPTION 'Initial definition must be available' USING ERRCODE='23000'; END IF;
 IF NEW."revision">1 AND NOT EXISTS(SELECT 1 FROM "PracticeTrialVersion" WHERE "trialId"=NEW."trialId" AND "revision"=NEW."revision"-1 AND "skillId"=NEW."skillId" AND "skillDomain"=NEW."skillDomain" AND "taxonomyId"=NEW."taxonomyId") THEN RAISE EXCEPTION 'Trial family and contiguous history must survive' USING ERRCODE='23000'; END IF;
 IF NOT EXISTS(SELECT 1 FROM "SkillRubricVersion" r WHERE r."id"=NEW."rubricVersionId" AND r."criteria"=NEW."definition"#>'{rubric,criteria}') THEN RAISE EXCEPTION 'Published rubric reference cannot change criteria' USING ERRCODE='23000'; END IF;
 IF NOT EXISTS(SELECT 1 FROM "SkillTaxonomyVersion" t CROSS JOIN LATERAL jsonb_array_elements(t."skills") s WHERE t."id"=NEW."taxonomyVersionId" AND t."publishedAt"<=NEW."publishedAt" AND s->>'id'=NEW."skillId" AND s->>'domain'=NEW."skillDomain" AND (NEW."availability"='RETIRED' OR s->>'status'='ACTIVE')) THEN RAISE EXCEPTION 'Definition requires actual relevant published taxonomy' USING ERRCODE='23000'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER practice_version_guard_v1 BEFORE INSERT OR UPDATE OR DELETE ON "PracticeTrialVersion" FOR EACH ROW EXECUTE FUNCTION raid_practice_version_guard_v1();
CREATE FUNCTION raid_practice_projection_guard_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Trial history requires reviewed retention or recovery' USING ERRCODE='23000'; END IF;
 IF TG_OP='INSERT' THEN IF NEW."revision"<>1 THEN RAISE EXCEPTION 'First trial revision must be one' USING ERRCODE='23000'; END IF;
 ELSE
  IF NEW."id"<>OLD."id" OR NEW."skillId"<>OLD."skillId" OR NEW."skillDomain"<>OLD."skillDomain" OR NEW."taxonomyId"<>OLD."taxonomyId" THEN RAISE EXCEPTION 'Trial family identity is immutable' USING ERRCODE='23000'; END IF;
  IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  IF NEW."revision"<>OLD."revision"+1 OR NEW."currentVersionId"=OLD."currentVersionId" THEN RAISE EXCEPTION 'Trial requires next immutable version' USING ERRCODE='23000'; END IF;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER practice_projection_guard_v1 BEFORE INSERT OR UPDATE OR DELETE ON "PracticeTrial" FOR EACH ROW EXECUTE FUNCTION raid_practice_projection_guard_v1();
CREATE FUNCTION raid_practice_commit_required_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM "CommandReceipt" c JOIN "AuditEvent" a ON a."receiptId"=c."id" JOIN "PracticeTrial" p ON p."id"=NEW."trialId" AND p."revision">=NEW."revision" JOIN "User" u ON u."id"=NEW."publishedByAccountId" JOIN "SkillTaxonomy" t ON t."id"=NEW."taxonomyId" AND t."revision"=NEW."taxonomyRevision"
 WHERE c."id"=NEW."receiptId" AND c."actorId"=NEW."publishedByAccountId" AND c."commandKind"='PublishPracticeTrial' AND c."requestId"=NEW."requestId" AND c."resultRef"=NEW."id"::text
 AND u."role"='ADMIN' AND u."suspended"=false AND u."xId" IS NOT NULL AND u."xId"<>''
 AND a."ordinal"=0 AND a."eventType"='skill.practice_trial_published.v1' AND a."aggregateId"=NEW."trialId" AND a."aggregateVersion"=NEW."revision" AND a."actorId"=NEW."publishedByAccountId" AND a."correlationId"=NEW."requestId"
 AND a."guildId" IS NULL AND a."payload"=jsonb_build_object('practiceTrialVersionId',NEW."id"::text) AND NOT EXISTS(SELECT 1 FROM "OutboxEvent" o WHERE o."eventId"=a."id")) THEN RAISE EXCEPTION 'Trial requires current taxonomy, finalized admin receipt/private audit/projection' USING ERRCODE='23000'; END IF;
 RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER practice_commit_required_v1 AFTER INSERT ON "PracticeTrialVersion" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION raid_practice_commit_required_v1();
CREATE FUNCTION raid_practice_rubric_commit_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM "PracticeTrialVersion" v WHERE v."id"=NEW."introducedByTrialVersionId" AND v."rubricVersionId"=NEW."id" AND v."rubricId"=NEW."rubricId" AND v."rubricRevision"=NEW."revision" AND v."definition"#>'{rubric,criteria}'=NEW."criteria") THEN RAISE EXCEPTION 'Rubric requires actual introducing publication' USING ERRCODE='23000'; END IF;
 RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER practice_rubric_commit_v1 AFTER INSERT ON "SkillRubricVersion" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION raid_practice_rubric_commit_v1();
COMMIT;
