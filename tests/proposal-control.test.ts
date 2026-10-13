import { createPublicKey, verify } from 'node:crypto';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { expect, it, vi } from 'vitest';
import {
  createProjectControlMessage,
  evaluateProjectControlProof,
} from '../src/guild-profiles/control-attestation';
import { ed25519ProjectControlVerifier } from '../src/guild-profiles/ed25519-control-verifier';
import {
  createProjectProposalControlMessage,
  evaluateProjectProposalControlProof,
} from '../src/guild-profiles/proposal-control';
const key = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(27));
const assetId = {
  chain: 'SOLANA',
  kind: 'TOKEN',
  networkIdentity: 'synthetic-genesis',
  mint: bs58.encode(new Uint8Array(32).fill(28)),
  tokenProgram: bs58.encode(new Uint8Array(32).fill(29)),
};
const ref = (recordId: string) => ({ recordId, revision: 1 });
const control = {
  version: 'v1',
  purpose: 'EXISTING_PROJECT_CONTROL',
  challengeId: 'synthetic-proposal-challenge',
  origin: 'https://synthetic.example',
  actorAccountId: 'synthetic-owner',
  guildDraftId: '11111111-1111-4111-8111-111111111111',
  draftRevision: 2,
  assetId,
  signer: bs58.encode(key.publicKey),
  nonce: 'b'.repeat(64),
  issuedAt: '2026-10-13T09:00:00Z',
  expiresAt: '2026-10-13T09:05:00Z',
  policy: ref('policy'),
  authority: ref('authority'),
  publicEvidence: ref('evidence'),
};
const proposal = {
  version: 'v1',
  id: '22222222-2222-4222-8222-222222222222',
  guildDraftId: control.guildDraftId,
  revision: 3,
  draftRevision: 2,
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
const oldFacts = {
  version: 'v1',
  now: '2026-10-13T09:02:00Z',
  origin: control.origin,
  actor: { accountId: control.actorAccountId, sessionAuthorized: true, restricted: false },
  draft: { id: control.guildDraftId, ownerAccountId: control.actorAccountId, revision: 2 },
  challengeState: 'AVAILABLE',
  policy: {
    reference: control.policy,
    status: 'APPROVED',
    purpose: control.purpose,
    route: 'PROJECT_WALLET_SIGNATURE',
  },
  authority: {
    reference: control.authority,
    policyReference: control.policy,
    assetId,
    signer: control.signer,
    status: 'CURRENT',
    observedAt: control.issuedAt,
    validUntil: control.expiresAt,
  },
  publicEvidence: {
    reference: control.publicEvidence,
    policyReference: control.policy,
    authorityReference: control.authority,
    assetId,
    status: 'VERIFIED',
    observedAt: control.issuedAt,
    validUntil: control.expiresAt,
  },
};
const context = { version: 'v2', purpose: 'EXISTING_PROJECT_PROPOSAL_CONTROL', control, proposal };
const facts = { version: 'v2', control: oldFacts, proposal };
const sign = (message: string) => ({
  signature: bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), key.secretKey)),
});
const signed = (value: unknown = context) => sign(createProjectProposalControlMessage(value));
const evaluate = (
  f: unknown = facts,
  input: unknown = signed(),
  c: unknown = context,
  verifier: unknown = ed25519ProjectControlVerifier,
) => evaluateProjectProposalControlProof(c, f, input, verifier);
it('binds a real signature to a saved pending proposal and still grants no authority or durable effect', () => {
  expect(evaluate()).toEqual({
    version: 'v2',
    challengeId: control.challengeId,
    proposalId: proposal.id,
    proposalRevision: 3,
    state: 'SIGNATURE_BOUND',
    reason: 'SIGNATURE_BOUND',
    informational: true,
    isAuthorizationToken: false,
    persisted: false,
    founderControlVerified: false,
    recognizesGuild: false,
    activatesToken: false,
    createsPermissionGrant: false,
    consumesNonce: false,
  });
  expect(Object.isFrozen(evaluate())).toBe(true);
});
it('canonically signs the complete saved snapshot with a separate v2 purpose and deterministic object order', () => {
  const message = createProjectProposalControlMessage(context);
  expect(message).toMatch(/^RAID existing-project proposal control attestation v2\n/);
  expect(message).toContain(proposal.id);
  expect(message).toContain('https://public.example/project');
  expect(message).toContain('EXISTING_PROJECT_PROPOSAL_CONTROL');
  expect(message).toBe(
    createProjectProposalControlMessage({
      proposal: Object.fromEntries(Object.entries(proposal).reverse()),
      control: Object.fromEntries(Object.entries(control).reverse()),
      purpose: context.purpose,
      version: 'v2',
    }),
  );
});
it('rejects old v1 signatures for v2 and preserves the original v1 protocol', () => {
  const original = sign(createProjectControlMessage(control));
  expect(evaluate(facts, original).reason).toBe('SIGNATURE_INVALID');
  expect(
    evaluateProjectControlProof(control, oldFacts, original, ed25519ProjectControlVerifier).reason,
  ).toBe('SIGNATURE_BOUND');
  expect(
    evaluateProjectControlProof(control, oldFacts, signed(), ed25519ProjectControlVerifier).reason,
  ).toBe('SIGNATURE_INVALID');
});
it('accepts the same v2 bytes with an independently implemented Node crypto adapter', () => {
  const alternate = {
    version: 'v1',
    algorithm: 'ED25519',
    verify(input: { message: string; signer: string; signature: string }) {
      return verify(
        null,
        Buffer.from(input.message),
        createPublicKey({
          key: {
            kty: 'OKP',
            crv: 'Ed25519',
            x: Buffer.from(bs58.decode(input.signer)).toString('base64url'),
          },
          format: 'jwk',
        }),
        bs58.decode(input.signature),
      );
    },
  };
  expect(evaluate(facts, signed(), context, alternate).reason).toBe('SIGNATURE_BOUND');
});
for (const [name, patch] of [
  ['identity', { id: '33333333-3333-4333-8333-333333333333' }],
  ['proposal revision', { revision: 4 }],
  ['draft snapshot', { draftRevision: 3 }],
  ['recorded time', { recordedAt: '2026-10-13T08:58:00Z' }],
  ['references', { publicEvidenceRefs: ['https://public.example/new'] }],
  [
    'candidate asset',
    { candidateToken: { ...assetId, mint: bs58.encode(new Uint8Array(32).fill(30)) } },
  ],
] as const)
  it('rejects a changed current ' + name + ' before crypto', () => {
    const verify = vi.fn(() => true);
    expect(
      evaluate({ ...facts, proposal: { ...proposal, ...patch } }, signed(), context, {
        version: 'v1',
        algorithm: 'ED25519',
        verify,
      }).reason,
    ).toBe('PROPOSAL_CHANGED');
    expect(verify).not.toHaveBeenCalled();
  });
