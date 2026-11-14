-- Additive (DEC-2026-11-13-10, T043): operator-set, append-only marker that excludes a record from product metrics
-- only. One new table, one append-only guard (the shared raid_append_only_guard_v1), one actor trigger; no existing
-- table, constraint or data changes and nothing outside src/metrics reads it. Rollback: DROP TABLE "MetricsExclusion";
-- DROP FUNCTION raid_metrics_exclusion_actor_v1(). A chain per subject: the first marker has no predecessor, every
-- later one supersedes the current head (EXCLUDE to change the reason, RELEASE to lift it), so history is never edited.
BEGIN;
CREATE TABLE "MetricsExclusion" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "subjectType" TEXT NOT NULL,
  "subjectId" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "evidenceRef" TEXT NOT NULL,
  "effect" TEXT NOT NULL,
  "supersedesMarkerId" uuid,
  "actorAccountId" TEXT NOT NULL,
  "recordedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "MetricsExclusion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MetricsExclusion_id_subject_key" UNIQUE ("id", "subjectType", "subjectId"),
  CONSTRAINT "MetricsExclusion_supersedes_fkey" FOREIGN KEY ("supersedesMarkerId", "subjectType", "subjectId")
    REFERENCES "MetricsExclusion" ("id", "subjectType", "subjectId"),
  CONSTRAINT "MetricsExclusion_subjectType_check" CHECK ("subjectType" IN ('GUILD','WORK_LISTING','ENGAGEMENT','PARTICIPANT')),
  CONSTRAINT "MetricsExclusion_subjectId_check" CHECK ("subjectId" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  CONSTRAINT "MetricsExclusion_reason_check" CHECK ("reason" IN ('FIXTURE','INTERNAL_DEMO','SELF_DEALING','DUPLICATE','KNOWN_ABUSE')),
  CONSTRAINT "MetricsExclusion_evidenceRef_check" CHECK ("evidenceRef" ~ '^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,199}$'),
  CONSTRAINT "MetricsExclusion_effect_check" CHECK ("effect" IN ('EXCLUDE','RELEASE')),
  CONSTRAINT "MetricsExclusion_release_check" CHECK ("effect" = 'EXCLUDE' OR "supersedesMarkerId" IS NOT NULL),
  CONSTRAINT "MetricsExclusion_actor_check" CHECK (char_length("actorAccountId") BETWEEN 1 AND 200)
);
-- A marker is superseded at most once, and a subject has at most one chain: concurrent operators cannot fork it.
CREATE UNIQUE INDEX "MetricsExclusion_supersedesMarkerId_key" ON "MetricsExclusion" ("supersedesMarkerId");
CREATE UNIQUE INDEX "MetricsExclusion_subject_root_key" ON "MetricsExclusion" ("subjectType", "subjectId")
  WHERE "supersedesMarkerId" IS NULL;

-- Evidence is an id or ticket reference, never free text: the table is append-only, so personal data or a secret
-- written here could never be removed. The pattern admits no whitespace, '@', bidi or zero-width character.
CREATE INDEX "MetricsExclusion_subjectType_subjectId_idx" ON "MetricsExclusion" ("subjectType", "subjectId");

-- Defence in depth for "operators only": the environment allowlist is enforced by the host on every request; the
-- database additionally refuses an actor that is not an active administrator account with an X id (as isAdmin).
CREATE FUNCTION raid_metrics_exclusion_actor_v1() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "User" WHERE "id" = NEW."actorAccountId" AND "role" = 'ADMIN' AND NOT "suspended"
      AND "xId" IS NOT NULL AND "xId" <> ''
  ) THEN
    RAISE EXCEPTION 'A metrics exclusion must be set by an active administrator account'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER metrics_exclusion_actor_v1
BEFORE INSERT ON "MetricsExclusion"
FOR EACH ROW EXECUTE FUNCTION raid_metrics_exclusion_actor_v1();

-- Same guard as AuditEvent and ConfigFlagChange: rejects every row UPDATE and DELETE; a statement trigger with the
-- same function closes TRUNCATE.
CREATE TRIGGER metrics_exclusion_guard_v1
BEFORE UPDATE OR DELETE ON "MetricsExclusion"
FOR EACH ROW EXECUTE FUNCTION raid_append_only_guard_v1();
CREATE TRIGGER metrics_exclusion_truncate_guard_v1
BEFORE TRUNCATE ON "MetricsExclusion"
FOR EACH STATEMENT EXECUTE FUNCTION raid_append_only_guard_v1();
COMMIT;
