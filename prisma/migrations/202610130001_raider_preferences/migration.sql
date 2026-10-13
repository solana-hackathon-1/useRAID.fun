-- Additive, private, unpaid orientation only. No backfill, skill/rank, capacity or payout mutation.
BEGIN;
CREATE FUNCTION raid_orientation_preferences_valid_v1(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN jsonb_typeof(p) <> 'object' THEN false ELSE
  p ?& ARRAY['experience','workInterests','timezone','orientationAcknowledged','evidencePath','portfolioUrl']
  AND p - ARRAY['experience','workInterests','timezone','orientationAcknowledged','evidencePath','portfolioUrl'] = '{}'::jsonb
  AND p->>'experience' IN ('BEGINNER','EXPERIENCED')
  AND p->'orientationAcknowledged' = 'true'::jsonb
  AND jsonb_typeof(p->'timezone') = 'string' AND char_length(p->>'timezone') BETWEEN 1 AND 80
  AND (p->'evidencePath' = 'null'::jsonb OR p->>'evidencePath' IN ('PORTFOLIO','TRIAL'))
  AND (p->'portfolioUrl' = 'null'::jsonb OR (jsonb_typeof(p->'portfolioUrl') = 'string' AND char_length(p->>'portfolioUrl') <= 2048 AND p->>'portfolioUrl' ~* '^https?://'))
  AND CASE WHEN jsonb_typeof(p->'workInterests') <> 'array' THEN false ELSE
   jsonb_array_length(p->'workInterests') BETWEEN 1 AND 10
   AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p->'workInterests') AS e(value)
    WHERE jsonb_typeof(value) <> 'string' OR char_length(value #>> '{}') NOT BETWEEN 1 AND 200 OR value #>> '{}' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$')
   AND jsonb_array_length(p->'workInterests') = (SELECT count(DISTINCT value) FROM jsonb_array_elements(p->'workInterests') AS e(value))
  END
 END
$$;
CREATE TABLE "RaiderPreferenceVersion" (
 "id" UUID NOT NULL DEFAULT gen_random_uuid(),
 "accountId" TEXT NOT NULL,
 "participantId" UUID NOT NULL,
 "revision" INTEGER NOT NULL,
 "preferences" JSONB NOT NULL,
 "receiptId" UUID NOT NULL,
 "actorAccountId" TEXT NOT NULL,
 "requestId" TEXT NOT NULL,
 "recordedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT "RaiderPreferenceVersion_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "RaiderPreferenceVersion_actor_check" CHECK ("actorAccountId" = "accountId"),
 CONSTRAINT "RaiderPreferenceVersion_revision_check" CHECK ("revision" > 0),
 CONSTRAINT "RaiderPreferenceVersion_preferences_check" CHECK (raid_orientation_preferences_valid_v1("preferences") IS TRUE),
 CONSTRAINT "RaiderPreferenceVersion_request_check" CHECK (char_length("requestId") BETWEEN 1 AND 200 AND "requestId" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'),
 CONSTRAINT "RaiderPreferenceVersion_account_fkey" FOREIGN KEY ("accountId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "RaiderPreferenceVersion_participant_fkey" FOREIGN KEY ("participantId", "accountId") REFERENCES "Participant"("id", "accountId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "RaiderPreferenceVersion_receipt_fkey" FOREIGN KEY ("receiptId") REFERENCES "CommandReceipt"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "RaiderPreferenceVersion_account_revision_key" ON "RaiderPreferenceVersion"("accountId", "revision");
CREATE UNIQUE INDEX "RaiderPreferenceVersion_receiptId_key" ON "RaiderPreferenceVersion"("receiptId");
CREATE UNIQUE INDEX "RaiderPreferenceVersion_pointer_key" ON "RaiderPreferenceVersion"("id", "accountId", "participantId", "revision");
CREATE TABLE "RaiderPreferences" (
 "accountId" TEXT NOT NULL,
 "participantId" UUID NOT NULL,
 "revision" INTEGER NOT NULL,
 "currentVersionId" UUID NOT NULL,
 CONSTRAINT "RaiderPreferences_pkey" PRIMARY KEY ("accountId"),
 CONSTRAINT "RaiderPreferences_revision_check" CHECK ("revision" > 0),
 CONSTRAINT "RaiderPreferences_account_fkey" FOREIGN KEY ("accountId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "RaiderPreferences_participant_fkey" FOREIGN KEY ("participantId", "accountId") REFERENCES "Participant"("id", "accountId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "RaiderPreferences_version_fkey" FOREIGN KEY ("currentVersionId", "accountId", "participantId", "revision") REFERENCES "RaiderPreferenceVersion"("id", "accountId", "participantId", "revision") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE FUNCTION raid_orientation_version_guard_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Orientation versions are immutable; removal needs reviewed retention or recovery' USING ERRCODE = '23000';
END;
$$;
CREATE TRIGGER orientation_version_guard_v1 BEFORE UPDATE OR DELETE ON "RaiderPreferenceVersion" FOR EACH ROW EXECUTE FUNCTION raid_orientation_version_guard_v1();
CREATE FUNCTION raid_orientation_projection_guard_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Orientation projection requires reviewed retention or recovery' USING ERRCODE = '23000'; END IF;
 IF TG_OP = 'INSERT' THEN
  IF NEW."revision" <> 1 THEN RAISE EXCEPTION 'Orientation first revision must be one' USING ERRCODE = '23000'; END IF;
 ELSE
  IF NEW."accountId" <> OLD."accountId" OR NEW."participantId" <> OLD."participantId" THEN RAISE EXCEPTION 'Orientation identity is immutable' USING ERRCODE = '23000'; END IF;
  IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  IF NEW."revision" <> OLD."revision" + 1 OR NEW."currentVersionId" = OLD."currentVersionId" THEN RAISE EXCEPTION 'Orientation revision requires the next immutable version' USING ERRCODE = '23000'; END IF;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER orientation_projection_guard_v1 BEFORE INSERT OR UPDATE OR DELETE ON "RaiderPreferences" FOR EACH ROW EXECUTE FUNCTION raid_orientation_projection_guard_v1();
-- Deferred because command receipts/audit are finalized after the business mutation in this tx.
CREATE FUNCTION raid_orientation_commit_required_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM "CommandReceipt" c JOIN "AuditEvent" a ON a."receiptId" = c."id"
  JOIN "RaiderPreferences" p ON p."accountId" = NEW."accountId" AND p."participantId" = NEW."participantId" AND p."revision" >= NEW."revision"
  WHERE c."id" = NEW."receiptId" AND c."actorId" = NEW."accountId" AND c."commandKind" = 'SaveRaiderOrientation'
   AND c."requestId" = NEW."requestId" AND c."resultRef" = NEW."id"::text
   AND a."ordinal" = 0 AND a."eventType" = 'identity.onboarding_recorded.v1' AND a."aggregateId" = NEW."accountId"
   AND a."aggregateVersion" = NEW."revision" AND a."actorId" = NEW."accountId" AND a."correlationId" = NEW."requestId"
   AND a."guildId" IS NULL AND a."payload" = jsonb_build_object('orientationVersionId',NEW."id"::text)
   AND NOT EXISTS (SELECT 1 FROM "OutboxEvent" o WHERE o."eventId" = a."id")
 ) THEN RAISE EXCEPTION 'Orientation version requires its own finalized receipt, private audit and current projection' USING ERRCODE = '23000'; END IF;
 RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER orientation_commit_required_v1 AFTER INSERT ON "RaiderPreferenceVersion" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION raid_orientation_commit_required_v1();
COMMIT;
