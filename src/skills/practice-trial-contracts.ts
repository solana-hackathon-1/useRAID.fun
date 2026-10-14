import { z } from 'zod';
import { AccountId, InternalId, ParticipantId, UtcTimestamp } from '../contracts/ids';
import { ParticipantSchema, SkillRankSchema } from '../contracts/entities';
import { PublishedSkillTaxonomySchema, SkillVersionReferenceSchema } from './contracts';

const Timestamp = UtcTimestamp.refine((value) => {
  const fraction = value.match(/\.(\d+)Z$/)?.[1];
  return !fraction || fraction.length <= 3;
});
const Text = z.string().trim().min(1).max(4000);
const Count = z.number().int().min(1).max(10000);
const Minutes = z.number().int().min(1).max(10080);
const Cooldown = z.number().int().min(0).max(2147483647);
export const PracticeTrialDefinitionSchema = z
  .strictObject({
    version: z.literal('v1'),
    reference: SkillVersionReferenceSchema,
    state: z.literal('PUBLISHED'),
    publishedAt: Timestamp,
    purpose: z.literal('UNPAID_PLATFORM_PRACTICE'),
    skillId: InternalId,
    skillDomain: InternalId,
    targetRank: SkillRankSchema,
    title: z.string().trim().min(1).max(200),
    brief: Text,
    variantId: InternalId,
    inputs: z
      .array(
        z
          .strictObject({
            label: z.string().trim().min(1).max(200),
            material: z.enum(['PUBLIC', 'SYNTHETIC']),
            content: Text,
          })
          .readonly(),
      )
      .min(1)
      .max(50)
      .readonly(),
    tools: z
      .strictObject({
        permitted: z
          .array(z.string().trim().min(1).max(200))
          .max(50)
          .refine((items) => new Set(items).size === items.length)
          .readonly(),
        aiAssistance: z.enum(['ALLOWED', 'PROHIBITED']),
        disclosure: Text,
      })
      .readonly(),
    expectedMinutes: Minutes,
    rubric: z
      .strictObject({
        reference: SkillVersionReferenceSchema,
        criteria: z
          .array(
            z
              .strictObject({
                id: InternalId,
                description: Text,
                required: z.boolean(),
              })
              .readonly(),
          )
          .min(1)
          .max(50)
          .refine((items) => new Set(items.map((item) => item.id)).size === items.length)
          .readonly(),
      })
      .readonly(),
    evaluatorMethod: z.enum(['MANUAL', 'AUTOMATED_WITH_MANUAL_REVIEW']),
    passConditions: Text,
    maximumAttempts: Count,
    cooldownSeconds: Cooldown,
    accommodationPolicy: Text,
  })
  .readonly();

export const PracticeTrialAccommodationSchema = z
  .strictObject({
    version: z.literal('v1'),
    reference: SkillVersionReferenceSchema,
    participantId: ParticipantId,
    definitionReference: SkillVersionReferenceSchema,
    observedAt: Timestamp,
    validUntil: Timestamp,
    maximumAttempts: Count,
    expectedMinutes: Minutes,
    cooldownSeconds: Cooldown,
  })
  .readonly();
export const PracticeTrialDiscoveryContextSchema = z.strictObject({
  version: z.literal('v1'),
  now: Timestamp,
  taxonomy: PublishedSkillTaxonomySchema,
  definition: PracticeTrialDefinitionSchema,
});
export const PracticeTrialAttemptContextSchema = PracticeTrialDiscoveryContextSchema.extend({
  actorAccountId: AccountId.nullable(),
  actorSessionAuthorized: z.boolean(),
  actorRestricted: z.boolean(),
  participant: ParticipantSchema,
  attemptHistory: z.discriminatedUnion('status', [
    z.strictObject({
      status: z.literal('CURRENT'),
      participantId: ParticipantId,
      trialId: InternalId,
      observedAt: Timestamp,
      validUntil: Timestamp,
      attemptsUsed: z.number().int().min(0).max(10000),
      lastAttemptAt: Timestamp.nullable(),
    }),
    z.strictObject({ status: z.literal('STALE') }),
    z.strictObject({ status: z.literal('UNAVAILABLE') }),
  ]),
  accommodation: PracticeTrialAccommodationSchema.nullable(),
});
export const PracticeTrialAttemptInputSchema = z.strictObject({
  version: z.literal('v1'),
  definitionReference: SkillVersionReferenceSchema,
  accommodationReference: SkillVersionReferenceSchema.nullable(),
});
export type PracticeTrialDefinition = z.output<typeof PracticeTrialDefinitionSchema>;
export type PracticeTrialAccommodation = z.output<typeof PracticeTrialAccommodationSchema>;
/** Trusted local ports must compare full immutable payloads against actual approved records. */
export interface PracticeTrialPolicy {
  isApprovedDefinition(definition: PracticeTrialDefinition, now: string): boolean;
  isApprovedAccommodation(accommodation: PracticeTrialAccommodation, now: string): boolean;
}
export const PracticeTrialPolicySchema = z.custom<PracticeTrialPolicy>(
  (value) =>
    typeof value === 'object' &&
    value !== null &&
    'isApprovedDefinition' in value &&
    typeof value.isApprovedDefinition === 'function' &&
    'isApprovedAccommodation' in value &&
    typeof value.isApprovedAccommodation === 'function',
);
export class PracticeTrialContractError extends Error {
  constructor(
    readonly code:
      | 'INVALID_INPUT'
      | 'INVALID_HOST_CONTRACT'
      | 'HOST_POLICY_UNAVAILABLE'
      | 'AUTHENTICATION_REQUIRED'
      | 'ACCOUNT_RESTRICTED'
      | 'FORBIDDEN'
      | 'RESOURCE_UNAVAILABLE'
      | 'DEFINITION_UNAVAILABLE'
      | 'SKILL_UNAVAILABLE'
      | 'REVISION_CHANGED'
      | 'ATTEMPT_HISTORY_UNAVAILABLE'
      | 'ATTEMPT_LIMIT_REACHED'
      | 'COOLDOWN_ACTIVE'
      | 'ACCOMMODATION_UNAVAILABLE',
  ) {
    super(code);
    this.name = 'PracticeTrialContractError';
  }
}
