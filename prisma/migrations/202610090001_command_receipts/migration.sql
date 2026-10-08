-- T019 command receipts, audit and outbox foundation (blueprint 26.1, 27.3, 27.5; T003 phase P3).
-- Additive: four new tables, three functions, no change to any existing object, no backfill.
-- Rollback: before consumers exist the tables may be dropped; once receipts are acknowledged keep them
-- (dropping loses idempotency memory and audit history).
BEGIN;

CREATE TABLE "CommandReceipt" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "actorId" TEXT NOT NULL,
  "commandKind" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "requestDigest" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "resultRef" TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CommandReceipt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CommandReceipt_actor_check" CHECK (
    char_length("actorId") BETWEEN 1 AND 200 AND "actorId" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  ),
  CONSTRAINT "CommandReceipt_kind_check" CHECK ("commandKind" ~ '^[A-Z][A-Za-z0-9]{2,63}$'),
  CONSTRAINT "CommandReceipt_key_check" CHECK (
    char_length("idempotencyKey") BETWEEN 1 AND 200 AND "idempotencyKey" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  ),
  CONSTRAINT "CommandReceipt_digest_check" CHECK ("requestDigest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "CommandReceipt_request_check" CHECK (
    char_length("requestId") BETWEEN 1 AND 200 AND "requestId" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  ),
  CONSTRAINT "CommandReceipt_result_check" CHECK (
    "resultRef" IS NULL
    OR (char_length("resultRef") BETWEEN 1 AND 200 AND "resultRef" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$')
  )
);

CREATE TABLE "InboxDelivery" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "provider" TEXT NOT NULL,
  "deliveryId" TEXT NOT NULL,
  "payloadDigest" TEXT NOT NULL,
  "resultRef" TEXT,
  "receivedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InboxDelivery_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InboxDelivery_provider_check" CHECK ("provider" ~ '^[a-z][a-z0-9_-]{1,63}$'),
  CONSTRAINT "InboxDelivery_delivery_check" CHECK (
    char_length("deliveryId") BETWEEN 1 AND 120 AND "deliveryId" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  ),
  CONSTRAINT "InboxDelivery_digest_check" CHECK ("payloadDigest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "InboxDelivery_result_check" CHECK (
    "resultRef" IS NULL
    OR (char_length("resultRef") BETWEEN 1 AND 200 AND "resultRef" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$')
  )
);

