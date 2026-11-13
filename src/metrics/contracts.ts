import { z } from 'zod';
import { UtcTimestamp } from '../contracts/ids';
import { AmountSchema, AssetIdSchema, AssetDecimals } from '../contracts/assets';

/**
 * Operator-only product measures (blueprint §31.1-31.2, requirement T043). Every ratio states its denominator and
 * exclusions. Counts and durations carry no money. The only quantities are settlement and dispute amounts, and those
 * exist per full asset identity only: no figure is summed across assets, valued, priced or presented as paid dollars,
 * and no account, handle, brief text or evidence appears.
 *
 * The definitions are DEFAULT interpretations of the blueprint wording, not owner policy; `definitions` says so.
 */
export const RatioMetricSchema = z
  .strictObject({
    numerator: z.number().int().min(0),
    denominator: z.number().int().min(0),
    /** `numerator / denominator`, or null when the denominator is zero: absence is never reported as a zero rate. */
    rate: z.number().min(0).max(1).nullable(),
    denominatorDefinition: z.string().min(10).max(400),
    exclusions: z.array(z.string().min(1).max(400)).min(1).max(12),
  })
  .superRefine((metric, ctx) => {
    const consistent =
      metric.numerator <= metric.denominator &&
      (metric.denominator === 0
        ? metric.rate === null
        : metric.rate !== null &&
          Math.abs(metric.rate - metric.numerator / metric.denominator) < 1e-9);
    if (!consistent)
      ctx.addIssue({ code: 'custom', message: 'numerator, denominator and rate disagree' });
  });
export const TimingSchema = z.strictObject({
  samples: z.number().int().min(0),
  medianSeconds: z.number().min(0).nullable(),
  p90Seconds: z.number().min(0).nullable(),
});
const Text = z.string().min(10).max(600);
export const CountMetricSchema = z.strictObject({
  count: z.number().int().min(0),
  definition: Text,
  exclusions: z.array(z.string().min(1).max(600)).min(1).max(12),
});
/** One step of the work funnel: each step is a share of the step before it, so a step can never exceed its parent. */
export const WorkListingFunnelSchema = z.strictObject({
  /** The funnel counts work listings (a drafted Raid), whichever of its slots or engagements reached each step. */
  unit: z.literal('WORK_LISTING'),
  drafted: CountMetricSchema,
  fundedFromDrafted: RatioMetricSchema,
  acceptedFromFunded: RatioMetricSchema,
  workAcceptedFromAccepted: RatioMetricSchema,
  workAcceptedFromDrafted: RatioMetricSchema,
  /** Settlement is not built: payment is never inferred from acceptance, so this stays null rather than zero. */
  paid: z.null(),
});
const AssetIdentity = {
  assetKey: z.string().min(1).max(400),
  assetId: AssetIdSchema,
  decimals: AssetDecimals,
};
const Quantity = z.number().int().min(0);
const uniqueAssets = (rows: { assetKey: string }[]) =>
  new Set(rows.map((row) => row.assetKey)).size === rows.length;
const atMost = (small: string, large: string) => BigInt(small) <= BigInt(large);
export const SettlementAssetSchema = z
  .strictObject({
    ...AssetIdentity,
    /** Engagements closed as work accepted that pay a leg in this asset. */
    dueEngagements: Quantity,
    /** Base units of that asset across those engagements (effective, amended terms). */
    dueAmount: AmountSchema,
    /** The due engagements whose closure financial resolution is no longer OPEN. */
    resolvedEngagements: Quantity,
    resolvedAmount: AmountSchema,
  })
  .refine(
    (row) =>
      row.resolvedEngagements <= row.dueEngagements && atMost(row.resolvedAmount, row.dueAmount),
    { message: 'resolved exceeds due' },
  );
export const DisputeAssetSchema = z
  .strictObject({
    ...AssetIdentity,
    raisedEngagements: Quantity,
    raisedAmount: AmountSchema,
    openEngagements: Quantity,
    openAmount: AmountSchema,
  })
  .refine(
    (row) =>
      row.openEngagements <= row.raisedEngagements && atMost(row.openAmount, row.raisedAmount),
    { message: 'open exceeds raised' },
  );
