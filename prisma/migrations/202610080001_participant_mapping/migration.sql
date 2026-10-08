-- Additive HUMAN mapping; proposal70c654f independently reviewed before disposable execution.
-- No backfill. Preserve this fence on application rollback after a mapping is acknowledged.
BEGIN;

CREATE TABLE "Participant" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "kind" TEXT NOT NULL DEFAULT 'HUMAN',
  "accountId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "provisionActorAccountId" TEXT NOT NULL,
  "provisionRequestId" TEXT NOT NULL,
  CONSTRAINT "Participant_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Participant_kind_check" CHECK ("kind" = 'HUMAN'),
  CONSTRAINT "Participant_account_id_check" CHECK (
    char_length("accountId") BETWEEN 1 AND 200
    AND "accountId" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  ),
  CONSTRAINT "Participant_provision_actor_check" CHECK (
    "provisionActorAccountId" = "accountId"
  ),
  CONSTRAINT "Participant_provision_request_check" CHECK (
    char_length("provisionRequestId") BETWEEN 1 AND 200
    AND "provisionRequestId" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  ),
  CONSTRAINT "Participant_accountId_fkey" FOREIGN KEY ("accountId")
    REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "Participant_accountId_key" ON "Participant"("accountId");

CREATE FUNCTION raid_participant_mapping_guard_v1() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Participant mapping requires reviewed recovery or retention'
      USING ERRCODE = '23000';
  END IF;
  IF NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Participant mapping and provisioning provenance are immutable'
      USING ERRCODE = '23000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER participant_mapping_guard_v1
BEFORE UPDATE OR DELETE ON "Participant"
FOR EACH ROW EXECUTE FUNCTION raid_participant_mapping_guard_v1();

COMMIT;