CREATE TABLE "AuditEvent" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "receiptId" UUID,
  "inboxId" UUID,
  "ordinal" INTEGER NOT NULL,
  "eventType" TEXT NOT NULL,
  "aggregateId" TEXT NOT NULL,
  "aggregateVersion" INTEGER NOT NULL,
  "actorId" TEXT NOT NULL,
  "guildId" TEXT,
  "correlationId" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "occurredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AuditEvent_source_check" CHECK (num_nonnulls("receiptId", "inboxId") = 1),
  CONSTRAINT "AuditEvent_ordinal_check" CHECK ("ordinal" BETWEEN 0 AND 19),
  CONSTRAINT "AuditEvent_type_check" CHECK (
    "eventType" ~ '^(identity|guild|launch|work|treasury|access|challenge|execution)\.[a-z][a-z_]*\.v1$'
  ),
  CONSTRAINT "AuditEvent_aggregate_check" CHECK (
    char_length("aggregateId") BETWEEN 1 AND 200 AND "aggregateId" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  ),
  CONSTRAINT "AuditEvent_version_check" CHECK ("aggregateVersion" >= 1),
  CONSTRAINT "AuditEvent_actor_check" CHECK (
    char_length("actorId") BETWEEN 1 AND 200 AND "actorId" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  ),
  CONSTRAINT "AuditEvent_guild_check" CHECK (
    "guildId" IS NULL
    OR (char_length("guildId") BETWEEN 1 AND 200 AND "guildId" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$')
  ),
  CONSTRAINT "AuditEvent_correlation_check" CHECK (
    char_length("correlationId") BETWEEN 1 AND 200 AND "correlationId" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  ),
  CONSTRAINT "AuditEvent_payload_check" CHECK (
    jsonb_typeof("payload") = 'object' AND octet_length("payload"::text) <= 2048
  ),
  CONSTRAINT "AuditEvent_receiptId_fkey" FOREIGN KEY ("receiptId")
    REFERENCES "CommandReceipt"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "AuditEvent_inboxId_fkey" FOREIGN KEY ("inboxId")
    REFERENCES "InboxDelivery"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TABLE "OutboxEvent" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "eventId" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OutboxEvent_eventId_fkey" FOREIGN KEY ("eventId")
    REFERENCES "AuditEvent"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "CommandReceipt_actorId_commandKind_idempotencyKey_key"
  ON "CommandReceipt"("actorId", "commandKind", "idempotencyKey");
CREATE UNIQUE INDEX "InboxDelivery_provider_deliveryId_key" ON "InboxDelivery"("provider", "deliveryId");
CREATE UNIQUE INDEX "AuditEvent_receiptId_ordinal_key" ON "AuditEvent"("receiptId", "ordinal");
CREATE UNIQUE INDEX "AuditEvent_inboxId_ordinal_key" ON "AuditEvent"("inboxId", "ordinal");
CREATE INDEX "AuditEvent_aggregateId_occurredAt_idx" ON "AuditEvent"("aggregateId", "occurredAt");
CREATE UNIQUE INDEX "OutboxEvent_eventId_key" ON "OutboxEvent"("eventId");
CREATE INDEX "OutboxEvent_createdAt_idx" ON "OutboxEvent"("createdAt");

-- Receipts and inbox rows: immutable, except one NULL -> value transition of "resultRef" in the claiming transaction.
CREATE FUNCTION raid_receipt_guard_v1() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Command records are immutable; removal needs a reviewed retention procedure'
      USING ERRCODE = '23000';
  END IF;
  IF OLD."resultRef" IS NULL AND NEW."resultRef" IS NOT NULL
     AND (to_jsonb(NEW) - 'resultRef') = (to_jsonb(OLD) - 'resultRef') THEN
    RETURN NEW;
  END IF;
  IF NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Command records are immutable after the result reference is set'
    USING ERRCODE = '23000';
END;
$$;

CREATE TRIGGER command_receipt_guard_v1
BEFORE UPDATE OR DELETE ON "CommandReceipt"
FOR EACH ROW EXECUTE FUNCTION raid_receipt_guard_v1();
CREATE TRIGGER inbox_delivery_guard_v1
BEFORE UPDATE OR DELETE ON "InboxDelivery"
FOR EACH ROW EXECUTE FUNCTION raid_receipt_guard_v1();

-- A claim whose transaction commits must carry its result reference.
CREATE FUNCTION raid_result_required_v1() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  missing boolean;
BEGIN
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I WHERE "id" = $1 AND "resultRef" IS NULL)',
    TG_TABLE_SCHEMA, TG_TABLE_NAME) INTO missing USING NEW."id";
  IF missing THEN
    RAISE EXCEPTION 'A committed command record requires its result reference'
      USING ERRCODE = '23000';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER command_receipt_result_required_v1
AFTER INSERT ON "CommandReceipt"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION raid_result_required_v1();
CREATE CONSTRAINT TRIGGER inbox_delivery_result_required_v1
AFTER INSERT ON "InboxDelivery"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION raid_result_required_v1();

-- Audit and outbox intents: append-only.
CREATE FUNCTION raid_append_only_guard_v1() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Audit and outbox records are append-only'
    USING ERRCODE = '23000';
END;
$$;

CREATE TRIGGER audit_event_guard_v1
BEFORE UPDATE OR DELETE ON "AuditEvent"
FOR EACH ROW EXECUTE FUNCTION raid_append_only_guard_v1();
CREATE TRIGGER outbox_event_guard_v1
BEFORE UPDATE OR DELETE ON "OutboxEvent"
FOR EACH ROW EXECUTE FUNCTION raid_append_only_guard_v1();

COMMIT;