it('rejects an absent current proposal before crypto', () => {
  const verify = vi.fn(() => true);
  expect(
    evaluate({ ...facts, proposal: null }, signed(), context, {
      version: 'v1',
      algorithm: 'ED25519',
      verify,
    }).reason,
  ).toBe('PROPOSAL_CHANGED');
  expect(verify).not.toHaveBeenCalled();
});
for (const [name, patch, reason] of [
  [
    'session',
    { actor: { ...oldFacts.actor, sessionAuthorized: false } },
    'AUTHENTICATION_REQUIRED',
  ],
  ['restriction', { actor: { ...oldFacts.actor, restricted: true } }, 'ACCOUNT_RESTRICTED'],
  ['owner', { draft: { ...oldFacts.draft, ownerAccountId: 'other' } }, 'RESOURCE_UNAVAILABLE'],
  ['draft revision', { draft: { ...oldFacts.draft, revision: 3 } }, 'REVISION_CHANGED'],
  ['origin', { origin: 'https://foreign.example' }, 'ORIGIN_MISMATCH'],
  ['challenge', { challengeState: 'CONSUMED' }, 'CHALLENGE_UNAVAILABLE'],
  ['expiry', { now: control.expiresAt }, 'CHALLENGE_EXPIRED'],
  ['policy', { policy: { ...oldFacts.policy, status: 'REVOKED' } }, 'POLICY_UNAVAILABLE'],
  [
    'authority',
    { authority: { ...oldFacts.authority, status: 'UNKNOWN' } },
    'AUTHORITY_UNAVAILABLE',
  ],
  [
    'evidence',
    { publicEvidence: { ...oldFacts.publicEvidence, status: 'UNVERIFIED' } },
    'PUBLIC_EVIDENCE_UNAVAILABLE',
  ],
] as const)
  it('retains the v1 current ' + name + ' denial before signature verification', () => {
    const verify = vi.fn(() => true);
    expect(
      evaluate({ ...facts, control: { ...oldFacts, ...patch } }, signed(), context, {
        version: 'v1',
        algorithm: 'ED25519',
        verify,
      }).reason,
    ).toBe(reason);
    expect(verify).not.toHaveBeenCalled();
  });
