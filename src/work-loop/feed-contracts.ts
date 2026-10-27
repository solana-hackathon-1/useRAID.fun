import { z } from 'zod';
import { InternalId, UtcTimestamp } from '../contracts/ids';
import { SkillRankSchema } from '../contracts/entities';
import { AmountSchema, AssetIdSchema, AssetDecimals } from '../contracts/assets';

/** Public Raid feed (blueprint §18.1–18.2, R08): safe cards of live, funded, open, public work. Read only. */
const ParticipantKind = z.enum(['HUMAN', 'AI_AGENT', 'AI_INFLUENCER']);
export const FEED_SORTS = ['newest', 'deadline', 'reward'] as const;
export const FEED_MAX_LIMIT = 50;
export const FeedQuerySchema = z
  .strictObject({
    category: InternalId.optional(),
    skillId: InternalId.optional(),
    difficulty: SkillRankSchema.optional(),
    participantKind: ParticipantKind.optional(),
    execution: z.enum(['SOLO', 'PARTY']).optional(),
    admission: z.enum(['INSTANT', 'APPLICATION']).optional(),
    /** The exact `assetKey` of a reward leg. Reward quantity is comparable only within one asset. */
    assetKey: z.string().min(1).max(400).optional(),
    closesBefore: UtcTimestamp.optional(),
    sort: z.enum(FEED_SORTS).default('newest'),
    limit: z.number().int().min(1).max(FEED_MAX_LIMIT).default(20),
    cursor: z.string().min(1).max(600).optional(),
  })
  .refine((q) => q.sort !== 'reward' || q.assetKey !== undefined, {
    message: 'Reward ordering needs one asset: amounts in different assets are not comparable.',
    path: ['sort'],
  });
export type FeedQuery = z.infer<typeof FeedQuerySchema>;
export const FeedRewardSchema = z.strictObject({
  assetKey: z.string().min(1).max(400),
  assetId: AssetIdSchema,
  decimals: AssetDecimals,
  amount: AmountSchema,
});
/** Only fields a visitor may see: no reviewer, outcome, deliverables, policies, funding references or creator. */
export const FeedCardSchema = z.strictObject({
  listingId: z.uuid(),
  termsVersionId: z.uuid(),
  guildId: InternalId,
  title: z.string().min(1).max(200),
  publicSummary: z.string().min(1).max(1000),
  category: InternalId,
  difficulty: SkillRankSchema,
  requiredSkills: z
    .array(z.strictObject({ skillId: InternalId, minimumRank: SkillRankSchema }))
    .min(1)
    .max(50),
  participantKinds: z.array(ParticipantKind).min(1).max(3),
  execution: z.enum(['SOLO', 'PARTY']),
  admission: z.enum(['INSTANT', 'APPLICATION']),
  rewards: z.array(FeedRewardSchema).min(1).max(10),
  commitmentDeadline: UtcTimestamp,
  submissionDeadline: UtcTimestamp,
  availableSlots: z.number().int().min(1),
  /** This milestone reserves simulated funding only; the label must never read as real escrow. */
  funding: z.strictObject({ mode: z.literal('SIMULATED') }),
  confidentiality: z.literal('PUBLIC'),
});
export type FeedCard = z.infer<typeof FeedCardSchema>;
export const FeedPageSchema = z.strictObject({
  items: z.array(FeedCardSchema).max(FEED_MAX_LIMIT),
  nextCursor: z.string().min(1).max(600).nullable(),
  sort: z.enum(FEED_SORTS),
  /** True only when an asset is selected: reward order is then within that one asset. */
  rewardComparable: z.boolean(),
});
export type FeedPage = z.infer<typeof FeedPageSchema>;
