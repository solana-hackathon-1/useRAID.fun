import { z } from 'zod';
import { InternalId } from '../contracts/ids';
import { SkillRankSchema } from '../contracts/entities';
import { AmountSchema, AssetPolicySnapshotSchema } from '../contracts/assets';
import { fromJsonAmount } from '../asset-registry/amounts';

export const RANKS = ['E', 'D', 'C', 'B', 'A', 'S'] as const;
const text = z.string().trim().min(1).max(8000);
const level = z.enum(['LOW', 'MEDIUM', 'HIGH']);
const kind = z.enum(['HUMAN', 'AI_AGENT', 'AI_INFLUENCER']);
const kinds = z.array(kind).min(1).max(3);
const positive = AmountSchema.refine((value) => {
  try {
    return fromJsonAmount(value) > 0n;
  } catch {
    return false;
  }
}, 'A positive bounded base-unit amount is required.');
const byRank = <T extends z.ZodType>(schema: T) =>
  z.strictObject({ E: schema, D: schema, C: schema, B: schema, A: schema, S: schema });
const weight = z.number().int().min(0).max(20);

/** What the founder has said about the work. Every signal is a bounded, explicit input. */
export const RecommendationInputSchema = z
  .strictObject({
    outcome: text,
    acceptanceCriteria: z.array(text).min(1).max(50),
    skillDomains: z
      .array(z.strictObject({ skillId: InternalId, role: z.enum(['PRIMARY', 'SUPPORTING']) }))
      .min(1)
      .max(10),
    integrations: z.number().int().min(0).max(50),
    dependencies: z.number().int().min(0).max(50),
    expectedEffortHours: z.number().int().min(1).max(10000).optional(),
    uncertainty: level,
    consequenceOfError: level,
    verificationCost: level,
    deadlinePressure: z.enum(['NONE', 'NORMAL', 'TIGHT']),
    /** Exact asset the founder intends to reward with; no asset is ever chosen for them. */
    rewardAsset: AssetPolicySnapshotSchema.optional(),
    budget: positive.optional(),
    preferredParticipantKinds: kinds.optional(),
  })
  .refine((value) => value.budget === undefined || value.rewardAsset !== undefined, {
    path: ['budget'],
    message: 'A budget needs its exact reward asset.',
  })
  .refine(
    (value) => new Set(value.skillDomains.map((d) => d.skillId)).size === value.skillDomains.length,
    { path: ['skillDomains'], message: 'Duplicate skill.' },
  );
export type RecommendationInput = z.infer<typeof RecommendationInputSchema>;

/**
 * A versioned, host-supplied rubric. This module ships no default: prices and thresholds are policy, and an
 * UNEVALUATED_EXAMPLE rubric can never be presented as reviewed pricing.
 */
export const RubricSchema = z
  .strictObject({
    version: InternalId,
    evaluation: z.enum(['UNEVALUATED_EXAMPLE', 'REVIEWED']),
    reviewRef: InternalId.nullable(),
    weights: z.strictObject({
      integrations: weight,
      skillDomains: weight,
      dependencies: weight,
      effort: weight,
      uncertainty: weight,
      consequence: weight,
      verification: weight,
      deadline: weight,
    }),
    /** Highest score still labelled E, D, C, B, A; anything above is S. */
    thresholds: z.tuple([
      z.number().int().min(0).max(10000),
      z.number().int().min(0).max(10000),
      z.number().int().min(0).max(10000),
      z.number().int().min(0).max(10000),
      z.number().int().min(0).max(10000),
    ]),
    durationDaysPerPoint: z.strictObject({
      low: z.number().min(0.01).max(30),
      high: z.number().min(0.01).max(30),
    }),
    participantKindsByRank: byRank(kinds),
    rewards: z
      .array(
        z.strictObject({
          policy: AssetPolicySnapshotSchema,
          bands: byRank(z.strictObject({ low: positive, high: positive })),
        }),
      )
      .max(10),
    /** Phrases that make an acceptance criterion unmeasurable (case-insensitive). */
    vaguePhrases: z.array(text.max(200)).max(50),
  })
  .superRefine((rubric, ctx) => {
    if (rubric.thresholds.some((t, i) => i > 0 && t <= rubric.thresholds[i - 1]))
      ctx.addIssue({ code: 'custom', path: ['thresholds'], message: 'Thresholds must increase.' });
    if (rubric.durationDaysPerPoint.high < rubric.durationDaysPerPoint.low)
      ctx.addIssue({ code: 'custom', path: ['durationDaysPerPoint'], message: 'high < low.' });
    if ((rubric.evaluation === 'REVIEWED') !== (rubric.reviewRef !== null))
      ctx.addIssue({
        code: 'custom',
        path: ['reviewRef'],
        message: 'A reviewed rubric needs its review reference, an example must not have one.',
      });
    for (const [i, entry] of rubric.rewards.entries())
      for (const rank of RANKS) {
        const band = entry.bands[rank];
        try {
          if (fromJsonAmount(band.high) < fromJsonAmount(band.low))
            ctx.addIssue({
              code: 'custom',
              path: ['rewards', i, 'bands', rank],
              message: 'high < low.',
            });
        } catch {
          ctx.addIssue({
            code: 'custom',
            path: ['rewards', i, 'bands', rank],
            message: 'Bad amount.',
          });
        }
      }
  })
  .readonly();
