-- DEC-2026-11-14-08 / DEC-2026-11-13-06 b (#352 item 5): scheduled closures act as the named, credential-less service
-- principal `work-closure`, which is not a User row. A closure records either a human account id or the principal
-- (exactly one). Additive: one nullable column, one relaxed NOT NULL, three CHECKs; past closures keep their recorded
-- human actor and satisfy the new CHECKs unchanged.
-- Rollback: only while no closure names the principal. Drop the three constraints and the column, then restore NOT NULL
-- on "closedByAccountId". Once a worker closure exists the principal column carries its only actor, so keep it.
BEGIN;
ALTER TABLE "EngagementClosure" ADD COLUMN "closedByPrincipal" text;
ALTER TABLE "EngagementClosure" ALTER COLUMN "closedByAccountId" DROP NOT NULL;
ALTER TABLE "EngagementClosure" ADD CONSTRAINT "EngagementClosure_closer_check"
  CHECK (num_nonnulls("closedByAccountId","closedByPrincipal")=1);
-- The only principal is `work-closure`, and it can record only a timeout: acceptance needs the independent reviewer.
ALTER TABLE "EngagementClosure" ADD CONSTRAINT "EngagementClosure_principal_check"
  CHECK ("closedByPrincipal" IS NULL OR ("closedByPrincipal"='work-closure' AND "reason"<>'ACCEPTED'));
-- The principal's name can never become an account (it keys receipts and audit). NOT VALID then VALIDATE keeps the
-- table scan out of the stronger lock taken to add the constraint.
ALTER TABLE "User" ADD CONSTRAINT "User_service_principal_check" CHECK ("id"<>'work-closure') NOT VALID;
ALTER TABLE "User" VALIDATE CONSTRAINT "User_service_principal_check";
COMMIT;
