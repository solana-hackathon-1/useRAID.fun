-- DEC-2026-11-13-04 (b)(c): TREASURY and DISPUTE authority stay apart from the Founder role and from each other, as a
-- database invariant that a direct writer cannot bypass. Additive: two functions and two triggers, no table, column or
-- data change, and no earlier migration is touched. "Live" means unrevoked and unexpired at the database clock; a grant
-- that has not started yet counts, since it would become live under the same holder.
--   (b) no live TREASURY/DISPUTE grant names the Guild's current Founder, checked on grant insert and on Founder change;
--   (c) no account holds live TREASURY and DISPUTE in the same Guild.
-- Both checks first take the Guild row lock (FOR UPDATE, the lock every Guild command already takes), so concurrent
-- grants, and a grant racing a Founder change, are decided one after the other; each later statement reads the
-- committed result of the earlier one at READ COMMITTED.
-- No explicit BEGIN/COMMIT: the script runs as one implicit transaction, so a failed preflight rolls everything back and
-- the migration runner still reports the original error (an explicit BEGIN leaves the session aborted and hides it).

-- Existing data is reported, never altered: any live row that already violates (b) or (c) fails this migration so an
-- operator resolves it (revoke the grant through the application, or correct the Founder) and re-runs it.
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
  RAISE EXCEPTION 'Guild role separation: % conflicting grant(s); resolve them before this migration (first ids: %)', conflicts, sample USING ERRCODE='23000';
 END IF;
END;
$$;

CREATE FUNCTION raid_guild_grant_separation_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE founder text;
BEGIN
 -- A grant that is revoked or already expired on insert can never be live.
 IF NEW."kind" NOT IN ('TREASURY','DISPUTE') OR NEW."revokedAt" IS NOT NULL
    OR (NEW."expiresAt" IS NOT NULL AND NEW."expiresAt"<=clock_timestamp()) THEN RETURN NEW; END IF;
 SELECT "founderAccountId" INTO founder FROM "Guild" WHERE "id"=NEW."guildId" FOR UPDATE;
 IF founder IS NOT DISTINCT FROM NEW."granteeAccountId" THEN
  RAISE EXCEPTION 'A Guild Founder cannot hold treasury or dispute authority' USING ERRCODE='23000';
 END IF;
 IF EXISTS (SELECT 1 FROM "GuildRoleGrant" o WHERE o."guildId"=NEW."guildId" AND o."granteeAccountId"=NEW."granteeAccountId"
     AND o."kind" IN ('TREASURY','DISPUTE') AND o."kind"<>NEW."kind"
     AND o."revokedAt" IS NULL AND (o."expiresAt" IS NULL OR o."expiresAt">clock_timestamp())) THEN
  RAISE EXCEPTION 'One account cannot hold treasury and dispute authority in the same Guild' USING ERRCODE='23000';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER guild_grant_separation_v1 BEFORE INSERT ON "GuildRoleGrant" FOR EACH ROW EXECUTE FUNCTION raid_guild_grant_separation_v1();

-- A Founder change updates (and so already row-locks) the Guild; the grant check above takes the same lock.
CREATE FUNCTION raid_guild_founder_separation_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS (SELECT 1 FROM "GuildRoleGrant" r WHERE r."guildId"=NEW."id" AND r."granteeAccountId"=NEW."founderAccountId"
     AND r."kind" IN ('TREASURY','DISPUTE') AND r."revokedAt" IS NULL AND (r."expiresAt" IS NULL OR r."expiresAt">clock_timestamp())) THEN
  RAISE EXCEPTION 'A Guild Founder cannot hold treasury or dispute authority' USING ERRCODE='23000';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER guild_founder_separation_v1 BEFORE UPDATE OF "founderAccountId" ON "Guild" FOR EACH ROW
 WHEN (NEW."founderAccountId" IS DISTINCT FROM OLD."founderAccountId") EXECUTE FUNCTION raid_guild_founder_separation_v1();
