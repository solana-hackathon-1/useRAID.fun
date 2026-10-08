import assert from 'node:assert/strict';
import {
  IDENTITY_PREFLIGHT_VERSION,
  IdentitySnapshotSchema,
  IdentitySubjectSchema,
  inspectAccountRemoval,
  inspectVerifiedLink,
  type IdentitySubject,
} from './identity';

// Synthetic trusted observations only. This host has no verifier, nonce store or writes.
const now = '2026-10-08T12:00:00Z';
const subject = IdentitySubjectSchema.parse({
  kind: 'PROVIDER',
  provider: 'synthetic-provider',
  subject: 'immutable-subject-42',
});
const snapshot = IdentitySnapshotSchema.parse({
  participant: { kind: 'HUMAN', id: 'synthetic-participant', accountId: 'synthetic-account' },
  revision: 3,
  status: 'ACTIVE',
  activeEngagementId: 'synthetic-engagement',
});
const policy = {
  domain: 'identity.test',
  uri: 'https://identity.test',
  providers: ['synthetic-provider'],
  walletNetworks: [],
};
const input = {
  actorAccountId: 'synthetic-account',
  expectedRevision: 3,
  subject,
  snapshot,
  session: { accountId: 'synthetic-account', state: 'ACTIVE', expiresAt: '2026-10-08T13:00:00Z' },
  ownership: { state: 'UNCLAIMED', subject },
  proof: {
    ref: 'synthetic-proof',
    state: 'VERIFIED',
    accountId: 'synthetic-account',
    intent: 'LINK',
    subject,
    domain: policy.domain,
    uri: policy.uri,
    issuedAt: '2026-10-08T11:59:00Z',
    expiresAt: '2026-10-08T12:01:00Z',
    consumed: false,
  },
};
// Alternate fixture suppliers satisfy the same subject-bound observation shape.
const supplierA = (requested: IdentitySubject) => ({ state: 'UNCLAIMED', subject: requested });
const supplierB = (requested: IdentitySubject) => structuredClone(supplierA(requested));
const proposal = inspectVerifiedLink({ ...input, ownership: supplierA(subject) }, policy, now);
const alternate = inspectVerifiedLink({ ...input, ownership: supplierB(subject) }, policy, now);
assert.deepEqual(proposal, alternate);
assert.equal(proposal.stage, 'READY_FOR_TRANSACTION');
assert.ok(proposal.stage === 'READY_FOR_TRANSACTION');
assert.equal(proposal.participantId, snapshot.participant.id);
assert.equal(proposal.activeEngagementId, snapshot.activeEngagementId);

const collision = inspectVerifiedLink(
  { ...input, ownership: { state: 'LINKED', subject, accountId: 'other' } },
  policy,
  now,
);
assert.deepEqual(collision, { stage: 'BLOCKED', code: 'IDENTITY_CONFLICT' });
const replay = inspectVerifiedLink(
  { ...input, proof: { ...input.proof, consumed: true } },
  policy,
  now,
);
assert.deepEqual(replay, { stage: 'BLOCKED', code: 'PROOF_INVALID' });
const revoked = inspectVerifiedLink(
  { ...input, ownership: { state: 'REVOKED', subject, accountId: 'synthetic-account' } },
  policy,
  now,
);
assert.deepEqual(revoked, { stage: 'BLOCKED', code: 'IDENTITY_REVOKED' });
const inventory = {
  state: 'COMPLETE',
  accountId: 'synthetic-account',
  participantId: 'synthetic-participant',
  revision: 3,
  references: [{ kind: 'CLAIM', id: 'synthetic-unpaid-claim' }],
};
const removal = inspectAccountRemoval({ kind: 'DELETE', drop: snapshot, inventory });
assert.deepEqual(removal, { stage: 'BLOCKED', code: 'RIGHTS_RETAINED' });
const unknown = inspectAccountRemoval({
  kind: 'DELETE',
  drop: snapshot,
  inventory: { ...inventory, state: 'UNKNOWN' },
});
assert.deepEqual(unknown, { stage: 'BLOCKED', code: 'INVENTORY_UNKNOWN' });
console.log(
  JSON.stringify({
    version: IDENTITY_PREFLIGHT_VERSION,
    simulation: true,
    executionEnabled: false,
    sameParticipant: true,
    capacityRetained: true,
    subjectSupplierReplacementStable: true,
    collisionBlocked: true,
    replayBlocked: true,
    removalBlocked: true,
    unknownInventoryBlocked: true,
    revokedLinkBlocked: true,
  }),
);
