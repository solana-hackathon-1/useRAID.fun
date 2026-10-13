import assert from 'node:assert/strict';
import {
  prepareGuildProfileDraft,
  projectPublicGuildProfile,
  evaluateGuildProfilePermission,
} from './guild-profiles';
const guild = {
  id: 'synthetic-guild-1',
  founderAccountId: 'synthetic-founder',
  revision: 1,
  primaryToken: null,
};
const draft = prepareGuildProfileDraft({
  name: 'Synthetic Guild',
  slug: 'synthetic-guild',
  description: 'Approved public fixture',
});
const publicProfile = { ...draft.profile, id: guild.id };
const projected = projectPublicGuildProfile({
  version: 'v1',
  guild,
  publicProfile,
  publicProfileApproved: true,
  privateContext: { repositories: ['synthetic-private-repo'], notes: 'synthetic-private-note' },
});
assert(!JSON.stringify(projected).includes('synthetic-private'));
assert(!('founderAccountId' in projected));
const facts = {
  version: 'v1',
  guild,
  founderControlVerified: true,
  actorAccountId: 'synthetic-holder',
  actorSessionAuthorized: true,
  actorRestricted: false,
  holderEligible: true,
  now: '2026-10-13T00:00:00.000Z',
  grants: [],
};
const command = {
  guildId: guild.id,
  expectedRevision: 1,
  action: 'EDIT_PROFILE',
  fields: ['name'],
};
assert.equal(evaluateGuildProfilePermission(facts, command).allowed, false);
const alternateHost = {
  ...facts,
  actorAccountId: 'synthetic-editor',
  holderEligible: null,
  grants: [
    {
      id: 'synthetic-grant',
      guildId: guild.id,
      granteeAccountId: 'synthetic-editor',
      status: 'ACTIVE',
      fields: ['name'],
      canDelegateProfile: false,
      validFrom: '2026-10-12T00:00:00Z',
      expiresAt: '2026-10-14T00:00:00.000Z',
    },
  ],
};
assert.equal(evaluateGuildProfilePermission(alternateHost, command).allowed, true);
assert.equal(
  evaluateGuildProfilePermission(alternateHost, { ...command, fields: ['description'] }).allowed,
  false,
);
assert.equal(
  evaluateGuildProfilePermission(
    { ...facts, actorAccountId: guild.founderAccountId },
    { ...command, action: 'TREASURY_SETTLE' },
  ).allowed,
  false,
);
assert.equal(
  evaluateGuildProfilePermission({ ...alternateHost, now: '2026-10-14T00:00:00Z' }, command)
    .allowed,
  false,
);
assert.equal(
  evaluateGuildProfilePermission(
    { ...alternateHost, grants: alternateHost.grants.map((g) => ({ ...g, status: 'REVOKED' })) },
    command,
  ).allowed,
  false,
);
console.log(
  JSON.stringify({
    synthetic: true,
    noPrivateProjection: true,
    holderDoesNotAdminister: true,
    alternateHost: true,
    delegatedFieldsOnly: true,
    unknownMembershipPreservesScope: true,
    treasurySeparate: true,
    expiredAndRevokedDenied: true,
    noPersistenceOrAuthorityToken: true,
  }),
);
