import { z } from 'zod';
import { UtcTimestamp } from '../contracts/ids';

/**
 * Operator-only product activation and repeat measures (blueprint §31.1-31.2, requirement T043). Every ratio states
 * its denominator and exclusions. The report carries counts and durations only: no amounts, valuation, account,
 * handle, brief text or evidence, so nothing here can be summed across assets or mistaken for paid dollars.
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
export const ProductMetricsSchema = z.strictObject({
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
  /** Work that was left out of every figure above because its Guild id has no persisted Guild. */
  excluded: z.strictObject({
    listingsWithoutVerifiedGuild: z.number().int().min(0),
    engagementsWithoutVerifiedGuild: z.number().int().min(0),
  }),
  /** Named so a reader cannot mistake absence for zero. */
  notMeasured: z.array(z.string().min(1).max(64)).min(1),
});
export type ProductMetrics = z.infer<typeof ProductMetricsSchema>;
export type RatioMetric = z.infer<typeof RatioMetricSchema>;
export class MetricsError extends Error {
  constructor(readonly code: 'STORAGE_CONTRACT') {
    super(code);
    this.name = 'MetricsError';
  }
}
