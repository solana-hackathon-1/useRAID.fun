import { z } from 'zod';
import { UtcTimestamp } from '../contracts/ids';
import { AmountSchema, AssetIdSchema, AssetDecimals } from '../contracts/assets';

/**
 * Operator-only measurements of the useful work loop (blueprint §31). They report what happened by state and
 * separate drafted, funded, committed and work-accepted volume. Quantities stay per asset: nothing is summed across
 * assets, valued in dollars or presented as paid.
 */
const Counts = z.record(z.string().min(1).max(64), z.number().int().min(0));
const Timing = z.strictObject({
  samples: z.number().int().min(0),
  medianSeconds: z.number().min(0).nullable(),
  p90Seconds: z.number().min(0).nullable(),
});
export const AssetVolumeSchema = z.strictObject({
  assetKey: z.string().min(1).max(400),
  assetId: AssetIdSchema,
  decimals: AssetDecimals,
  /** Rewards reserved on open, available slots. */
  openFunded: AmountSchema,
  /** Rewards of engagements that are accepted but not yet finished. */
  committed: AmountSchema,
  /** Rewards of engagements whose work was accepted. Accepting work is not payment. */
  workAccepted: AmountSchema,
  /** Settlement is not built: payment is never inferred from acceptance. */
  paid: z.null(),
});
export const WorkMetricsSchema = z.strictObject({
  version: z.literal('v1'),
  generatedAt: UtcTimestamp,
  fundingMode: z.literal('SIMULATED'),
  listings: Counts,
  slots: Counts,
  applications: Counts,
  offers: Counts,
  engagements: Counts,
  closures: Counts,
  reviews: Counts,
  submissions: z.number().int().min(0),
  timings: z.strictObject({ matching: Timing, review: Timing }),
  volumes: z.array(AssetVolumeSchema).max(100),
  /** Named so a reader cannot mistake absence for zero. */
  notMeasured: z.array(z.string().min(1).max(64)).min(1),
});
export type WorkMetrics = z.infer<typeof WorkMetricsSchema>;
