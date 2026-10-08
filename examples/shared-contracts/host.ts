// Copy src/contracts to ./contracts to run this standalone synthetic host.
import assert from 'node:assert/strict';
import {
  API_VERSION,
  EngagementSchema,
  PublicGuildSchema,
  parseDisplayAmount,
  consumesCapacity,
  createErrorEnvelope,
} from './contracts/index';

// The host declares every input. No RAID config/database/session/provider is imported.
const networkIdentity = 'synthetic-genesis';
const bound = 2n ** 64n - 1n; // fixture storage/program bound, not a production policy
const participantId = 'fixture-participant';
const asset = {
  chain: 'SOLANA',
  networkIdentity,
  kind: 'TOKEN',
  mint: 'So11111111111111111111111111111111111111112',
  tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
};
const terms = {
  id: 'fixture-terms-v1',
  guildId: 'fixture-guild',
  revision: 1,
  scope: 'Synthetic task only',
  acceptanceCriteria: ['Demonstrate contract consumption'],
  roster: [{ participantId, responsibility: 'Builder', consentRef: 'synthetic-consent' }],
  rewards: [
    {
      policy: {
        assetId: asset,
        registryVersion: 'synthetic-v1',
        verifiedDecimals: 6,
        observedAuthorities: [],
        supportedExtensionProfile: 'synthetic-only',
        observedAt: '2026-10-08T00:00:00Z',
        observedSlot: '1',
      },
      amount: parseDisplayAmount('250.50', 6, bound),
      beneficiaryParticipantId: participantId,
      beneficiaryRef: 'synthetic-destination',
    },
  ],
  deadlines: {
    preparation: '2026-10-09T00:00:00Z',
    submission: '2026-10-10T00:00:00Z',
    review: '2026-10-11T00:00:00Z',
    operationalClosure: '2026-10-12T00:00:00Z',
  },
  requiredSkills: [],
  eligibilityPolicyVersion: 'fixture-fit',
  allowedToolsPolicyVersion: 'fixture-tools',
  revisionPolicyVersion: 'fixture-revision',
  withdrawalPolicyVersion: 'fixture-withdrawal',
  terminationPolicyVersion: 'fixture-termination',
  rubricVersion: null,
  rightsPolicyVersion: 'fixture-rights',
  reviewPolicyVersion: 'fixture-review',
  disputePolicyVersion: 'fixture-dispute',
  finalityPolicyVersion: 'fixture-finality',
  createdAt: '2026-10-08T00:00:00Z',
};
const engagement = EngagementSchema.parse({
  id: 'fixture-engagement',
  guildId: terms.guildId,
  revision: 1,
  state: 'ACCESS_PENDING',
  source: { kind: 'RAID_SLOT', raidSlotId: 'fixture-slot' },
  acceptedTerms: terms,
});
const publicGuild = {
  id: terms.guildId,
  slug: 'fixture-guild',
  name: 'Synthetic Guild',
  description: 'Public fixture only',
  primaryToken: null,
};
const privateFieldRejected = !PublicGuildSchema.safeParse({
  ...publicGuild,
  repository: 'private-resource',
}).success;
const wrongSourceRejected = !EngagementSchema.safeParse({
  ...engagement,
  source: { kind: 'RAID_SLOT', raidSlotId: 'fixture-slot', challengeEntryId: 'other-source' },
}).success;
assert.equal(privateFieldRejected, true);
assert.equal(wrongSourceRejected, true);
assert.equal(createErrorEnvelope('ACCESS_NOT_GRANTED', 'fixture-request').status, 403);
assert.equal(Object.isFrozen(engagement.acceptedTerms), true);
console.log(
  JSON.stringify({
    contractVersion: API_VERSION,
    simulation: true,
    exactReward: engagement.acceptedTerms.rewards[0].amount,
    capacityHeld: consumesCapacity(engagement.state),
    terminalCapacityHeld: consumesCapacity('ACCEPTED'),
    privateFieldRejected,
    wrongSourceRejected,
  }),
);
