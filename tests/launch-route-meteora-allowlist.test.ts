import { describe, expect, it } from 'vitest';
import { createMeteoraDbcLaunchRouteWithDecisions } from '../src/launch-route/meteora-dbc';
import { DEC, T0, economics, mockClient, request } from './helpers/launch-route-fixtures';

/**
 * Field names of the IDL struct `configParameters` and its nested structs, recorded from the
 * published types of `@meteora-ag/dynamic-bonding-curve-sdk@2.0.0` (`ConfigParameters =
 * IdlTypes<DynamicBondingCurve>['configParameters']`). The SDK is not a repository dependency, so
 * this is a recorded snapshot: re-record it from the installed SDK types when the SDK is added or
 * upgraded. The reserved `padding` byte array is host-filled and deliberately not allow-listed.
 */
const SDK_V2_CONFIG_PARAMETERS = {
  poolFees: {
    baseFee: ['cliffFeeNumerator', 'firstFactor', 'secondFactor', 'thirdFactor', 'baseFeeMode'],
    dynamicFee: [
      'binStep',
      'binStepU128',
      'filterPeriod',
      'decayPeriod',
      'reductionFactor',
      'maxVolatilityAccumulator',
      'variableFeeControl',
    ],
  },
  collectFeeMode: 1,
  migrationOption: 1,
  activationType: 1,
  tokenType: 1,
  tokenDecimal: 6,
  partnerLiquidityPercentage: 1,
  partnerPermanentLockedLiquidityPercentage: 1,
  creatorLiquidityPercentage: 1,
  creatorPermanentLockedLiquidityPercentage: 1,
  migrationQuoteThreshold: '1',
  sqrtStartPrice: '1',
  lockedVesting: [
    'amountPerPeriod',
    'cliffDurationFromMigrationTime',
    'frequency',
    'numberOfPeriod',
    'cliffUnlockAmount',
  ],
  migrationFeeOption: 1,
  tokenSupply: ['preMigrationTokenSupply', 'postMigrationTokenSupply'],
  creatorTradingFeePercentage: 1,
  tokenUpdateAuthority: 1,
  migrationFee: ['feePercentage', 'creatorFeePercentage'],
  migratedPoolFee: ['collectFeeMode', 'dynamicFee', 'poolFeeBps'],
  poolCreationFee: '1',
  partnerLiquidityVestingInfo: [
    'vestingPercentage',
    'bpsPerPeriod',
    'numberOfPeriods',
    'cliffDurationFromMigrationTime',
    'frequency',
  ],
  creatorLiquidityVestingInfo: [
    'vestingPercentage',
    'bpsPerPeriod',
    'numberOfPeriods',
    'cliffDurationFromMigrationTime',
    'frequency',
  ],
  migratedPoolBaseFeeMode: 1,
  migratedPoolMarketCapFeeSchedulerParams: [
    'numberOfPeriod',
    'sqrtPriceStepBps',
    'schedulerExpirationDuration',
    'reductionFactor',
  ],
  enableFirstSwapWithMinFee: false,
  compoundingFeeBps: 1,
  curve: ['sqrtPrice', 'liquidity'],
} as const;

type Spec = readonly string[] | { readonly [key: string]: Spec | string | number | boolean };

/** Expand the recorded name lists into a concrete `configParameters` value (strings stand for scalars). */
function expand(spec: unknown): unknown {
  if (Array.isArray(spec)) {
    const leaves = Object.fromEntries((spec as string[]).map((name) => [name, '1']));
    return spec.includes('sqrtPrice') ? [leaves] : leaves;
  }
  if (spec !== null && typeof spec === 'object') {
    return Object.fromEntries(
      Object.entries(spec as Record<string, Spec>).map(([key, value]) => [key, expand(value)]),
    );
  }
  return spec;
}

async function validate(configParameters: unknown) {
  const m = mockClient({});
  const route = createMeteoraDbcLaunchRouteWithDecisions(
    {
      network: 'DEVNET',
      client: m.client,
      now: () => T0,
      economics: economics({ configParameters }) as never,
    },
    [DEC],
  );
  return route.validateLaunch(request());
}

describe('Meteora configParameters allow-list matches the SDK ConfigParameters names', () => {
  it('accepts every field name of the SDK ConfigParameters struct at every depth', async () => {
    const result = await validate(expand(SDK_V2_CONFIG_PARAMETERS));
    expect(result.ok).toBe(true);
  });

  it.each([
    ['tokenAuthorityOption', { tokenAuthorityOption: 1 }],
    ['lockedVesting.totalVestingDuration', { lockedVesting: { totalVestingDuration: '1' } }],
    ['migratedPoolFee.compoundingFeeBps', { migratedPoolFee: { compoundingFeeBps: 1 } }],
    [
      'partnerLiquidityVestingInfo.totalDuration',
      { partnerLiquidityVestingInfo: { totalDuration: '1' } },
    ],
    [
      'migratedPoolMarketCapFeeSchedulerParams.priceMultiple',
      { migratedPoolMarketCapFeeSchedulerParams: { priceMultiple: '1' } },
    ],
    ['padding', { padding: [] }],
  ])('refuses the name the SDK does not define: %s', async (_name, config) => {
    const result = await validate(config);
    expect(result.ok).toBe(false);
  });
});
