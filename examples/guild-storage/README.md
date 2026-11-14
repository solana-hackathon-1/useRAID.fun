# Independent Guild storage host

Consumes `activateGuild`, `editGuildProfile`, `readPublicGuild`, `readManagedGuild`, `grantGuildRole`, `revokeGuildRole`, `proposeOwnershipTransfer`, `respondOwnershipTransfer`, `listPendingOwnershipTransfers`, `draftGuildUpdate`, `publishGuildUpdate`, `withdrawGuildUpdate`, `listPublicGuilds`, `listPublicGuildUpdates`, `listManagedGuildUpdates`, `listManagedGuilds`, `createGuildPublicHandlers`, `createGuildUpdatesHandlers`, `createGuildRolesHandlers`, `createGuildActivationHandlers` and `hasGuildAuthority` from `guild-profiles/guild-storage` against its own synthetic accounts, sessions and activation policy. See [the module documentation](../../docs/raid-guild-storage.md).

Requires Node ≥22.12 and a new empty loopback PostgreSQL 16 database named `useraid_guild_storage_host_test`. Copy this directory **dereferencing symlinks** and install its exact dependencies:

```
cp -RL examples/guild-storage /tmp/raid-guild-storage-host
cd /tmp/raid-guild-storage-host && npm install
DATABASE_URL=postgresql://.../useraid_guild_storage_host_test npm run migrate
DATABASE_URL=postgresql://.../useraid_guild_storage_host_test npm start
npm run manage   # renders GuildProfileEditor and GuildUpdatesManager with an injected transport
```

The host supplies the activation policy (here an allowlist of operator accounts that also lists one applicant, who is still refused as their own approver, over HTTP too), the session facts and the transaction port; it imports no RAID application state, global credential or Next/Prisma code. It demonstrates activation by an approver (the draft owner cannot self-activate), the public allowlist, a Founder edit, a holder-only account denied, revocation (a grantee's surrender, the Founder revoking a delegate so what the delegate passed on goes with it, and a repeat answered `GUILD_GRANT_ALREADY_REVOKED`), and treasury authority that is separate from profile administration. The synthetic delegate signs in with an `x` session and the others with `wallet`, the two methods the module accepts (the schema's `via` defaults to `x`, as in production). The treasury role is granted with `grantGuildRole`; the fixtures are synthetic and prove no real project verification.
