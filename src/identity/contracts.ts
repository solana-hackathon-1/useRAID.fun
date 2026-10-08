import { z } from 'zod';
import {
  AccountId, EngagementId, InternalId, ParticipantId, ParticipantSchema,
  Revision, SolanaAddress, UtcTimestamp,
} from '../contracts';

export const IDENTITY_PREFLIGHT_VERSION = 'v1' as const;
export const IdentitySubjectSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('WALLET'), networkIdentity: InternalId, address: SolanaAddress,
  }).readonly(),
  z.strictObject({
    kind: z.literal('PROVIDER'), provider: InternalId, subject: z.string().min(1).max(500),
  }).readonly(),
]);
export type IdentitySubject = z.infer<typeof IdentitySubjectSchema>;

/** Server-resolved current snapshot; not a client assertion or a storage adapter. */
export const IdentitySnapshotSchema = z.strictObject({
  participant: ParticipantSchema.options[0].readonly(),
  revision: Revision,
  status: z.enum(['ACTIVE', 'RESTRICTED']),
  activeEngagementId: EngagementId.nullable(),
}).readonly();
export type IdentitySnapshot = z.infer<typeof IdentitySnapshotSchema>;
export const IdentityLinkPolicySchema = z.strictObject({
  domain: z.string().min(1).max(253),
  uri: z.url(),
  walletNetworks: z.array(InternalId).readonly(),
  providers: z.array(InternalId).readonly(),
}).readonly();
export type IdentityLinkPolicy = z.infer<typeof IdentityLinkPolicySchema>;
export const SubjectOwnershipSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('UNKNOWN') }),
  z.strictObject({ state: z.literal('UNCLAIMED') }),
  z.strictObject({ state: z.literal('LINKED'), accountId: AccountId }),
  z.strictObject({ state: z.literal('REVOKED'), accountId: AccountId }),
]);
/** Host verifier/stored challenge observation; never an HTTP proof DTO. */
export const LinkProofObservationSchema = z.strictObject({
  ref: InternalId,
  state: z.enum(['VERIFIED', 'UNVERIFIED', 'REVOKED']),
  accountId: AccountId,
  intent: z.enum(['LINK', 'SIGNIN', 'ROTATE']),
  subject: IdentitySubjectSchema,
  domain: z.string().min(1).max(253),
  uri: z.url(),
  issuedAt: UtcTimestamp,
  expiresAt: UtcTimestamp,
  consumed: z.boolean(),
}).readonly();
export const VerifiedLinkPreflightSchema = z.strictObject({
  actorAccountId: AccountId,
  expectedRevision: Revision,
  subject: IdentitySubjectSchema,
  snapshot: IdentitySnapshotSchema,
  session: z.strictObject({
    accountId: AccountId, state: z.enum(['ACTIVE', 'REVOKED']), expiresAt: UtcTimestamp,
  }).readonly(),
  ownership: SubjectOwnershipSchema,
  proof: LinkProofObservationSchema,
}).readonly();
export type VerifiedLinkPreflight = z.infer<typeof VerifiedLinkPreflightSchema>;

export const RetainedIdentityRightSchema = z.strictObject({
  kind: z.enum([
    'ACTIVE_COMMITMENT', 'TERMS', 'CONSENT', 'WORK_HISTORY', 'SKILL_EVIDENCE',
    'CLAIM', 'LEDGER', 'CASE', 'ROLE', 'AUDIT', 'RECEIPT', 'OUTBOX', 'MEDIA', 'OTHER',
  ]),
  id: InternalId,
}).readonly();
const inventory = z.strictObject({
  state: z.enum(['COMPLETE', 'UNKNOWN']),
  accountId: AccountId,
  participantId: ParticipantId,
  revision: Revision,
  references: z.array(RetainedIdentityRightSchema).readonly(),
}).readonly();
export const AccountRemovalPreflightSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('MERGE'), keep: IdentitySnapshotSchema, drop: IdentitySnapshotSchema, inventory,
  }),
  z.strictObject({ kind: z.literal('DELETE'), drop: IdentitySnapshotSchema, inventory }),
]);
export type AccountRemovalPreflight = z.infer<typeof AccountRemovalPreflightSchema>;
export type IdentityPreflightReason =
  | 'INVALID_COMMAND' | 'AUTHENTICATION_REQUIRED' | 'FORBIDDEN'
  | 'ACCOUNT_RESTRICTED' | 'REVISION_CHANGED' | 'UNSUPPORTED_IDENTITY'
  | 'PROOF_INVALID' | 'OWNERSHIP_UNKNOWN' | 'IDENTITY_CONFLICT' | 'IDENTITY_REVOKED'
  | 'CAPACITY_CONFLICT' | 'RIGHTS_RETAINED' | 'INVENTORY_UNKNOWN' | 'SCOPED_REVIEW_REQUIRED';
export type IdentityPreflightBlocked = Readonly<{
  stage: 'BLOCKED'; code: IdentityPreflightReason;
}>;
export type IdentityLinkProposal = Readonly<{
  stage: 'READY_FOR_TRANSACTION'; accountId: AccountId; participantId: ParticipantId;
  expectedRevision: number; subjectKey: string; proofRef: string;
  activeEngagementId: EngagementId | null;
}>;