const Valuation = z.literal('NOT_VALUED');
export const SettlementSchema = z.strictObject({
  definition: Text,
  exclusions: z.array(z.string().min(1).max(600)).min(1).max(12),
  /** No dated approved price methodology exists, so no figure is a dollar value. */
  valuation: Valuation,
  byAsset: z.array(SettlementAssetSchema).max(100).refine(uniqueAssets, 'asset repeated'),
});
export const DisputesSchema = z
  .strictObject({
    definition: Text,
    exclusions: z.array(z.string().min(1).max(600)).min(1).max(12),
    valuation: Valuation,
    raised: Quantity,
    open: Quantity,
    byAsset: z.array(DisputeAssetSchema).max(100).refine(uniqueAssets, 'asset repeated'),
  })
  .refine((disputes) => disputes.open <= disputes.raised, { message: 'open exceeds raised' });
export const DELAY_BUCKETS = ['LE_1H', 'LE_4H', 'LE_1D', 'LE_3D', 'GT_3D'] as const;
export const ReviewDelaySchema = z
  .strictObject({
    /** Numerator: submissions with a substantive decision; denominator: all verified-Guild submissions. */
    decided: RatioMetricSchema,
    /** Submission to decision over decided submissions only; undecided ones are in the denominator, not here. */
    timing: TimingSchema,
    distribution: z
      .array(z.strictObject({ bucket: z.enum(DELAY_BUCKETS), count: Quantity }))
      .length(DELAY_BUCKETS.length),
  })
  .refine(
    (delay) =>
      delay.distribution.reduce((sum, bucket) => sum + bucket.count, 0) === delay.timing.samples &&
      delay.timing.samples === delay.decided.numerator,
    { message: 'distribution does not account for every decided submission' },
  );
export const ProductMetricsSchema = z
  .strictObject({
    version: z.literal('v1'),
    generatedAt: UtcTimestamp,
    fundingMode: z.literal('SIMULATED'),
    /** The measure definitions are defaults chosen by the implementation; no owner decision approves them yet. */
    definitions: z.literal('DEFAULT_NOT_OWNER_POLICY'),
    guildActivation: RatioMetricSchema,
    guildFirstOutcome: RatioMetricSchema,
    guildRepeat: RatioMetricSchema,
    raiderActivation: RatioMetricSchema,
    raiderFirstOutcome: RatioMetricSchema,
    raiderRepeat: RatioMetricSchema,
    timings: z.strictObject({
      guildToFirstFundedOffering: TimingSchema,
      guildToFirstOutcome: TimingSchema,
      raiderToFirstOutcome: TimingSchema,
    }),
    /** DEC-2026-11-13-10(b): the work-listing funnel. "Launch conversion" is `tokenLaunchConversion`, which is not measured. */
    workListingFunnel: WorkListingFunnelSchema,
    /** @deprecated Old name of `workListingFunnel`, kept for one version; always identical to it. Not token-launch conversion. */
    launchConversion: WorkListingFunnelSchema,
    settlement: SettlementSchema,
    disputes: DisputesSchema,
    reviewDelay: ReviewDelaySchema,
    /** Work that was left out of every figure above because its Guild id has no persisted Guild. */
    excluded: z.strictObject({
      listingsWithoutVerifiedGuild: z.number().int().min(0),
      engagementsWithoutVerifiedGuild: z.number().int().min(0),
      submissionsWithoutVerifiedGuild: z.number().int().min(0),
    }),
    /** Named so a reader cannot mistake absence for zero. */
    notMeasured: z.array(z.string().min(1).max(64)).min(1),
  })
  .refine(
    (page) => JSON.stringify(page.launchConversion) === JSON.stringify(page.workListingFunnel),
    {
      message: 'deprecated launchConversion must equal workListingFunnel',
      path: ['launchConversion'],
    },
  );
export type ProductMetrics = z.infer<typeof ProductMetricsSchema>;
export type RatioMetric = z.infer<typeof RatioMetricSchema>;
export class MetricsError extends Error {
  constructor(
    readonly code: 'STORAGE_CONTRACT' | 'INVALID_INPUT' | 'SUBJECT_NOT_FOUND' | 'CONFLICT',
  ) {
    super(code);
    this.name = 'MetricsError';
  }
}
