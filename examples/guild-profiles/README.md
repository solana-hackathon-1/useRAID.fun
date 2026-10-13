# Independent Guild projection and profile permission host

See [the complete module contract](../../docs/raid-guild-profiles.md). This private synthetic example supplies its own trusted profile/fact records and installed zod4.6.5, bs586.0.0 and tsx4.23.15; Node22.12+. It needs no environment, database, global credentials, Next, Prisma or provider SDK.

```sh
cp -RL examples/guild-profiles /tmp/raid-guild-profile-host
cd /tmp/raid-guild-profile-host
npm install --ignore-scripts --no-audit --no-fund
npm start
```

Copy dereferences only canonical pure module files and shared contracts into a standalone host. Output is synthetictrue plus noPrivateProjection, holderDoesNotAdminister, alternateHost, delegatedFieldsOnly, unknownMembershipPreservesScope, treasurySeparate, expiredAndRevokedDenied and noPersistenceOrAuthorityToken, all true. No synthetic fact is a real Founder attestation or a role grant. CLI processes exit without owned services or runtime resources to stop.

A real host derives session/project/grant/approval/clock facts from its authorized records under the actual command locks, supplies UTC millisecond boundary semantics, applies expected revision/idempotent audit and uses private/public response models. Returned policy is informational and cannot be supplied back as a permission token. Storage, authenticated API, accepted project-control evidence and operational/privacy/recovery gates remain NOT VERIFIED; the example cannot be used to authorize funds, private code or ownership transfer.
