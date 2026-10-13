import assert from 'node:assert/strict';
import bs58 from 'bs58';
import {
  evaluateGuildHolderEligibility,
  GuildHolderObservationSchema,
  type GuildHolderObservationAdapter,
  type GuildHolderObservationRequest,
} from './guild-profiles/holder-observation';
import { evaluateGuildProfilePermission } from './guild-profiles/index';
const address = (value: number) => bs58.encode(new Uint8Array(32).fill(value));
const assetId = {
  chain: 'SOLANA' as const,
  kind: 'TOKEN' as const,
  networkIdentity: 'synthetic-genesis',
  mint: address(41),
  tokenProgram: address(42),
};
const ref = (recordId: string) => ({ recordId, revision: 1 });
const context = {
  version: 'v1',
  now: '2026-10-13T12:00:00Z',
  guild: {
    id: 'synthetic-guild',
    founderAccountId: 'other-founder',
    revision: 1,
    primaryToken: assetId,
  },
  relationship: { reference: ref('synthetic-relationship'), status: 'VERIFIED' },
  actorAccountId: 'self',
  actorSessionAuthorized: true,
  actorRestricted: false,
  accountId: 'self',
  wallets: [address(43), address(44)],
  policy: {
    reference: ref('synthetic-policy'),
    status: 'APPROVED',
    ownershipScope: 'CURRENT_VERIFIED_LINKED_WALLETS',
    minimumBalanceBaseUnits: '1',
    minimumFinality: 'FINALIZED',
    maxObservationAgeMs: 60000,
  },
};
const request: GuildHolderObservationRequest = {
  version: 'v1',
  guildId: context.guild.id,
  relationshipReference: context.relationship.reference,
  policyReference: context.policy.reference,
  assetId,
  wallets: context.wallets,
};
const fixture: GuildHolderObservationAdapter = {
  version: 'v1',
  async observe(r) {
    assert.deepEqual(r, request);
    return GuildHolderObservationSchema.parse({
      version: 'v1',
      status: 'VERIFIED',
      relationshipReference: r.relationshipReference,
      policyReference: r.policyReference,
      assetId: r.assetId,
      queriedWallets: [...r.wallets],
      complete: true,
      observedAt: '2026-10-13T11:59:30Z',
      observedSlot: '9007199254740993',
      finality: 'FINALIZED',
      provider: { id: 'synthetic-fixture', adapterVersion: 'v1' },
      accounts: [
        {
          address: address(45),
          owner: r.wallets[0],
          assetId: r.assetId,
          balanceBaseUnits: '9007199254740993',
        },
        { address: address(46), owner: r.wallets[1], assetId: r.assetId, balanceBaseUnits: '1' },
      ],
    });
  },
};
const alternate: GuildHolderObservationAdapter = {
  version: 'v1',
  async observe(r) {
    const value = await fixture.observe(r);
    return GuildHolderObservationSchema.parse(JSON.parse(JSON.stringify(value)));
  },
};
for (const adapter of [fixture, alternate]) {
  const observation = await adapter.observe(request),
    result = evaluateGuildHolderEligibility(context, observation);
  assert.equal(result.balanceBaseUnits, '9007199254740994');
  assert.equal(result.holderEligible, true);
  assert.equal(result.enrollsPublicAssociation, false);
  assert.equal(result.subscribesNotifications, false);
  assert.equal(result.affectsClaims, false);
  assert.equal(result.createsPermissionGrant, false);
  assert.equal(
    evaluateGuildProfilePermission(
      {
        version: 'v1',
        guild: context.guild,
        founderControlVerified: true,
        actorAccountId: 'self',
        actorSessionAuthorized: true,
        actorRestricted: false,
        holderEligible: result.holderEligible,
        now: context.now,
        grants: [],
      },
      { guildId: context.guild.id, expectedRevision: 1, action: 'EDIT_PROFILE', fields: ['name'] },
    ).allowed,
    false,
  );
  assert.equal(evaluateGuildHolderEligibility(context, null).holderEligible, null);
  assert.equal(
    evaluateGuildHolderEligibility(context, {
      version: 'v1',
      status: 'UNAVAILABLE',
      provider: { id: 'synthetic-fixture', adapterVersion: 'v1' },
    }).balanceBaseUnits,
    null,
  );
  assert.equal(
    evaluateGuildHolderEligibility({ ...context, now: '2026-10-13T12:00:30Z' }, observation).state,
    'STALE',
  );
}
console.log(
  JSON.stringify({
    synthetic: true,
    ownInstalledHost: true,
    replaceableCompleteScopePort: true,
    exactAssetIntegerAggregation: true,
    unavailableNeverZero: true,
    staleHonest: true,
    holderCannotEditPrivateProfile: true,
    noOptInOrClaimsMutation: true,
    noLiveProviderOrRecognition: true,
  }),
);
