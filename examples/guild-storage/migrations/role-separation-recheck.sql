-- Follow-up to 202611130007_guild_role_separation (PR #470 review, #471 item 1). No table, column, trigger or data change;
-- 202611130007 stays as released.
-- 007 reported existing violations without locking, so a violating grant could commit between its report and its CREATE
-- TRIGGER, and then be neither reported nor (being older than the triggers) refused. This script repeats the same report
-- while both tables are locked against writes (SHARE ROW EXCLUSIVE: readers continue, inserts and updates wait), so the
-- result is the committed state with no writer in flight, and it fails loudly the same way. Reports only; it never
-- revokes or edits a row. An operator revokes the offending grant through the application (or corrects the Founder),
-- runs `prisma migrate resolve --rolled-back 202611130008_guild_role_separation_recheck` and re-runs `migrate deploy`.
-- `lock_timeout` makes the migration fail instead of queueing behind a long-running writer (and so blocking every new
-- writer behind its own pending lock request); it is local to this script's implicit transaction.
-- Assumptions the 007 triggers rely on, recorded here because this is the next migration to touch them:
--   * Direct (non-application) writers must lock the Guild row first (`SELECT ... FROM "Guild" ... FOR UPDATE`) before
--     writing GuildRoleGrant or the Guild's Founder, the order every command and both triggers use. A direct writer that
--     already holds only FOR KEY SHARE on the Guild (for example from a foreign-key check) and then reaches the trigger's
--     FOR UPDATE can deadlock against a concurrent one; Postgres aborts one with 40P01 and the retry succeeds.
--   * The triggers read their conflict check with a fresh snapshot after the Guild lock, which is correct at READ
--     COMMITTED (the default and the level `runCommandTransaction` uses). At REPEATABLE READ or SERIALIZABLE the
--     transaction snapshot is older than the lock wait, so a direct writer there must not rely on these triggers alone.
--   * DEC-2026-11-13-04 (d), refusing TREASURY/DISPUTE to the recipient of an open ownership proposal, is enforced only
--     in the application (`grantGuildRole`). The database does not enforce it: a direct writer may grant it, and the
--     Founder-change trigger then refuses the acceptance instead (invariant (b)).
-- No explicit BEGIN/COMMIT: one implicit transaction, so a failure rolls back and the runner reports the original error.

SET LOCAL lock_timeout = '30s';
LOCK TABLE "GuildRoleGrant", "Guild" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE conflicts int; sample text;
BEGIN
 WITH bad AS (
  SELECT r."id" FROM "GuildRoleGrant" r JOIN "Guild" g ON g."id"=r."guildId" AND g."founderAccountId"=r."granteeAccountId"
   WHERE r."kind" IN ('TREASURY','DISPUTE') AND r."revokedAt" IS NULL AND (r."expiresAt" IS NULL OR r."expiresAt">clock_timestamp())
  UNION
  SELECT r."id" FROM "GuildRoleGrant" r JOIN "GuildRoleGrant" o
    ON o."guildId"=r."guildId" AND o."granteeAccountId"=r."granteeAccountId" AND o."kind"<>r."kind"
   WHERE r."kind" IN ('TREASURY','DISPUTE') AND o."kind" IN ('TREASURY','DISPUTE')
     AND r."revokedAt" IS NULL AND (r."expiresAt" IS NULL OR r."expiresAt">clock_timestamp())
     AND o."revokedAt" IS NULL AND (o."expiresAt" IS NULL OR o."expiresAt">clock_timestamp()))
 SELECT count(*), string_agg("id"::text, ', ' ORDER BY "id") FILTER (WHERE "rank"<=10) INTO conflicts, sample
  FROM (SELECT "id", row_number() OVER (ORDER BY "id") AS "rank" FROM bad) ranked;
 IF conflicts>0 THEN
  RAISE EXCEPTION 'Guild role separation: % conflicting grant(s) found by the locked recheck; resolve them first (first ids: %)', conflicts, sample USING ERRCODE='23000';
 END IF;
END;
$$;
