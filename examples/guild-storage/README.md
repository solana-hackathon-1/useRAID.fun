# Independent Guild storage host

Consumes `activateGuild`, `editGuildProfile`, `readPublicGuild`, `readManagedGuild`, `grantGuildRole`, `revokeGuildRole`, `proposeOwnershipTransfer`, `respondOwnershipTransfer`, `draftGuildUpdate`, `publishGuildUpdate`, `withdrawGuildUpdate`, `listPublicGuildUpdates`, `listManagedGuildUpdates`, `createGuildPublicHandlers`, `createGuildUpdatesHandlers` and `hasGuildAuthority` from `guild-profiles/guild-storage` against its own synthetic accounts, sessions and activation policy. See [the module documentation](../../docs/raid-guild-storage.md).

Requires Node ≥22.12 and a new empty loopback PostgreSQL 16 database named `useraid_guild_storage_host_test`. Copy this directory **dereferencing symlinks** and install its exact dependencies:

```
cp -RL examples/guild-storage /tmp/raid-guild-storage-host
cd /tmp/raid-guild-storage-host && npm install
DATABASE_URL=postgresql://.../useraid_guild_storage_host_test npm run migrate
DATABASE_URL=postgresql://.../useraid_guild_storage_host_test npm start
```

The host supplies the activation policy (here one approver account), the session facts and the transaction port; it imports no RAID application state, global credential or Next/Prisma code. It demonstrates activation by an approver (the draft owner cannot self-activate), the public allowlist, a Founder edit, a holder-only account denied, and treasury authority that is separate from profile administration. The treasury role is granted with `grantGuildRole`; the fixtures are synthetic and prove no real project verification.
