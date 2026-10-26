import { z } from 'zod';
import { AmountSchema, AssetPolicySnapshotSchema } from '../contracts/assets';
import { RaidTermsSchema } from './terms';
import { RecommendationInputSchema, RecommendationSchema } from './recommendation-contracts';
import { rewardReview, type RewardAsset } from './creation-form';

export const CreationDraftSchema = z.strictObject({
  listingId: z.uuid(),
  termsVersionId: z.uuid(),
  revision: z.number().int().min(1),
  state: z.enum(['DRAFT', 'OPEN', 'PAUSED', 'CLOSED', 'CANCELLED', 'ARCHIVED']),
  terms: RaidTermsSchema,
  /** Server-derived publication problems at database time; the browser never decides validity. */
  problems: z.array(z.string()),
  /** True only when this exact version holds its reward reservation. */
  reserved: z.boolean(),
});
export type CreationDraft = z.infer<typeof CreationDraftSchema>;
export const RewardAssetSchema = z.strictObject({
  label: z.string().min(1).max(100),
  policy: AssetPolicySnapshotSchema,
  /** True only when the host's simulated reserve covers this asset. */
  funded: z.boolean(),
});
export const RewardReviewSchema = z.strictObject({
  fundingMode: z.literal('SIMULATED'),
  legs: z
    .array(
      z.strictObject({
        label: z.string(),
        policy: AssetPolicySnapshotSchema,
        amount: AmountSchema,
        decimals: z.number().int().min(0).max(255),
        display: z.string(),
        funded: z.boolean(),
      }),
    )
    .min(1)
    .max(10),
  coverage: z.enum(['ALL_FUNDED', 'PARTIAL', 'NONE']),
  fee: z.strictObject({ payer: z.literal('FOUNDER'), amount: z.literal('0'), policy: z.string() }),
  rent: z.strictObject({ applicable: z.literal(false), payer: z.null(), note: z.string() }),
});
export const DraftViewSchema = CreationDraftSchema.extend({
  review: RewardReviewSchema,
  /** Publishable now: still a draft, no server-derived problem, and every reward leg is covered. */
  ready: z.boolean(),
})
  .strict()
  .refine(
    (draft) =>
      !draft.ready ||
      (draft.state === 'DRAFT' && !draft.problems.length && draft.review.coverage === 'ALL_FUNDED'),
    { message: 'A draft cannot be ready with problems or an uncovered reward.' },
  );
export type DraftView = z.infer<typeof DraftViewSchema>;
/** Drafts plus the server's own view of validity and funding; the browser derives neither. */
export function toDraftView(
  draft: z.infer<typeof CreationDraftSchema>,
  catalog: readonly RewardAsset[],
): DraftView {
  const review = rewardReview(draft.terms, catalog);
  const problems = [...draft.problems];
  if (review.coverage !== 'ALL_FUNDED') problems.push('FUNDING_NOT_COVERED');
  return DraftViewSchema.parse({
    ...draft,
    problems,
    review,
    ready: draft.state === 'DRAFT' && !problems.length,
  });
}
export const CreationStateSchema = z.strictObject({
  version: z.literal('v1'),
  assets: z.array(RewardAssetSchema).max(20),
  drafts: z.array(DraftViewSchema).max(20),
  savesAvailable: z.boolean(),
  publishAvailable: z.boolean(),
  recommendationsAvailable: z.boolean(),
});
export const SaveDraftInput = z.strictObject({
  listingId: z.uuid().nullable(),
  expectedRevision: z.number().int().min(0).max(2147483646),
  terms: RaidTermsSchema,
});
export const SaveDraftResultSchema = z.strictObject({
  status: z.enum(['EXECUTED', 'REPLAYED']),
  draft: DraftViewSchema,
});
export const PublishDraftInput = z.strictObject({ termsVersionId: z.uuid() });
export const PublishResultSchema = z.strictObject({
  status: z.enum(['EXECUTED', 'REPLAYED']),
  listingId: z.uuid(),
  termsVersionId: z.uuid(),
  slotId: z.uuid(),
  fundingMode: z.literal('SIMULATED'),
});
export { RecommendationInputSchema, RecommendationSchema };