for (const patch of [
  { purpose: 'EXISTING_PROJECT_CONTROL' },
  { proposal: { ...proposal, guildDraftId: '33333333-3333-4333-8333-333333333333' } },
  { proposal: { ...proposal, draftRevision: 3 } },
  {
    proposal: {
      ...proposal,
      candidateToken: { ...assetId, tokenProgram: bs58.encode(new Uint8Array(32).fill(30)) },
    },
  },
  { proposal: { ...proposal, founderControlVerified: true } },
])
  it('rejects malformed or incoherent host context without creating a signable message', () => {
    expect(() => createProjectProposalControlMessage({ ...context, ...patch })).toThrow(
      'INVALID_HOST_CONTRACT',
    );
  });
it('rejects a replaced signed reference snapshot even if it is now the current record', () => {
  const edited = { ...proposal, publicEvidenceRefs: ['https://public.example/replaced'] };
  expect(
    evaluate({ ...facts, proposal: edited }, signed(), { ...context, proposal: edited }).reason,
  ).toBe('SIGNATURE_INVALID');
});
it('does not consume the nonce; repeated AVAILABLE evaluations remain informational', () => {
  expect(evaluate().reason).toBe('SIGNATURE_BOUND');
  expect(evaluate().reason).toBe('SIGNATURE_BOUND');
});
it('keeps caller input signature-only and rejects fabricated authority fields', () => {
  expect(() => evaluate(facts, { ...signed(), proposal, approved: true })).toThrow('INVALID_INPUT');
});
for (const verifier of [
  { version: 'v2', algorithm: 'ED25519', verify: () => true },
  { version: 'v1', algorithm: 'RSA', verify: () => true },
  { version: 'v1', algorithm: 'ED25519', verify: () => Promise.resolve(true) },
  { version: 'v1', algorithm: 'ED25519', verify: () => 'true' },
])
  it('rejects unsupported or nonboolean verifier contracts', () => {
    expect(() => evaluate(facts, signed(), context, verifier)).toThrow('INVALID_HOST_CONTRACT');
  });
it('sanitizes alternate verifier exceptions', () => {
  const verifier = {
    version: 'v1',
    algorithm: 'ED25519',
    verify() {
      throw Error('private provider data');
    },
  };
  expect(() => evaluate(facts, signed(), context, verifier)).toThrow('VERIFIER_UNAVAILABLE');
  expect(() => evaluate(facts, signed(), context, verifier)).not.toThrow('private provider data');
});
it('rejects sub-millisecond snapshot precision before constructing signed bytes', () => {
  expect(() =>
    createProjectProposalControlMessage({
      ...context,
      proposal: { ...proposal, recordedAt: '2026-10-13T08:59:00.000001Z' },
    }),
  ).toThrow('INVALID_HOST_CONTRACT');
});
it('rejects a current timestamp whose precision would otherwise be lost during normalization', () => {
  expect(() =>
    evaluate({ ...facts, proposal: { ...proposal, recordedAt: '2026-10-13T08:59:00.000001Z' } }),
  ).toThrow('INVALID_HOST_CONTRACT');
});
it('normalizes equivalent UUID case and timestamp spellings without changing signed bytes or result identity', () => {
  const canonical = {
    ...context,
    proposal: { ...proposal, id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
  };
  const mixed = {
    ...canonical,
    proposal: {
      ...canonical.proposal,
      id: canonical.proposal.id.toUpperCase(),
      recordedAt: '2026-10-13T08:59:00.000Z',
    },
  };
  expect(createProjectProposalControlMessage(mixed)).toBe(
    createProjectProposalControlMessage(canonical),
  );
  expect(
    evaluate({ ...facts, proposal: canonical.proposal }, signed(canonical), mixed).proposalId,
  ).toBe(canonical.proposal.id);
});
