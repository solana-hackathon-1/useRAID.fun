-- Additive (#352 item 2, DEC-2026-11-13-06 a): one durable back-off record per engagement whose scheduled closure
-- attempt failed, so a persistently failing engagement is retried at a bounded, doubling interval instead of on every
-- pass. Operational state only: it decides no money, fault, closure or capacity release, and a missing row means
-- "attempt now". No existing table, constraint or data changes.
-- Rollback: DROP TABLE "EngagementClosureBackoff" (every engagement is then attempted on the next pass).
BEGIN;
CREATE TABLE "EngagementClosureBackoff" (
  "engagementId" UUID NOT NULL,
  "consecutiveFailures" INTEGER NOT NULL,
  "lastFailureCode" TEXT NOT NULL,
  "nextAttemptAt" TIMESTAMPTZ(6) NOT NULL,
  "alertedAt" TIMESTAMPTZ(6),
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "EngagementClosureBackoff_pkey" PRIMARY KEY ("engagementId"),
  CONSTRAINT "EngagementClosureBackoff_failures_check" CHECK ("consecutiveFailures" >= 1),
  CONSTRAINT "EngagementClosureBackoff_code_check" CHECK (char_length("lastFailureCode") BETWEEN 1 AND 80),
  CONSTRAINT "EngagementClosureBackoff_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "Engagement"("id") ON DELETE CASCADE ON UPDATE RESTRICT
);
CREATE INDEX "EngagementClosureBackoff_nextAttemptAt_idx" ON "EngagementClosureBackoff"("nextAttemptAt");
COMMIT;
