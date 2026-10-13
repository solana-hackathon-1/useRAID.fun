-- Private pending existing-project claims only; no verified Guild/asset/Founder/grant or backfill.
BEGIN;
CREATE FUNCTION raid_project_candidate_valid_v1(p jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN jsonb_typeof(p)='object' THEN
 p ?& ARRAY['chain','networkIdentity','kind','mint','tokenProgram'] AND p-ARRAY['chain','networkIdentity','kind','mint','tokenProgram']='{}'::jsonb
 AND p->>'chain'='SOLANA' AND p->>'kind'='TOKEN'
 AND jsonb_typeof(p->'networkIdentity')='string' AND char_length(p->>'networkIdentity') BETWEEN 1 AND 200 AND p->>'networkIdentity' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
 AND jsonb_typeof(p->'mint')='string' AND p->>'mint' ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
 AND jsonb_typeof(p->'tokenProgram')='string' AND p->>'tokenProgram' ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' ELSE false END
$$;
CREATE FUNCTION raid_project_refs_valid_v1(p jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN jsonb_typeof(p)='array' THEN jsonb_array_length(p) BETWEEN 1 AND 5
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p) v WHERE jsonb_typeof(v)<>'string' OR char_length(v #>> '{}') NOT BETWEEN 1 AND 2048 OR (v #>> '{}') !~ '^https://[^/@[:space:]]+(/|$)' OR (v #>> '{}') ~ '[[:space:]]')
 AND jsonb_array_length(p)=(SELECT count(DISTINCT v) FROM jsonb_array_elements(p) v) ELSE false END
$$;
CREATE TABLE "GuildProjectProposal" (
 "guildDraftId" UUID NOT NULL,"ownerAccountId" TEXT NOT NULL,"revision" INTEGER NOT NULL,"currentVersionId" UUID NOT NULL,
 CONSTRAINT "GuildProjectProposal_pkey" PRIMARY KEY("guildDraftId"),
 CONSTRAINT "GuildProjectProposal_revision_check" CHECK("revision">0),
 CONSTRAINT "GuildProjectProposal_draft_fkey" FOREIGN KEY("guildDraftId","ownerAccountId") REFERENCES "GuildDraft"("id","ownerAccountId") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "GuildProjectProposal_owner_key" ON "GuildProjectProposal"("guildDraftId","ownerAccountId");
CREATE TABLE "GuildProjectProposalVersion" (
 "id" UUID NOT NULL DEFAULT gen_random_uuid(),"guildDraftId" UUID NOT NULL,"ownerAccountId" TEXT NOT NULL,"revision" INTEGER NOT NULL,
 "draftVersionId" UUID NOT NULL,"draftRevision" INTEGER NOT NULL,"candidateToken" JSONB NOT NULL,"publicEvidenceRefs" JSONB NOT NULL,
 "receiptId" UUID NOT NULL,"actorAccountId" TEXT NOT NULL,"requestId" TEXT NOT NULL,"recordedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT "GuildProjectProposalVersion_pkey" PRIMARY KEY("id"),
 CONSTRAINT "GuildProjectProposalVersion_revision_check" CHECK("revision">0 AND "draftRevision">0),
 CONSTRAINT "GuildProjectProposalVersion_actor_check" CHECK("actorAccountId"="ownerAccountId"),
 CONSTRAINT "GuildProjectProposalVersion_candidate_check" CHECK(raid_project_candidate_valid_v1("candidateToken") IS TRUE),
 CONSTRAINT "GuildProjectProposalVersion_refs_check" CHECK(raid_project_refs_valid_v1("publicEvidenceRefs") IS TRUE),
 CONSTRAINT "GuildProjectProposalVersion_request_check" CHECK(char_length("requestId") BETWEEN 1 AND 200 AND "requestId" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'),
 CONSTRAINT "GuildProjectProposalVersion_proposal_fkey" FOREIGN KEY("guildDraftId","ownerAccountId") REFERENCES "GuildProjectProposal"("guildDraftId","ownerAccountId") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
 CONSTRAINT "GuildProjectProposalVersion_draft_fkey" FOREIGN KEY("draftVersionId","guildDraftId","ownerAccountId","draftRevision") REFERENCES "GuildDraftVersion"("id","guildDraftId","ownerAccountId","revision") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "GuildProjectProposalVersion_receipt_fkey" FOREIGN KEY("receiptId") REFERENCES "CommandReceipt"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "GuildProjectProposalVersion_revision_key" ON "GuildProjectProposalVersion"("guildDraftId","revision");
CREATE UNIQUE INDEX "GuildProjectProposalVersion_receiptId_key" ON "GuildProjectProposalVersion"("receiptId");
CREATE UNIQUE INDEX "GuildProjectProposalVersion_pointer_key" ON "GuildProjectProposalVersion"("id","guildDraftId","ownerAccountId","revision");
ALTER TABLE "GuildProjectProposal" ADD CONSTRAINT "GuildProjectProposal_version_fkey" FOREIGN KEY("currentVersionId","guildDraftId","ownerAccountId","revision") REFERENCES "GuildProjectProposalVersion"("id","guildDraftId","ownerAccountId","revision") ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE FUNCTION raid_project_proposal_version_guard_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Project proposal versions require reviewed retention or recovery' USING ERRCODE='23000'; END;
$$;
CREATE TRIGGER project_proposal_version_guard_v1 BEFORE UPDATE OR DELETE ON "GuildProjectProposalVersion" FOR EACH ROW EXECUTE FUNCTION raid_project_proposal_version_guard_v1();
CREATE FUNCTION raid_project_proposal_projection_guard_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Project proposal requires reviewed retention or recovery' USING ERRCODE='23000'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW."revision"<>1 THEN RAISE EXCEPTION 'First project proposal revision must be one' USING ERRCODE='23000'; END IF;
 ELSE
  IF NEW."guildDraftId"<>OLD."guildDraftId" OR NEW."ownerAccountId"<>OLD."ownerAccountId" THEN RAISE EXCEPTION 'Project proposal owner/draft are immutable' USING ERRCODE='23000'; END IF;
  IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  IF NEW."revision"<>OLD."revision"+1 OR NEW."currentVersionId"=OLD."currentVersionId" THEN RAISE EXCEPTION 'Project proposal requires its next immutable version' USING ERRCODE='23000'; END IF;
 END IF;RETURN NEW;
END;
$$;
CREATE TRIGGER project_proposal_projection_guard_v1 BEFORE INSERT OR UPDATE OR DELETE ON "GuildProjectProposal" FOR EACH ROW EXECUTE FUNCTION raid_project_proposal_projection_guard_v1();
CREATE FUNCTION raid_project_proposal_commit_required_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM "CommandReceipt" c JOIN "AuditEvent" a ON a."receiptId"=c."id" JOIN "GuildProjectProposal" p ON p."guildDraftId"=NEW."guildDraftId" AND p."ownerAccountId"=NEW."ownerAccountId" AND p."revision">=NEW."revision"
 WHERE c."id"=NEW."receiptId" AND c."actorId"=NEW."ownerAccountId" AND c."commandKind"='SaveGuildProjectProposal' AND c."requestId"=NEW."requestId" AND c."resultRef"=NEW."id"::text
 AND a."ordinal"=0 AND a."eventType"='guild.project_proposal_recorded.v1' AND a."aggregateId"=NEW."guildDraftId"::text AND a."aggregateVersion"=NEW."revision" AND a."actorId"=NEW."ownerAccountId" AND a."correlationId"=NEW."requestId"
 AND a."guildId" IS NULL AND a."payload"=jsonb_build_object('projectProposalVersionId',NEW."id"::text) AND NOT EXISTS(SELECT 1 FROM "OutboxEvent" o WHERE o."eventId"=a."id"))
 THEN RAISE EXCEPTION 'Project proposal requires its finalized owner receipt/private audit/projection' USING ERRCODE='23000'; END IF;RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER project_proposal_commit_required_v1 AFTER INSERT ON "GuildProjectProposalVersion" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION raid_project_proposal_commit_required_v1();
COMMIT;
