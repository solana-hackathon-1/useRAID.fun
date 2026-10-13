import { z } from 'zod';
import { assetKey } from '../contracts/assets';
import {
  ProjectControlContextSchema,
  ProjectControlFactsSchema,
  ProjectControlProofInputSchema,
  ProjectControlContractError,
  type ProjectControlContext,
  type ProjectControlProofResult,
  type ProjectControlReason,
  type ProjectControlVerificationInput,
} from './control-attestation-contracts';
export * from './control-attestation-contracts';

function parseHost<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ProjectControlContractError('INVALID_HOST_CONTRACT');
  return parsed.data;
}
const reference = (r: ProjectControlContext['policy']) => ({
  recordId: r.recordId,
  revision: r.revision,
});
const sameReference = (a: ProjectControlContext['policy'], b: ProjectControlContext['policy']) =>
  a.recordId === b.recordId && a.revision === b.revision;
function encode(context: ProjectControlContext): string {
  // Explicit field order; caller object insertion order cannot alter the signed bytes.
  return (
    'RAID existing-project control attestation v1\n' +
    JSON.stringify(
      {
        version: context.version,
        purpose: context.purpose,
        challengeId: context.challengeId,
        origin: context.origin,
        actorAccountId: context.actorAccountId,
        guildDraftId: context.guildDraftId,
        draftRevision: context.draftRevision,
        assetId: {
          chain: context.assetId.chain,
          networkIdentity: context.assetId.networkIdentity,
          kind: context.assetId.kind,
          mint: context.assetId.mint,
          tokenProgram: context.assetId.tokenProgram,
        },
        signer: context.signer,
        nonce: context.nonce,
        issuedAt: new Date(context.issuedAt).toISOString(),
        expiresAt: new Date(context.expiresAt).toISOString(),
        policy: reference(context.policy),
        authority: reference(context.authority),
        publicEvidence: reference(context.publicEvidence),
      },
      null,
      2,
    )
  );
}
export function createProjectControlMessage(context: unknown): string {
  return encode(parseHost(ProjectControlContextSchema, context));
}
const VerifierSchema = z.strictObject({
  version: z.literal('v1'),
  algorithm: z.literal('ED25519'),
  verify: z.custom<(input: ProjectControlVerificationInput) => unknown>(
    (v) => typeof v === 'function',
  ),
});
/** Informational only. Host must independently reauthorize/atomically consume proof before recognition. */
export function evaluateProjectControlProof(
  contextValue: unknown,
  factsValue: unknown,
  inputValue: unknown,
  verifierValue: unknown,
): ProjectControlProofResult {
  const context = parseHost(ProjectControlContextSchema, contextValue);
  const facts = parseHost(ProjectControlFactsSchema, factsValue);
  const parsedInput = ProjectControlProofInputSchema.safeParse(inputValue);
  if (!parsedInput.success) throw new ProjectControlContractError('INVALID_INPUT');
  const verifier = parseHost(VerifierSchema, verifierValue);
  const result = (reason: ProjectControlReason): ProjectControlProofResult =>
    Object.freeze({
      version: 'v1',
      challengeId: context.challengeId,
      state: reason === 'SIGNATURE_BOUND' ? 'SIGNATURE_BOUND' : 'REJECTED',
      reason,
      informational: true,
      isAuthorizationToken: false,
      persisted: false,
      founderControlVerified: false,
      recognizesGuild: false,
      activatesToken: false,
      createsPermissionGrant: false,
      consumesNonce: false,
    });
  if (!facts.actor.accountId || !facts.actor.sessionAuthorized)
    return result('AUTHENTICATION_REQUIRED');
  if (facts.actor.restricted) return result('ACCOUNT_RESTRICTED');
  if (
    facts.actor.accountId !== context.actorAccountId ||
    facts.draft.ownerAccountId !== context.actorAccountId ||
    facts.draft.id !== context.guildDraftId
  )
    return result('RESOURCE_UNAVAILABLE');
  if (facts.draft.revision !== context.draftRevision) return result('REVISION_CHANGED');
  if (facts.origin !== context.origin) return result('ORIGIN_MISMATCH');
  if (facts.challengeState !== 'AVAILABLE') return result('CHALLENGE_UNAVAILABLE');
  const now = Date.parse(facts.now);
  if (now < Date.parse(context.issuedAt)) return result('CHALLENGE_NOT_YET_VALID');
  if (now >= Date.parse(context.expiresAt)) return result('CHALLENGE_EXPIRED');
  if (facts.policy.status !== 'APPROVED' || !sameReference(context.policy, facts.policy.reference))
    return result('POLICY_UNAVAILABLE');
  const current = (o: { observedAt: string; validUntil: string }) =>
    now >= Date.parse(o.observedAt) && now < Date.parse(o.validUntil);
  if (
    facts.authority.status !== 'CURRENT' ||
    !sameReference(context.authority, facts.authority.reference) ||
    !sameReference(context.policy, facts.authority.policyReference) ||
    !current(facts.authority) ||
    facts.authority.signer !== context.signer ||
    assetKey(facts.authority.assetId) !== assetKey(context.assetId)
  )
    return result('AUTHORITY_UNAVAILABLE');
  if (
    facts.publicEvidence.status !== 'VERIFIED' ||
    !sameReference(context.publicEvidence, facts.publicEvidence.reference) ||
    !sameReference(context.policy, facts.publicEvidence.policyReference) ||
    !sameReference(context.authority, facts.publicEvidence.authorityReference) ||
    !current(facts.publicEvidence) ||
    assetKey(facts.publicEvidence.assetId) !== assetKey(context.assetId)
  )
    return result('PUBLIC_EVIDENCE_UNAVAILABLE');
  let verified: unknown;
  try {
    verified = verifier.verify(
      Object.freeze({
        message: encode(context),
        signature: parsedInput.data.signature,
        signer: context.signer,
      }),
    );
  } catch {
    throw new ProjectControlContractError('VERIFIER_UNAVAILABLE');
  }
  if (typeof verified !== 'boolean') throw new ProjectControlContractError('INVALID_HOST_CONTRACT');
  return result(verified ? 'SIGNATURE_BOUND' : 'SIGNATURE_INVALID');
}
