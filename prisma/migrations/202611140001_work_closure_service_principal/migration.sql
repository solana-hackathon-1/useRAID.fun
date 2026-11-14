-- DEC-2026-11-14-08 / DEC-2026-11-13-06 b (#352 item 5): scheduled closures act as the named, credential-less service
-- principal `work-closure`, which is not a User row. A closure records either a human account id or the principal
-- (exactly one). Additive: one nullable column, one relaxed NOT NULL, three CHECKs; past closures keep their recorded
-- human actor and satisfy the new CHECKs unchanged.
-- Rollback: roll the application back, and the schema, only before the first worker close records the principal. Drop the
-- three constraints and the column, then restore NOT NULL on "closedByAccountId". After the first worker close the
-- principal column carries that closure's only actor and the previous release cannot represent it, so keep the schema
-- and roll forward.
BEGIN;
-- A User named like the principal would collide with its receipts and audit actor; refuse with a clear error rather than
-- a constraint violation.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "User" WHERE "id"='work-closure') THEN
    RAISE EXCEPTION 'User "work-closure" exists; that id is reserved for the work-closure service principal (DEC-2026-11-14-08). Rename or remove it before applying this migration.' USING ERRCODE='23514';
  END IF;
END $$;
ALTER TABLE "EngagementClosure" ADD COLUMN "closedByPrincipal" text;
ALTER TABLE "EngagementClosure" ALTER COLUMN "closedByAccountId" DROP NOT NULL;
ALTER TABLE "EngagementClosure" ADD CONSTRAINT "EngagementClosure_closer_check"
  CHECK (num_nonnulls("closedByAccountId","closedByPrincipal")=1);
-- The only principal is `work-closure`, and it can record only a timeout: acceptance needs the independent reviewer.
ALTER TABLE "EngagementClosure" ADD CONSTRAINT "EngagementClosure_principal_check"
  CHECK ("closedByPrincipal" IS NULL OR ("closedByPrincipal"='work-closure' AND "reason"<>'ACCEPTED'));
-- The principal's name can never become an account (it keys receipts and audit). This transaction holds ACCESS EXCLUSIVE
-- on "User" for the table scan the constraint needs; the pre-check above has already shown no row matches.
ALTER TABLE "User" ADD CONSTRAINT "User_service_principal_check" CHECK ("id"<>'work-closure');
COMMIT;
