import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import {
  createProjectControlMessage,
  evaluateProjectControlProof,
  type ProjectControlSignatureVerifier,
} from './guild-profiles/control-attestation';
import { ed25519ProjectControlVerifier } from './guild-profiles/ed25519-control-verifier';
import {
  createProjectProposalControlMessage,
  evaluateProjectProposalControlProof,
} from './guild-profiles/proposal-control';
// Deterministic disposable synthetic fixture, never an approved live project/key/policy.
const key = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(23));
const assetId = {
  chain: 'SOLANA',
  networkIdentity: 'synthetic-genesis',
  kind: 'TOKEN',
  mint: bs58.encode(new Uint8Array(32).fill(24)),
  tokenProgram: bs58.encode(new Uint8Array(32).fill(25)),
};
const reference = (recordId: string) => ({ recordId, revision: 1 });
const context = {
  version: 'v1',
  purpose: 'EXISTING_PROJECT_CONTROL',
  challengeId: 'synthetic-challenge',
  origin: 'https://synthetic.example',
  actorAccountId: 'synthetic-owner',
  guildDraftId: '11111111-1111-4111-8111-111111111111',
  draftRevision: 1,
  assetId,
  signer: bs58.encode(key.publicKey),
  nonce: 'a'.repeat(64),
  issuedAt: '2026-10-13T09:00:00Z',
  expiresAt: '2026-10-13T09:05:00Z',
  policy: reference('synthetic-policy'),
  authority: reference('synthetic-authority'),
  publicEvidence: reference('synthetic-evidence'),
};
const facts = {
  version: 'v1',
  now: '2026-10-13T09:02:00Z',
  origin: context.origin,
  actor: { accountId: context.actorAccountId, sessionAuthorized: true, restricted: false },
  draft: { id: context.guildDraftId, ownerAccountId: context.actorAccountId, revision: 1 },
  challengeState: 'AVAILABLE',
  policy: {
    reference: context.policy,
    status: 'APPROVED',
    purpose: 'EXISTING_PROJECT_CONTROL',
    route: 'PROJECT_WALLET_SIGNATURE',
  },
  authority: {
    reference: context.authority,
    policyReference: context.policy,
    assetId,
    signer: context.signer,
    status: 'CURRENT',
    observedAt: context.issuedAt,
    validUntil: context.expiresAt,
  },
  publicEvidence: {
    reference: context.publicEvidence,
    policyReference: context.policy,
    authorityReference: context.authority,
    assetId,
    status: 'VERIFIED',
    observedAt: context.issuedAt,
    validUntil: context.expiresAt,
  },
};
const proof = {
  signature: bs58.encode(
    nacl.sign.detached(
      new TextEncoder().encode(createProjectControlMessage(context)),
      key.secretKey,
    ),
  ),
};
const alternate: ProjectControlSignatureVerifier = {
  version: 'v1',
  algorithm: 'ED25519',
  verify(input) {
    const publicKey = createPublicKey({
      key: {
        kty: 'OKP',
        crv: 'Ed25519',
        x: Buffer.from(bs58.decode(input.signer)).toString('base64url'),
      },
      format: 'jwk',
    });
    return verify(
      null,
      Buffer.from(input.message, 'utf8'),
      publicKey,
      bs58.decode(input.signature),
    );
  },
};
for (const adapter of [ed25519ProjectControlVerifier, alternate]) {
  const result = evaluateProjectControlProof(context, facts, proof, adapter);
  assert.equal(result.state, 'SIGNATURE_BOUND');
  assert.equal(result.isAuthorizationToken, false);
  assert.equal(result.founderControlVerified, false);
  assert.equal(result.recognizesGuild, false);
  assert.equal(result.activatesToken, false);
  assert.equal(result.createsPermissionGrant, false);
  assert.equal(result.persisted, false);
  assert.equal(result.consumesNonce, false);
  assert.equal(
    evaluateProjectControlProof(context, facts, proof, adapter).state,
    'SIGNATURE_BOUND',
  );
  for (const patch of [
    { challengeState: 'CONSUMED' },
    { now: context.expiresAt },
    { actor: { ...facts.actor, accountId: 'foreign-owner' } },
    { authority: { ...facts.authority, status: 'REVOKED' } },
    { policy: { ...facts.policy, status: 'UNAPPROVED' } },
    { publicEvidence: { ...facts.publicEvidence, status: 'UNKNOWN' } },
    {
      authority: { ...facts.authority, assetId: { ...assetId, networkIdentity: 'wrong-genesis' } },
    },
  ])
    assert.equal(
      evaluateProjectControlProof(context, { ...facts, ...patch }, proof, adapter).state,
      'REJECTED',
    );
  const substituted = { ...context, nonce: 'b'.repeat(64) };
  assert.equal(
    evaluateProjectControlProof(substituted, facts, proof, adapter).reason,
    'SIGNATURE_INVALID',
  );
  assert.throws(
    () => evaluateProjectControlProof(context, facts, { ...proof, role: 'ADMIN' }, adapter),
    /INVALID_INPUT/,
  );
}
assert.deepEqual(
  evaluateProjectControlProof(context, facts, proof, alternate),
  evaluateProjectControlProof(context, facts, proof, ed25519ProjectControlVerifier),
);
const proposal = {
  version: 'v1',
  id: '22222222-2222-4222-8222-222222222222',
  guildDraftId: context.guildDraftId,
  revision: 2,
  draftRevision: context.draftRevision,
  recordedAt: '2026-10-13T08:59:00Z',
  projectType: 'EXISTING_PROJECT',
  state: 'PENDING_VERIFICATION',
  persisted: true,
  candidateToken: assetId,
  publicEvidenceRefs: ['https://public.example/project'],
  founderControlVerified: false,
  recognizesGuild: false,
  activatesToken: false,
  createsPermissionGrant: false,
  publicProfileApproved: false,
};
const proposalContext = {
  version: 'v2',
  purpose: 'EXISTING_PROJECT_PROPOSAL_CONTROL',
  control: context,
  proposal,
};
const proposalFacts = { version: 'v2', control: facts, proposal };
const proposalProof = {
  signature: bs58.encode(
    nacl.sign.detached(
      new TextEncoder().encode(createProjectProposalControlMessage(proposalContext)),
      key.secretKey,
    ),
  ),
};
for (const adapter of [ed25519ProjectControlVerifier, alternate]) {
  const bound = evaluateProjectProposalControlProof(
    proposalContext,
    proposalFacts,
    proposalProof,
    adapter,
  );
  assert.equal(bound.reason, 'SIGNATURE_BOUND');
  assert.equal(bound.proposalRevision, 2);
  assert.equal(bound.consumesNonce, false);
  assert.equal(bound.founderControlVerified, false);
  assert.equal(
    evaluateProjectProposalControlProof(
      proposalContext,
      { ...proposalFacts, proposal: { ...proposal, revision: 3 } },
      proposalProof,
      adapter,
    ).reason,
    'PROPOSAL_CHANGED',
  );
  assert.equal(
    evaluateProjectProposalControlProof(
      proposalContext,
      { ...proposalFacts, proposal: null },
      proposalProof,
      adapter,
    ).reason,
    'PROPOSAL_CHANGED',
  );
  assert.equal(
    evaluateProjectProposalControlProof(proposalContext, proposalFacts, proof, adapter).reason,
    'SIGNATURE_INVALID',
  );
  assert.equal(
    evaluateProjectControlProof(context, facts, proposalProof, adapter).reason,
    'SIGNATURE_INVALID',
  );
}
console.log(
  JSON.stringify({
    synthetic: true,
    realEd25519Signature: true,
    alternateNodeVerifier: true,
    exactAssetAndRequest: true,
    expiryRevocationPolicyEvidenceAndTenantDenied: true,
    noAuthorityOrPersistence: true,
    noAtomicReplayClaim: true,
    proposalV2CurrentSnapshotBound: true,
    unchangedV1AndCrossVersionReplayDenied: true,
  }),
);