export type Rubric = z.infer<typeof RubricSchema>;

/** Advisory only. `authoritative` is always false: the Founder's confirmed terms are the contract. */
export const RecommendationSchema = z.strictObject({
  status: z.literal('ESTIMATE'),
  authoritative: z.literal(false),
  difficulty: SkillRankSchema,
  score: z.number().int().min(0),
  requiredSkills: z
    .array(
      z.strictObject({
        skillId: InternalId,
        minimumRank: SkillRankSchema,
        verificationRequired: z.literal(true),
      }),
    )
    .min(1),
  participantKinds: kinds,
  rewardSuggestion: z.discriminatedUnion('status', [
    z.strictObject({
      status: z.literal('RANGE'),
      policy: AssetPolicySnapshotSchema,
      low: positive,
      high: positive,
      /** Token units only: no fiat value is claimed without a timestamped reference price. */
      priceReference: z.null(),
    }),
    z.strictObject({
      status: z.literal('UNAVAILABLE'),
      reason: z.enum(['NO_ASSET_SELECTED', 'NO_PRICE_BASIS']),
    }),
  ]),
  estimatedDurationDays: z.strictObject({
    low: z.number().int().min(1),
    high: z.number().int().min(1),
  }),
  confidence: z.enum(['LOW', 'MEDIUM']),
  assumptions: z.array(z.string()).max(50),
  missingInformation: z.array(z.string()).max(50),
  policyVersion: InternalId,
  rubricEvaluation: z.enum(['UNEVALUATED_EXAMPLE', 'REVIEWED']),
});
export type Recommendation = z.infer<typeof RecommendationSchema>;

/** The Founder's final choices, accepted as suggested or edited. */
export const FinalChoicesSchema = z.strictObject({
  difficulty: SkillRankSchema,
  requiredSkills: z
    .array(z.strictObject({ skillId: InternalId, minimumRank: SkillRankSchema }))
    .min(1)
    .max(50),
  participantKinds: kinds,
  rewards: z
    .array(z.strictObject({ policy: AssetPolicySnapshotSchema, amount: positive }))
    .min(1)
    .max(10),
  /** Days available between commitment and the submission deadline. */
  availableDays: z.number().int().min(1).max(3650).optional(),
});
export type FinalChoices = z.infer<typeof FinalChoicesSchema>;

export const GapSchema = z.strictObject({
  code: z.enum([
    'DIFFICULTY_BELOW_ESTIMATE',
    'DIFFICULTY_ABOVE_ESTIMATE',
    'SKILL_REMOVED',
    'SKILL_RANK_LOWERED',
    'PARTICIPANT_KIND_ADDED',
    'REWARD_BELOW_RANGE',
    'REWARD_ABOVE_RANGE',
    'REWARD_ASSET_DIFFERS',
    'PRICE_UNAVAILABLE',
    'DEADLINE_SHORTER_THAN_ESTIMATE',
  ]),
  field: z.enum(['difficulty', 'requiredSkills', 'participantKinds', 'reward', 'deadline']),
  explanation: z.string(),
});
export type Gap = z.infer<typeof GapSchema>;

/** Unevaluated model output. Unknown keys (amounts, asset addresses, escrow instructions) are rejected. */
export const ModelAdviceSchema = z.strictObject({
  summary: text.max(2000),
  skillHints: z.array(InternalId).max(10),
  difficultyHint: SkillRankSchema.optional(),
});
export type ModelAdvice = z.infer<typeof ModelAdviceSchema>;
