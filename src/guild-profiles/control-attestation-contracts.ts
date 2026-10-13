import { z } from 'zod';
import bs58 from 'bs58';
import { TokenAssetIdSchema, SolanaAddress } from '../contracts/assets';
import { AccountId, InternalId, Revision, UtcTimestamp } from '../contracts/ids';

const Timestamp = UtcTimestamp.refine((value) => {
  const fraction = value.match(/\.(\d+)Z$/)?.[1];
  return !fraction || fraction.length <= 3;
});
const DraftId = z.uuid().transform((value) => value.toLowerCase());
const Origin = z
  .string()
  .max(2000)
  .refine((value) => {
    try {
      const url = new URL(value);
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      return (
        url.origin === value &&
        !url.username &&
        !url.password &&
        (url.protocol === 'https:' || (local && url.protocol === 'http:'))
      );
    } catch {
      return false;
    }
  });
export const ProjectControlReferenceSchema = z
  .strictObject({ recordId: InternalId, revision: Revision })
  .readonly();
/** Server-owned context. Approval/reference IDs are never accepted from HTTP callers. */
export const ProjectControlContextSchema = z
  .strictObject({
    version: z.literal('v1'),
    purpose: z.literal('EXISTING_PROJECT_CONTROL'),
    challengeId: InternalId,
    origin: Origin,
    actorAccountId: AccountId,
    guildDraftId: DraftId,
    draftRevision: Revision,
    assetId: TokenAssetIdSchema,
    signer: SolanaAddress,
    nonce: z.string().regex(/^[a-f0-9]{64}$/),
    issuedAt: Timestamp,
    expiresAt: Timestamp,
    policy: ProjectControlReferenceSchema,
    authority: ProjectControlReferenceSchema,
    publicEvidence: ProjectControlReferenceSchema,
  })
  .refine((c) => Date.parse(c.expiresAt) > Date.parse(c.issuedAt))
  .readonly();
const observation = { observedAt: Timestamp, validUntil: Timestamp };
/** Snapshot from authenticated storage/approved policy and authoritative observations, not client facts. */
export const ProjectControlFactsSchema = z.strictObject({
  version: z.literal('v1'),
  now: Timestamp,
  origin: Origin,
  actor: z.strictObject({
    accountId: AccountId.nullable(),
    sessionAuthorized: z.boolean(),
    restricted: z.boolean(),
  }),
  draft: z.strictObject({ id: DraftId, ownerAccountId: AccountId, revision: Revision }),
  challengeState: z.enum(['AVAILABLE', 'CONSUMED', 'REVOKED']),
  policy: z.strictObject({
    reference: ProjectControlReferenceSchema,
    status: z.enum(['APPROVED', 'UNAPPROVED', 'REVOKED']),
    purpose: z.literal('EXISTING_PROJECT_CONTROL'),
    route: z.literal('PROJECT_WALLET_SIGNATURE'),
  }),
  authority: z
    .strictObject({
      reference: ProjectControlReferenceSchema,
      policyReference: ProjectControlReferenceSchema,
      assetId: TokenAssetIdSchema,
      signer: SolanaAddress,
      status: z.enum(['CURRENT', 'STALE', 'UNKNOWN', 'REVOKED', 'CONFLICT']),
      ...observation,
    })
    .refine((o) => Date.parse(o.validUntil) > Date.parse(o.observedAt)),
  publicEvidence: z
    .strictObject({
      reference: ProjectControlReferenceSchema,
      policyReference: ProjectControlReferenceSchema,
      authorityReference: ProjectControlReferenceSchema,
      assetId: TokenAssetIdSchema,
      status: z.enum(['VERIFIED', 'UNVERIFIED', 'STALE', 'UNKNOWN', 'REVOKED']),
      ...observation,
    })
    .refine((o) => Date.parse(o.validUntil) > Date.parse(o.observedAt)),
});
export const ProjectControlProofInputSchema = z.strictObject({
  signature: z
    .string()
    .min(1)
    .max(88)
    .refine((value) => {
      try {
        return bs58.decode(value).length === 64;
      } catch {
        return false;
      }
    }),
});
export type ProjectControlContext = z.infer<typeof ProjectControlContextSchema>;
export type ProjectControlFacts = z.infer<typeof ProjectControlFactsSchema>;
export type ProjectControlProofInput = z.infer<typeof ProjectControlProofInputSchema>;
export type ProjectControlVerificationInput = Readonly<{
  message: string;
  signature: string;
  signer: string;
}>;
/** Synchronous local verification only; no network, retries, secret keys or side effects. */
export interface ProjectControlSignatureVerifier {
  readonly version: 'v1';
  readonly algorithm: 'ED25519';
  verify(input: ProjectControlVerificationInput): boolean;
}
/** Shared structural port check; implementations must also return an actual synchronous boolean. */
export const ProjectControlSignatureVerifierSchema = z.strictObject({
  version: z.literal('v1'),
  algorithm: z.literal('ED25519'),
  verify: z.custom<(input: ProjectControlVerificationInput) => unknown>(
    (value) => typeof value === 'function',
  ),
});
export type ProjectControlReason =
  | 'SIGNATURE_BOUND'
  | 'AUTHENTICATION_REQUIRED'
  | 'ACCOUNT_RESTRICTED'
  | 'RESOURCE_UNAVAILABLE'
  | 'REVISION_CHANGED'
  | 'ORIGIN_MISMATCH'
  | 'CHALLENGE_UNAVAILABLE'
  | 'CHALLENGE_EXPIRED'
  | 'CHALLENGE_NOT_YET_VALID'
  | 'POLICY_UNAVAILABLE'
  | 'AUTHORITY_UNAVAILABLE'
  | 'PUBLIC_EVIDENCE_UNAVAILABLE'
  | 'SIGNATURE_INVALID';
export type ProjectControlProofResult = Readonly<{
  version: 'v1';
  challengeId: string;
  state: 'SIGNATURE_BOUND' | 'REJECTED';
  reason: ProjectControlReason;
  informational: true;
  isAuthorizationToken: false;
  persisted: false;
  founderControlVerified: false;
  recognizesGuild: false;
  activatesToken: false;
  createsPermissionGrant: false;
  consumesNonce: false;
}>;
export class ProjectControlContractError extends Error {
  constructor(readonly code: 'INVALID_INPUT' | 'INVALID_HOST_CONTRACT' | 'VERIFIER_UNAVAILABLE') {
    super(code);
    this.name = 'ProjectControlContractError';
  }
}
