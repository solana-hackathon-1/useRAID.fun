import { createPublicKey, verify } from 'node:crypto';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { expect, it, vi } from 'vitest';
import {
  createProjectControlMessage,
  evaluateProjectControlProof,
} from '../src/guild-profiles/control-attestation';
import { ed25519ProjectControlVerifier } from '../src/guild-profiles/ed25519-control-verifier';
const key = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
const otherKey = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(8));
const assetId = {
  chain: 'SOLANA',
  networkIdentity: 'synthetic-genesis',
  kind: 'TOKEN',
  mint: bs58.encode(new Uint8Array(32).fill(9)),
  tokenProgram: bs58.encode(new Uint8Array(32).fill(10)),
};
const reference = (recordId: string) => ({ recordId, revision: 1 });
const context = {
  version: 'v1',
  purpose: 'EXISTING_PROJECT_CONTROL',
  challengeId: 'synthetic-challenge',
  origin: 'https://raid.example',
  actorAccountId: 'owner-1',
  guildDraftId: '11111111-1111-4111-8111-111111111111',
  draftRevision: 2,
  assetId,
  signer: bs58.encode(key.publicKey),
  nonce: 'a'.repeat(64),
  issuedAt: '2026-10-13T09:00:00.000Z',
  expiresAt: '2026-10-13T09:05:00.000Z',
  policy: reference('policy-1'),
  authority: reference('authority-1'),
  publicEvidence: reference('evidence-1'),
};
const facts = {
  version: 'v1',
  now: '2026-10-13T09:02:00.000Z',
  origin: context.origin,
  actor: { accountId: context.actorAccountId, sessionAuthorized: true, restricted: false },
  draft: {
    id: context.guildDraftId,
    ownerAccountId: context.actorAccountId,
    revision: context.draftRevision,
  },
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
const signed = (c: unknown = context) => ({
  signature: bs58.encode(
    nacl.sign.detached(new TextEncoder().encode(createProjectControlMessage(c)), key.secretKey),
  ),
});
const evaluate = (
  f: unknown = facts,
  input: unknown = signed(),
  c: unknown = context,
  verifier: unknown = ed25519ProjectControlVerifier,
) => evaluateProjectControlProof(c, f, input, verifier);
const nodeVerifier = {
  version: 'v1',
  algorithm: 'ED25519',
  verify(input: { message: string; signature: string; signer: string }) {
    const keyObject = createPublicKey({
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
      keyObject,
      bs58.decode(input.signature),
    );
  },
};
it('binds a real approved project-wallet signature and grants no authority or effect', () => {
  const result = evaluate();
  expect(result).toEqual({
    version: 'v1',
    challengeId: context.challengeId,
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
  expect(Object.isFrozen(result)).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(
    /owner-1|authority-1|evidence-1|synthetic-genesis|raid.example|signature|nonce|mint/,
  );
  expect(facts.challengeState).toBe('AVAILABLE');
  expect(evaluate()).toEqual(result); // Pure proof does not pretend to provide atomic replay prevention.
});
it('produces a canonical explicit existing-project message independent of object order and UTC formatting', () => {
  const text = createProjectControlMessage(context);
  expect(text.startsWith('RAID existing-project control attestation v1\n')).toBe(true);
  for (const value of [
    context.origin,
    context.actorAccountId,
    context.guildDraftId,
    context.nonce,
    assetId.mint,
    assetId.tokenProgram,
    assetId.networkIdentity,
    'EXISTING_PROJECT_CONTROL',
    'policy-1',
    'authority-1',
    'evidence-1',
  ])
    expect(text).toContain(value);
  const reverse = Object.fromEntries(Object.entries(context).reverse());
  expect(createProjectControlMessage(reverse)).toBe(text);
  expect(
    createProjectControlMessage({
      ...context,
      issuedAt: '2026-10-13T09:00:00Z',
      expiresAt: '2026-10-13T09:05:00Z',
    }),
  ).toBe(text);
});
it('substitutes the independently implemented Node verifier with the same outcomes', () => {
  expect(evaluate(facts, signed(), context, nodeVerifier)).toEqual(evaluate());
  const wrong = {
    signature: bs58.encode(
      nacl.sign.detached(
        new TextEncoder().encode(createProjectControlMessage(context)),
        otherKey.secretKey,
      ),
    ),
  };
  expect(evaluate(facts, wrong, context, nodeVerifier)).toEqual(evaluate(facts, wrong));
  expect(evaluate(facts, wrong)).toMatchObject({ state: 'REJECTED', reason: 'SIGNATURE_INVALID' });
});
it.each([
  ['actorAccountId', 'owner-2'],
  ['guildDraftId', '22222222-2222-4222-8222-222222222222'],
  ['draftRevision', 3],
  ['challengeId', 'another-challenge'],
  ['origin', 'https://other.example'],
  ['nonce', 'b'.repeat(64)],
  ['signer', bs58.encode(otherKey.publicKey)],
  ['issuedAt', '2026-10-13T09:00:01Z'],
  ['expiresAt', '2026-10-13T09:04:00Z'],
  ['policy', reference('policy-2')],
  ['authority', reference('authority-2')],
  ['publicEvidence', reference('evidence-2')],
])('cannot transplant a signature to changed %s', (field, value) => {
  const changed = { ...context, [field]: value };
  expect(
    ed25519ProjectControlVerifier.verify({
      message: createProjectControlMessage(changed),
      signature: signed().signature,
      signer: context.signer,
    }),
  ).toBe(false);
});
it.each(['networkIdentity', 'mint', 'tokenProgram'])(
  'binds the exact asset %s, not ticker or registry metadata',
  (field) => {
    const value =
      field === 'networkIdentity' ? 'different-genesis' : bs58.encode(new Uint8Array(32).fill(12));
    const changed = { ...context, assetId: { ...assetId, [field]: value } };
    expect(
      ed25519ProjectControlVerifier.verify({
        message: createProjectControlMessage(changed),
        signature: signed().signature,
        signer: context.signer,
      }),
    ).toBe(false);
    expect(
      evaluate({ ...facts, authority: { ...facts.authority, assetId: changed.assetId } }),
    ).toMatchObject({ state: 'REJECTED', reason: 'AUTHORITY_UNAVAILABLE' });
    expect(
      evaluate({ ...facts, publicEvidence: { ...facts.publicEvidence, assetId: changed.assetId } }),
    ).toMatchObject({ state: 'REJECTED', reason: 'PUBLIC_EVIDENCE_UNAVAILABLE' });
  },
);
it.each([
  ['anonymous', { actor: { ...facts.actor, accountId: null } }, 'AUTHENTICATION_REQUIRED'],
  [
    'session revoked',
    { actor: { ...facts.actor, sessionAuthorized: false } },
    'AUTHENTICATION_REQUIRED',
  ],
  ['restricted', { actor: { ...facts.actor, restricted: true } }, 'ACCOUNT_RESTRICTED'],
  ['wrong actor', { actor: { ...facts.actor, accountId: 'other-owner' } }, 'RESOURCE_UNAVAILABLE'],
  [
    'wrong draft',
    { draft: { ...facts.draft, id: '22222222-2222-4222-8222-222222222222' } },
    'RESOURCE_UNAVAILABLE',
  ],
  [
    'wrong owner',
    { draft: { ...facts.draft, ownerAccountId: 'other-owner' } },
    'RESOURCE_UNAVAILABLE',
  ],
  ['changed draft', { draft: { ...facts.draft, revision: 3 } }, 'REVISION_CHANGED'],
  ['wrong origin', { origin: 'https://other.example' }, 'ORIGIN_MISMATCH'],
  ['consumed nonce', { challengeState: 'CONSUMED' }, 'CHALLENGE_UNAVAILABLE'],
  ['revoked nonce', { challengeState: 'REVOKED' }, 'CHALLENGE_UNAVAILABLE'],
  ['exact expiry', { now: context.expiresAt }, 'CHALLENGE_EXPIRED'],
  ['future proof', { now: '2026-10-13T08:59:59.999Z' }, 'CHALLENGE_NOT_YET_VALID'],
])('rejects %s before calling cryptography', (_label, patch, reason) => {
  const verifier = { version: 'v1', algorithm: 'ED25519', verify: vi.fn(() => true) };
  expect(evaluate({ ...facts, ...patch }, signed(), context, verifier)).toMatchObject({
    state: 'REJECTED',
    reason,
  });
  expect(verifier.verify).not.toHaveBeenCalled();
});
it.each(['UNAPPROVED', 'REVOKED'])(
  'requires an actually approved policy instead of %s',
  (status) => {
    expect(evaluate({ ...facts, policy: { ...facts.policy, status } })).toMatchObject({
      state: 'REJECTED',
      reason: 'POLICY_UNAVAILABLE',
    });
  },
);
it.each(['policy', 'authority', 'publicEvidence'])(
  'rejects changed %s approval evidence revision',
  (field) => {
    const value = facts[field as 'policy' | 'authority' | 'publicEvidence'];
    expect(
      evaluate({ ...facts, [field]: { ...value, reference: { ...value.reference, revision: 2 } } }),
    ).toMatchObject({ state: 'REJECTED' });
  },
);
it.each(['STALE', 'UNKNOWN', 'REVOKED', 'CONFLICT'])(
  'rejects %s project control despite a correct wallet signature',
  (status) => {
    expect(evaluate({ ...facts, authority: { ...facts.authority, status } })).toMatchObject({
      state: 'REJECTED',
      reason: 'AUTHORITY_UNAVAILABLE',
    });
  },
);
it.each(['UNVERIFIED', 'STALE', 'UNKNOWN', 'REVOKED'])(
  'requires supporting public evidence instead of %s',
  (status) => {
    expect(
      evaluate({ ...facts, publicEvidence: { ...facts.publicEvidence, status } }),
    ).toMatchObject({ state: 'REJECTED', reason: 'PUBLIC_EVIDENCE_UNAVAILABLE' });
  },
);
it.each(['authority', 'publicEvidence'])(
  'rejects expired/future observations for %s even with an optimistic status',
  (field) => {
    const value = facts[field as 'authority' | 'publicEvidence'];
    for (const patch of [{ validUntil: facts.now }, { observedAt: '2026-10-13T09:03:00Z' }])
      expect(evaluate({ ...facts, [field]: { ...value, ...patch } })).toMatchObject({
        state: 'REJECTED',
      });
  },
);
it('does not require a permanently revoked mint authority or treat a sign-in message as project control', () => {
  const oldSignin = 'Sign in to RAID\n' + context.origin + '\nNonce: ' + context.nonce;
  const input = {
    signature: bs58.encode(nacl.sign.detached(new TextEncoder().encode(oldSignin), key.secretKey)),
  };
  expect(evaluate(facts, input)).toMatchObject({ state: 'REJECTED', reason: 'SIGNATURE_INVALID' });
  expect(evaluate()).toMatchObject({ state: 'SIGNATURE_BOUND', founderControlVerified: false }); // approved project signer may differ from mint authority
});
it.each(['signer', 'message', 'assetId', 'founderControlVerified', 'role', 'holderEligible'])(
  'rejects client supplied %s rather than inheriting asserted authority',
  (field) => {
    expect(() => evaluate(facts, { ...signed(), [field]: 'forged' })).toThrow('INVALID_INPUT');
  },
);
it.each(['', 'not-base58', '1'.repeat(63), bs58.encode(new Uint8Array(65))])(
  'rejects malformed signature bytes %s',
  (signature) => {
    expect(() => evaluate(facts, { signature })).toThrow('INVALID_INPUT');
  },
);
it.each([
  { purpose: 'WALLET_SIGN_IN' },
  { version: 'v2' },
  { nonce: 'weak' },
  { expiresAt: context.issuedAt },
  { issuedAt: '2026-10-13T09:00:00.0001Z' },
  { origin: 'https://raid.example/' },
  { origin: 'https://user:password@raid.example' },
  { assetId: { ...assetId, symbol: 'RAID' } },
  { mintAuthority: context.signer },
])('rejects malformed/unapproved context shape %j', (patch) => {
  expect(() => createProjectControlMessage({ ...context, ...patch })).toThrow(
    'INVALID_HOST_CONTRACT',
  );
});
it('sanitizes verifier exceptions and rejects unknown or success-shaped adapter responses', () => {
  const input = signed();
  for (const bad of [
    { version: 'v2', algorithm: 'ED25519', verify: () => true },
    { version: 'v1', algorithm: 'ECDSA', verify: () => true },
    { version: 'v1', algorithm: 'ED25519', verify: null },
  ])
    expect(() => evaluate(facts, input, context, bad)).toThrow('INVALID_HOST_CONTRACT');
  for (const output of ['true', { verified: true }, undefined, Promise.resolve(true)])
    expect(() =>
      evaluate(facts, input, context, {
        version: 'v1',
        algorithm: 'ED25519',
        verify: () => output,
      }),
    ).toThrow('INVALID_HOST_CONTRACT');
  expect(() =>
    evaluate(facts, input, context, {
      version: 'v1',
      algorithm: 'ED25519',
      verify: () => {
        throw Error('private-secret-provider-error');
      },
    }),
  ).toThrow('VERIFIER_UNAVAILABLE');
});
it('rejects global roles and private extras in trusted facts instead of using them as approval', () => {
  for (const patch of [
    { role: 'ADMIN' },
    { holderEligible: true },
    { privateNotes: 'private-secret' },
    { authority: { ...facts.authority, providerCredentials: 'private-secret' } },
  ])
    expect(() => evaluate({ ...facts, ...patch })).toThrow('INVALID_HOST_CONTRACT');
});

it('rejects a structurally valid 64-byte all-zero signature cryptographically', () => {
  expect(evaluate(facts, { signature: '1'.repeat(64) })).toMatchObject({
    state: 'REJECTED',
    reason: 'SIGNATURE_INVALID',
  });
});

const scopedFacts = {
  ...facts,
  policy: {
    ...facts.policy,
    purpose: 'EXISTING_PROJECT_CONTROL',
    route: 'PROJECT_WALLET_SIGNATURE',
  },
  authority: { ...facts.authority, policyReference: context.policy },
  publicEvidence: {
    ...facts.publicEvidence,
    policyReference: context.policy,
    authorityReference: context.authority,
  },
};
it('accepts only purpose-scoped approval with authority and public evidence linked to that exact approval', () => {
  expect(evaluate(scopedFacts)).toMatchObject({ state: 'SIGNATURE_BOUND' });
});
it.each(['authority-policy', 'evidence-policy', 'evidence-authority'])(
  'rejects unrelated approved record binding %s',
  (target) => {
    const mismatched = { ...scopedFacts };
    if (target === 'authority-policy')
      mismatched.authority = {
        ...scopedFacts.authority,
        policyReference: reference('different-policy'),
      };
    if (target === 'evidence-policy')
      mismatched.publicEvidence = {
        ...scopedFacts.publicEvidence,
        policyReference: reference('different-policy'),
      };
    if (target === 'evidence-authority')
      mismatched.publicEvidence = {
        ...scopedFacts.publicEvidence,
        authorityReference: reference('different-authority'),
      };
    expect(evaluate(mismatched)).toMatchObject({
      state: 'REJECTED',
      reason:
        target === 'authority-policy' ? 'AUTHORITY_UNAVAILABLE' : 'PUBLIC_EVIDENCE_UNAVAILABLE',
    });
  },
);
