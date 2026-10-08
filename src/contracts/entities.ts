import { z } from 'zod';
import {
  AccountId,
  ParticipantId,
  OperatorId,
  GuildId,
  TermsVersionId,
  EngagementId,
  InternalId,
  Revision,
  UtcTimestamp,
} from './ids';
import { AmountSchema, TokenAssetIdSchema, AssetPolicySnapshotSchema } from './assets';
import { StateSchema } from './states';
export const ParticipantSchema = z.discriminatedUnion('kind', [
  z.strictObject({ id: ParticipantId, kind: z.literal('HUMAN'), accountId: AccountId }),
  z.strictObject({ id: ParticipantId, kind: z.literal('AI_AGENT'), operatorId: OperatorId }),
  z.strictObject({ id: ParticipantId, kind: z.literal('AI_INFLUENCER'), operatorId: OperatorId }),
]);
export type Participant = z.infer<typeof ParticipantSchema>;
// Minimal public allowlist; does not attest founder or token control.
export const PublicGuildSchema = z.strictObject({
  id: GuildId,
  slug: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  name: z.string().min(1).max(200),
  description: z.string().max(4000),
  primaryToken: TokenAssetIdSchema.nullable(),
});
export type PublicGuild = z.infer<typeof PublicGuildSchema>;
/** Internal authority reference; verified roles/grants remain identity/Guild commands. */
export const GuildSchema = z.strictObject({
  id: GuildId,
  founderAccountId: AccountId,
  revision: Revision,
  primaryToken: TokenAssetIdSchema.nullable(),
});
export type Guild = z.infer<typeof GuildSchema>;
const member = z
  .strictObject({
    participantId: ParticipantId,
    responsibility: z.string().min(1),
    consentRef: InternalId,
  })
  .readonly();
const reward = z
  .strictObject({
    policy: AssetPolicySnapshotSchema,
    amount: AmountSchema,
    beneficiaryParticipantId: ParticipantId,
    beneficiaryRef: InternalId,
  })
  .readonly();
const deadlines = z
  .strictObject({
    preparation: UtcTimestamp,
    submission: UtcTimestamp,
    review: UtcTimestamp,
    operationalClosure: UtcTimestamp,
  })
  .readonly();
export const TermsSnapshotSchema = z
  .strictObject({
    id: TermsVersionId,
    guildId: GuildId,
    revision: Revision,
    scope: z.string().min(1),
    acceptanceCriteria: z.array(z.string().min(1)).min(1).readonly(),
    requiredSkills: z
      .array(
        z
          .strictObject({
            skillId: InternalId,
            minimumRank: z.enum(['E', 'D', 'C', 'B', 'A', 'S']),
            assessmentPolicyVersion: InternalId,
          })
          .readonly(),
      )
      .readonly(),
    roster: z.array(member).min(1).readonly(),
    rewards: z.array(reward).readonly(),
    deadlines,
    eligibilityPolicyVersion: InternalId,
    allowedToolsPolicyVersion: InternalId,
    revisionPolicyVersion: InternalId,
    withdrawalPolicyVersion: InternalId,
    terminationPolicyVersion: InternalId,
    rubricVersion: InternalId.nullable(),
    rightsPolicyVersion: InternalId,
    reviewPolicyVersion: InternalId,
    disputePolicyVersion: InternalId,
    finalityPolicyVersion: InternalId,
    createdAt: UtcTimestamp,
  })
  .superRefine((terms, ctx) => {
    const members = new Set(terms.roster.map((m) => m.participantId));
    if (members.size !== terms.roster.length)
      ctx.addIssue({ code: 'custom', path: ['roster'], message: 'Duplicate participant.' });
    for (const [i, leg] of terms.rewards.entries())
      if (!members.has(leg.beneficiaryParticipantId))
        ctx.addIssue({
          code: 'custom',
          path: ['rewards', i],
          message: 'Beneficiary must be in the accepted roster.',
        });
    const times = [
      terms.createdAt,
      terms.deadlines.preparation,
      terms.deadlines.submission,
      terms.deadlines.review,
      terms.deadlines.operationalClosure,
    ].map(Date.parse);
    if (times[1] <= times[0] || times.some((time, i) => i > 1 && time < times[i - 1]))
      ctx.addIssue({
        code: 'custom',
        path: ['deadlines'],
        message: 'Deadlines must be finite and ordered after creation.',
      });
  })
  .readonly();
export type TermsSnapshot = z.infer<typeof TermsSnapshotSchema>;
export const EngagementSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('RAID_SLOT'), raidSlotId: InternalId }).readonly(),
  z.strictObject({ kind: z.literal('CHALLENGE_ENTRY'), challengeEntryId: InternalId }).readonly(),
  z.strictObject({ kind: z.literal('ROLE_PERIOD'), rolePeriodId: InternalId }).readonly(),
]);
export const EngagementSchema = z
  .strictObject({
    id: EngagementId,
    guildId: GuildId,
    revision: Revision,
    state: StateSchema.engagement,
    source: EngagementSourceSchema,
    acceptedTerms: TermsSnapshotSchema,
  })
  .refine((e) => e.guildId === e.acceptedTerms.guildId, {
    path: ['acceptedTerms', 'guildId'],
    message: 'Terms must belong to the engagement Guild.',
  });
export type Engagement = z.infer<typeof EngagementSchema>;
