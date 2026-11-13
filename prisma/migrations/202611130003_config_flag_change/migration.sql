-- Additive (DEC-2026-11-13-01, T037-W03): append-only record of deploy-time feature-flag changes from a startup snapshot
-- diff. One new table and one trigger; no existing table, constraint or data changes. Rollback: DROP TABLE "ConfigFlagChange"
-- (diagnostic audit only; nothing reads it for decisions). Flag names and the closed words true/false/unset/invalid only:
-- no secret or free-form environment text can be stored.
BEGIN;
CREATE TABLE "ConfigFlagChange" (
  "id" BIGSERIAL NOT NULL,
  "environment" TEXT NOT NULL,
  "processKind" TEXT NOT NULL,
  "flagName" TEXT NOT NULL,
  "previousValue" TEXT,
  "newValue" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "deploymentId" TEXT,
  "actor" TEXT NOT NULL DEFAULT 'deployment, unattributed',
  "recordedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "ConfigFlagChange_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ConfigFlagChange_environment_check" CHECK ("environment" IN ('production','pilot','staging','alpha','demo','local','undeclared','unrecognised')),
  CONSTRAINT "ConfigFlagChange_processKind_check" CHECK ("processKind" IN ('web','worker')),
  CONSTRAINT "ConfigFlagChange_flagName_check" CHECK ("flagName" ~ '^[A-Z][A-Z0-9_]{0,119}$'),
  CONSTRAINT "ConfigFlagChange_newValue_check" CHECK ("newValue" IN ('true','false','unset','invalid')),
  CONSTRAINT "ConfigFlagChange_previousValue_check" CHECK ("previousValue" IS NULL OR "previousValue" IN ('true','false','unset','invalid')),
  CONSTRAINT "ConfigFlagChange_kind_check" CHECK (
    ("kind" = 'INITIAL_OBSERVATION' AND "previousValue" IS NULL)
    OR ("kind" = 'CHANGE' AND "previousValue" IS DISTINCT FROM "newValue")
  ),
  CONSTRAINT "ConfigFlagChange_deploymentId_check" CHECK ("deploymentId" IS NULL OR "deploymentId" ~ '^[A-Za-z0-9._:-]{1,100}$'),
  CONSTRAINT "ConfigFlagChange_actor_check" CHECK (char_length("actor") BETWEEN 1 AND 100)
);
CREATE INDEX "ConfigFlagChange_environment_processKind_flagName_id_idx"
  ON "ConfigFlagChange" ("environment", "processKind", "flagName", "id");

-- Same guard as AuditEvent (202610090001): the shared function rejects every row UPDATE and DELETE. A row trigger never
-- fires for TRUNCATE, so a statement-level trigger with the same function closes that route as well.
CREATE TRIGGER config_flag_change_guard_v1
BEFORE UPDATE OR DELETE ON "ConfigFlagChange"
FOR EACH ROW EXECUTE FUNCTION raid_append_only_guard_v1();
CREATE TRIGGER config_flag_change_truncate_guard_v1
BEFORE TRUNCATE ON "ConfigFlagChange"
FOR EACH STATEMENT EXECUTE FUNCTION raid_append_only_guard_v1();
COMMIT;
