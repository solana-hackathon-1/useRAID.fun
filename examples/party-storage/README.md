# Independent Party storage host

Consumes `createParty`, `proposePartyRoster`, `recordPartyMemberConsent` and `readPartyProposal` from `parties/party-storage` (and the `PartyHost` write switch from `parties/contracts`) against its own synthetic accounts, sessions, participants, Guild authority and funding record. See [the module documentation](../../docs/raid-parties.md) and the [Parties reuse contract](../../docs/raid-module-reuse.md#parties-party-storage). The pure contracts, coverage rule and HTTP transport are driven by [`examples/parties`](../parties/README.md).

Requires Node >=22.12 and a new empty loopback PostgreSQL 16 database named `useraid_party_storage_host_test` (optionally with a `_<suffix>`). Copy this directory **dereferencing symlinks**, install its exact dependencies, generate the client and run:

```
cp -RL examples/party-storage /tmp/raid-party-storage-host
cd /tmp/raid-party-storage-host && npm install && npm run generate
DATABASE_URL=postgresql://.../useraid_party_storage_host_test npm run migrate
DATABASE_URL=postgresql://.../useraid_party_storage_host_test npm start
```

Expected JSON: every flag `true`. Stop and remove only the database you created for the run. Never point this host at the application database.

The host owns `schema.sql` (a minimal `User`, `Session` and `Participant` identity layout, declared to the lock helper through `identityLayout`, plus a Guild-authority and a funding record behind the work-loop `WorkHost` port). `migrations/` links the repository's own receipt, Raid terms, capacity, admission, simulated-reservation and Party migrations, so they cannot drift. It imports no RAID auth, application client, Next or configuration, and `connection.ts` is the only file that reads the environment.

It shows a Party led by the commanding human's own participant, an exact integer split that must add up to each reward leg (dust and shortfall refused), a roster only the leader can propose, a stale digest refused, a person outside the roster learning nothing, consent that is the signed-in member's own (the input names no participant), a direct insert that records another human's consent refused by the database guard, original receipts replaying while new writes are off, and no engagement or capacity created.

Fixture-only limits, all NOT VERIFIED beyond this synthetic run: publication still refuses `PARTY` terms, so the host publishes a `SOLO` slot and relabels its stored terms under `session_replication_role = replica` (superuser only, the very bypass the module documentation warns a production host must never allow its application role); the database guards trust `CommandReceipt` rows rather than an authenticated identity; and the database cannot check that `snapshotDigest` matches the snapshot. Party acceptance, atomic capacity and money are separate work.
