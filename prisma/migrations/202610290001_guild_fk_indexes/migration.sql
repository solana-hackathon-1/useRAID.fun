-- Additive: index the account side of three Guild foreign keys (#290 item 3) so a User lookup, lock or key check
-- does not scan Guild, profile-version or grant rows. No data, guard or constraint changes.
BEGIN;
CREATE INDEX "Guild_activatedBy_idx" ON "Guild"("activatedByAccountId");
CREATE INDEX "GuildProfileVersion_actor_idx" ON "GuildProfileVersion"("actorAccountId");
CREATE INDEX "GuildRoleGrant_grantedBy_idx" ON "GuildRoleGrant"("grantedByAccountId");
COMMIT;
