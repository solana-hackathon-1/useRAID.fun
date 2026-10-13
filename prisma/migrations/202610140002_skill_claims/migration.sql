-- Private unverified claimant facts only; no participant provisioning, assessment/rank or public effect.
BEGIN;
CREATE FUNCTION raid_skill_claim_refs_valid_v1(p jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN jsonb_typeof(p)='array' THEN jsonb_array_length(p) BETWEEN 0 AND 5
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p) v WHERE jsonb_typeof(v)<>'string' OR char_length(v #>> '{}') NOT BETWEEN 1 AND 2048 OR (v #>> '{}') !~ '^https://[^/@[:space:]]+(/|$)' OR (v #>> '{}') ~ '[[:space:]]')
 AND jsonb_array_length(p)=(SELECT count(DISTINCT v) FROM jsonb_array_elements(p) v) ELSE false END
$$;
CREATE TABLE "SkillClaim" (
 "id" UUID NOT NULL,"accountId" TEXT NOT NULL,"participantId" UUID NOT NULL,"skillId" TEXT NOT NULL,"skillDomain" TEXT NOT NULL,"taxonomyId" TEXT NOT NULL,"revision" INTEGER NOT NULL,"currentVersionId" UUID NOT NULL,
 CONSTRAINT "SkillClaim_pkey" PRIMARY KEY("id"),
 CONSTRAINT "SkillClaim_revision_check" CHECK("revision">0),
 CONSTRAINT "SkillClaim_participant_fkey" FOREIGN KEY("participantId","accountId") REFERENCES "Participant"("id","accountId") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "SkillClaim_subject_skill_key" ON "SkillClaim"("participantId","skillId");
CREATE UNIQUE INDEX "SkillClaim_owner_key" ON "SkillClaim"("id","participantId","accountId","skillId","skillDomain","taxonomyId");
CREATE TABLE "SkillClaimVersion" (
 "id" UUID NOT NULL DEFAULT gen_random_uuid(),"skillClaimId" UUID NOT NULL,"accountId" TEXT NOT NULL,"participantId" UUID NOT NULL,"skillId" TEXT NOT NULL,"skillDomain" TEXT NOT NULL,
 "taxonomyId" TEXT NOT NULL,"taxonomyVersionId" UUID NOT NULL,"taxonomyRevision" INTEGER NOT NULL,"revision" INTEGER NOT NULL,"claimedLevel" TEXT NOT NULL,"supportingReferences" JSONB NOT NULL,
 "receiptId" UUID NOT NULL,"actorAccountId" TEXT NOT NULL,"requestId" TEXT NOT NULL,"recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
 CONSTRAINT "SkillClaimVersion_pkey" PRIMARY KEY("id"),
 CONSTRAINT "SkillClaimVersion_revision_check" CHECK("revision">0 AND "taxonomyRevision">0),
 CONSTRAINT "SkillClaimVersion_actor_check" CHECK("actorAccountId"="accountId"),
 CONSTRAINT "SkillClaimVersion_level_check" CHECK(char_length("claimedLevel") BETWEEN 1 AND 200 AND btrim("claimedLevel")="claimedLevel"),
 CONSTRAINT "SkillClaimVersion_refs_check" CHECK(raid_skill_claim_refs_valid_v1("supportingReferences") IS TRUE),
 CONSTRAINT "SkillClaimVersion_request_check" CHECK(char_length("requestId") BETWEEN 1 AND 200 AND "requestId" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'),
 CONSTRAINT "SkillClaimVersion_claim_fkey" FOREIGN KEY("skillClaimId","participantId","accountId","skillId","skillDomain","taxonomyId") REFERENCES "SkillClaim"("id","participantId","accountId","skillId","skillDomain","taxonomyId") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
 CONSTRAINT "SkillClaimVersion_participant_fkey" FOREIGN KEY("participantId","accountId") REFERENCES "Participant"("id","accountId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "SkillClaimVersion_taxonomy_fkey" FOREIGN KEY("taxonomyVersionId","taxonomyId","taxonomyRevision") REFERENCES "SkillTaxonomyVersion"("id","taxonomyId","revision") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "SkillClaimVersion_receipt_fkey" FOREIGN KEY("receiptId") REFERENCES "CommandReceipt"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "SkillClaimVersion_revision_key" ON "SkillClaimVersion"("skillClaimId","revision");
CREATE UNIQUE INDEX "SkillClaimVersion_receiptId_key" ON "SkillClaimVersion"("receiptId");
CREATE UNIQUE INDEX "SkillClaimVersion_pointer_key" ON "SkillClaimVersion"("id","skillClaimId","participantId","accountId","skillId","skillDomain","taxonomyId","revision");
ALTER TABLE "SkillClaim" ADD CONSTRAINT "SkillClaim_version_fkey" FOREIGN KEY("currentVersionId","id","participantId","accountId","skillId","skillDomain","taxonomyId","revision") REFERENCES "SkillClaimVersion"("id","skillClaimId","participantId","accountId","skillId","skillDomain","taxonomyId","revision") ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE FUNCTION raid_skill_claim_version_guard_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Private claim versions require reviewed retention or recovery' USING ERRCODE='23000'; END IF;
 IF NOT EXISTS(SELECT 1 FROM "SkillTaxonomyVersion" t CROSS JOIN LATERAL jsonb_array_elements(t."skills") s WHERE t."id"=NEW."taxonomyVersionId" AND t."taxonomyId"=NEW."taxonomyId" AND t."revision"=NEW."taxonomyRevision" AND s->>'id'=NEW."skillId" AND s->>'domain'=NEW."skillDomain" AND s->>'status'='ACTIVE') THEN RAISE EXCEPTION 'Claim requires exact active catalog skill/domain' USING ERRCODE='23000'; END IF;
 IF NEW."revision">1 AND NOT EXISTS(SELECT 1 FROM "SkillClaimVersion" v WHERE v."skillClaimId"=NEW."skillClaimId" AND v."revision"=NEW."revision"-1 AND v."accountId"=NEW."accountId" AND v."participantId"=NEW."participantId" AND v."skillId"=NEW."skillId" AND v."skillDomain"=NEW."skillDomain" AND v."taxonomyId"=NEW."taxonomyId") THEN RAISE EXCEPTION 'Canonical claim identity/domain/catalog and contiguous history must survive' USING ERRCODE='23000'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER skill_claim_version_guard_v1 BEFORE INSERT OR UPDATE OR DELETE ON "SkillClaimVersion" FOR EACH ROW EXECUTE FUNCTION raid_skill_claim_version_guard_v1();
CREATE FUNCTION raid_skill_claim_projection_guard_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Private claims require reviewed retention or recovery' USING ERRCODE='23000'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW."revision"<>1 THEN RAISE EXCEPTION 'First claim revision must be one' USING ERRCODE='23000'; END IF;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['revision','currentVersionId']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['revision','currentVersionId']) THEN RAISE EXCEPTION 'Claim identity/owner/skill/domain/catalog are immutable' USING ERRCODE='23000'; END IF;
  IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  IF NEW."revision"<>OLD."revision"+1 OR NEW."currentVersionId"=OLD."currentVersionId" THEN RAISE EXCEPTION 'Claim requires next immutable version' USING ERRCODE='23000'; END IF;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER skill_claim_projection_guard_v1 BEFORE INSERT OR UPDATE OR DELETE ON "SkillClaim" FOR EACH ROW EXECUTE FUNCTION raid_skill_claim_projection_guard_v1();
CREATE FUNCTION raid_skill_claim_commit_required_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM "CommandReceipt" c JOIN "AuditEvent" a ON a."receiptId"=c."id" JOIN "SkillClaim" p ON p."id"=NEW."skillClaimId" AND p."revision">=NEW."revision" JOIN "User" u ON u."id"=NEW."accountId" AND u."suspended"=false JOIN "Participant" h ON h."id"=NEW."participantId" AND h."accountId"=NEW."accountId" AND h."kind"='HUMAN' JOIN "SkillTaxonomy" t ON t."id"=NEW."taxonomyId" AND t."revision"=NEW."taxonomyRevision" AND t."currentVersionId"=NEW."taxonomyVersionId"
 WHERE c."id"=NEW."receiptId" AND c."actorId"=NEW."accountId" AND c."commandKind"='SaveSkillClaim' AND c."requestId"=NEW."requestId" AND c."resultRef"=NEW."id"::text
 AND a."ordinal"=0 AND a."eventType"='skill.claim_recorded.v1' AND a."aggregateId"=NEW."skillClaimId"::text AND a."aggregateVersion"=NEW."revision" AND a."actorId"=NEW."accountId" AND a."correlationId"=NEW."requestId" AND a."guildId" IS NULL AND a."payload"=jsonb_build_object('skillClaimVersionId',NEW."id"::text) AND NOT EXISTS(SELECT 1 FROM "OutboxEvent" o WHERE o."eventId"=a."id")) THEN RAISE EXCEPTION 'Claim requires current canonical owner/catalog and finalized receipt/private audit/projection' USING ERRCODE='23000'; END IF;
 RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER skill_claim_commit_required_v1 AFTER INSERT ON "SkillClaimVersion" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION raid_skill_claim_commit_required_v1();
COMMIT;
