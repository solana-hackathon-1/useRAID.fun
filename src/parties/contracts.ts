import { z } from 'zod';
import { UtcTimestamp } from '../contracts/ids';

/**
 * A Party coordinates complementary members for one defined result (blueprint §14). The leader proposes an immutable
 * roster/split snapshot; every HUMAN member consents under their own session to its exact digest. A Party label never
 * supplies a member's skill, consent or payout.
 */
export interface PartyHost {
  /** Default off. Original receipts and current authorized reads remain available when off. */
  allowNewWrites: boolean;
}
/**
 * Id inputs are canonicalized to lowercase like guild contracts: they are hashed into the roster digest and compared
 * with the database's `id::text`, so a non-canonical spelling must not change the digest or fail at the guard.
 */
const uuid = z.uuid().transform((value) => value.toLowerCase());
const digest = z.string().regex(/^[0-9a-f]{64}$/);
/** Integer base units, bounded like the database check (78 digits, no sign, no leading zero). */
const units = z.string().regex(/^(0|[1-9][0-9]{0,77})$/);
const trimmed = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim() === value && !/[\u0000\ud800-\udfff]/.test(value), {
      message: 'Text must be trimmed and storable.',
    });
export const CreatePartyInput = z.strictObject({ name: trimmed(200) });
export const MemberProposalSchema = z.strictObject({
  participantId: uuid,
  role: trimmed(100),
  /** One exact allocation per reward leg of the terms, in leg order. */
  allocations: z
    .array(z.strictObject({ amount: units }))
    .min(1)
    .max(10),
});
export const ProposePartyRosterInput = z.strictObject({
  partyId: uuid,
  slotId: uuid,
  termsVersionId: uuid,
  termsDigest: digest,
  members: z.array(MemberProposalSchema).min(1).max(20),
});
export const RecordPartyConsentInput = z.strictObject({
  proposalId: uuid,
  snapshotDigest: digest,
});
export const PartySchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  leaderParticipantId: z.uuid(),
  createdAt: UtcTimestamp,
});
export const PartyProposalSchema = z.strictObject({
  id: z.uuid(),
  partyId: z.uuid(),
  leaderParticipantId: z.uuid(),
  slotId: z.uuid(),
  termsVersionId: z.uuid(),
  termsDigest: digest,
  snapshotDigest: digest,
  members: z
    .array(
      MemberProposalSchema.extend({
        consentedAt: UtcTimestamp.nullable(),
      }),
    )
    .min(1)
    .max(20),
  /** True only when every named member has consented to this exact digest. Not an acceptance. */
  allConsented: z.boolean(),
  createdAt: UtcTimestamp,
});
export const PartyConsentSchema = z.strictObject({
  id: z.uuid(),
  proposalId: z.uuid(),
  participantId: z.uuid(),
  snapshotDigest: digest,
  consentedAt: UtcTimestamp,
});
const status = z.enum(['EXECUTED', 'REPLAYED']);
export const CreatePartyResultSchema = z.strictObject({ status, party: PartySchema });
export const ProposePartyRosterResultSchema = z.strictObject({
  status,
  proposal: PartyProposalSchema,
});
export const RecordPartyConsentResultSchema = z.strictObject({
  status,
  consent: PartyConsentSchema,
});
export type CreatePartyResult = z.infer<typeof CreatePartyResultSchema>;
export type ProposePartyRosterResult = z.infer<typeof ProposePartyRosterResultSchema>;
export type RecordPartyConsentResult = z.infer<typeof RecordPartyConsentResultSchema>;
export type PartyProposal = z.infer<typeof PartyProposalSchema>;
