ALTER TABLE "Job" ADD COLUMN "failedAt" TIMESTAMP(3);
CREATE INDEX "Job_failedAt_idx" ON "Job"("failedAt");
UPDATE "PostSubmission" SET "status" = 'EXCLUDED', "reasonCode" = 'INVALID_POST'
 WHERE "status" = 'QUEUED'
   AND ("postId" !~ '^[1-9][0-9]{0,18}$' OR (length("postId") = 19 AND "postId" > '9223372036854775807'));
UPDATE "Job" SET "doneAt" = (NOW() AT TIME ZONE 'UTC'), "error" = NULL, "lockedAt" = NULL, "lease" = NULL
 WHERE "kind" = 'submission' AND "doneAt" IS NULL
   AND "payload"->>'submissionId' IN (SELECT "id" FROM "PostSubmission" WHERE "reasonCode" = 'INVALID_POST');
UPDATE "Job" SET "failedAt" = (NOW() AT TIME ZONE 'UTC') WHERE "doneAt" IS NULL AND "attempts" >= 8;
UPDATE "PostSubmission" s SET "status" = 'EXCLUDED', "reasonCode" = 'LOOKUP_FAILED'
 WHERE s."status" = 'QUEUED'
   AND EXISTS (SELECT 1 FROM "Job" j WHERE j."failedAt" IS NOT NULL AND j."kind" = 'submission' AND j."payload"->>'submissionId' = s."id")
   AND NOT EXISTS (SELECT 1 FROM "Job" j WHERE j."failedAt" IS NULL AND j."doneAt" IS NULL AND j."kind" = 'submission' AND j."payload"->>'submissionId' = s."id");
