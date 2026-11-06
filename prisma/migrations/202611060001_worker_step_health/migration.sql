-- Additive (T038): one durable row per worker schedule step, so a stalled or failing step is visible without log access.
-- No existing table, constraint or data changes. Rollback: DROP TABLE "WorkerStepHealth" (diagnostic data only; nothing reads it for decisions).
BEGIN;
CREATE TABLE "WorkerStepHealth" (
  "step" TEXT NOT NULL,
  "lastRunAt" TIMESTAMPTZ(6) NOT NULL,
  "lastSuccessAt" TIMESTAMPTZ(6),
  "lastFailureAt" TIMESTAMPTZ(6),
  "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
  "lastErrorKind" TEXT,
  CONSTRAINT "WorkerStepHealth_pkey" PRIMARY KEY ("step"),
  CONSTRAINT "WorkerStepHealth_failures_check" CHECK ("consecutiveFailures" >= 0),
  CONSTRAINT "WorkerStepHealth_step_check" CHECK (char_length("step") BETWEEN 1 AND 120)
);
COMMIT;
