import { describe, expect, it, vi } from 'vitest';
import { createProductMetricsHandlers, MetricsHttpError } from '../src/metrics/http';
import type { ProductMetricsHttpHost } from '../src/metrics/http';

const metric = {
  numerator: 0,
  denominator: 0,
  rate: null,
  denominatorDefinition: 'Synthetic denominator definition.',
  exclusions: ['Synthetic exclusion.'],
};
const timing = { samples: 0, medianSeconds: null, p90Seconds: null };
const nativeAsset = { chain: 'SOLANA', networkIdentity: 'synthetic', kind: 'NATIVE_SOL' };
const tokenAsset = {
  chain: 'SOLANA',
  networkIdentity: 'synthetic',
  kind: 'TOKEN',
  mint: 'So11111111111111111111111111111111111111112',
  tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
};
const settlementRow = (assetKey: string, assetId: object) => ({
  assetKey,
  assetId,
  decimals: 9,
  dueEngagements: 2,
  dueAmount: '500',
  resolvedEngagements: 1,
  resolvedAmount: '200',
});
const disputeRow = (assetKey: string, assetId: object) => ({
  assetKey,
  assetId,
  decimals: 9,
  raisedEngagements: 2,
  raisedAmount: '90',
  openEngagements: 1,
  openAmount: '40',
});
const prose = ['Synthetic definition text.'];
const buckets = (counts: number[]) =>
  ['LE_1H', 'LE_4H', 'LE_1D', 'LE_3D', 'GT_3D'].map((bucket, index) => ({
    bucket,
    count: counts[index],
  }));
const empty = {
  version: 'v1',
  generatedAt: '2026-10-30T00:00:00.000Z',
  fundingMode: 'SIMULATED',
  definitions: 'DEFAULT_NOT_OWNER_POLICY',
  guildActivation: metric,
  guildFirstOutcome: metric,
  guildRepeat: metric,
  raiderActivation: metric,
  raiderFirstOutcome: metric,
  raiderRepeat: metric,
  timings: {
    guildToFirstFundedOffering: timing,
    guildToFirstOutcome: timing,
    raiderToFirstOutcome: timing,
  },
  launchConversion: {
    unit: 'WORK_LISTING',
    drafted: { count: 0, definition: 'Synthetic definition text.', exclusions: prose },
    fundedFromDrafted: metric,
    acceptedFromFunded: metric,
    workAcceptedFromAccepted: metric,
    workAcceptedFromDrafted: metric,
    paid: null,
  },
  settlement: {
    definition: 'Synthetic definition text.',
    exclusions: prose,
    valuation: 'NOT_VALUED',
    byAsset: [],
  },
  disputes: {
    definition: 'Synthetic definition text.',
    exclusions: prose,
    valuation: 'NOT_VALUED',
    raised: 0,
    open: 0,
    byAsset: [],
  },
  reviewDelay: { decided: metric, timing, distribution: buckets([0, 0, 0, 0, 0]) },
  excluded: {
    listingsWithoutVerifiedGuild: 0,
    engagementsWithoutVerifiedGuild: 0,
    submissionsWithoutVerifiedGuild: 0,
  },
  notMeasured: ['paidVolume'],
};
function host(overrides: Partial<ProductMetricsHttpHost> = {}): ProductMetricsHttpHost {
  return {
    version: 'v1',
    requestId: () => 'request-1',
    available: () => true,
    authorize: async () => 'operator-1',
    rateLimit: async () => {},
    metrics: async () => empty,
    ...overrides,
  };
}
const get = (query = '', method = 'GET') =>
  new Request('http://localhost/api/v1/admin/metrics/product' + query, { method });
const error = async (response: Response) => (await response.json()).error;

describe('operator product-metrics HTTP boundary', () => {
  it('returns schema-checked, private, uncacheable metrics', async () => {
    const response = await createProductMetricsHandlers(host()).GET(get());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual(empty);
  });
  it('answers as if absent while the flag is off and never authorizes or reads', async () => {
    const metrics = vi.fn(async () => empty);
    const authorize = vi.fn(async () => 'operator-1');
    const response = await createProductMetricsHandlers(
      host({ available: () => false, metrics, authorize }),
    ).GET(get());
    expect(response.status).toBe(404);
    expect(metrics).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
  });
  it('requires operator authority and the rate limit before reading anything', async () => {
    const metrics = vi.fn(async () => empty);
    for (const [status, code] of [
      [401, 'AUTHENTICATION_REQUIRED'],
      [403, 'FORBIDDEN'],
      [429, 'RATE_LIMITED'],
    ] as const) {
      const denial = () => Promise.reject(new MetricsHttpError(status));
      const handlers = createProductMetricsHandlers(
        host({
          metrics,
          authorize: status === 429 ? async () => 'operator-1' : denial,
          rateLimit: status === 429 ? denial : async () => {},
        }),
      );
      const response = await handlers.GET(get());
      expect(response.status).toBe(status);
      expect((await error(response)).code).toBe(code);
    }
    expect(metrics).not.toHaveBeenCalled();
  });
  it('refuses an ordinary or unexpected failure to authorize without reading', async () => {
    const metrics = vi.fn(async () => empty);
    const response = await createProductMetricsHandlers(
      host({
        metrics,
        authorize: async () => {
          throw new Error('postgres://secret');
        },
      }),
    ).GET(get());
    expect(response.status).toBe(503);
    expect(JSON.stringify(await error(response))).not.toContain('secret');
    expect(metrics).not.toHaveBeenCalled();
  });
  it('rejects query strings (no caller-chosen scope) and foreign methods', async () => {
    const handlers = createProductMetricsHandlers(host());
    expect((await handlers.GET(get('?guildId=other'))).status).toBe(422);
    expect((await handlers.GET(get('', 'POST'))).status).toBe(405);
  });
  it('refuses contract drift such as a stray valuation or account field', async () => {
    for (const drift of [
      { ...empty, usdValue: 1 },
      { ...empty, guildActivation: { ...metric, accountIds: ['a'] } },
      { ...empty, fundingMode: 'LIVE' },
    ]) {
      const response = await createProductMetricsHandlers(host({ metrics: async () => drift })).GET(
        get(),
      );
      expect(response.status).toBe(503);
    }
  });
  it('rejects a numerator above its denominator and a rate that disagrees', async () => {
    for (const bad of [
      { ...metric, numerator: 2, denominator: 1, rate: 2 },
      { ...metric, numerator: 1, denominator: 2, rate: 0.9 },
      { ...metric, numerator: 0, denominator: 0, rate: 0 },
    ]) {
      const response = await createProductMetricsHandlers(
        host({ metrics: async () => ({ ...empty, guildActivation: bad }) }),
      ).GET(get());
      expect(response.status).toBe(503);
    }
  });
  it('forwards per-asset settlement and dispute amounts and refuses figures that mix, value or overstate them', async () => {
    const native = '["SOLANA","synthetic","NATIVE_SOL"]';
    const token = '["SOLANA","synthetic","TOKEN"]';
    const valid = {
      ...empty,
      settlement: {
        ...empty.settlement,
        byAsset: [settlementRow(native, nativeAsset), settlementRow(token, tokenAsset)],
      },
      disputes: {
        ...empty.disputes,
        raised: 4,
        open: 2,
        byAsset: [disputeRow(native, nativeAsset), disputeRow(token, tokenAsset)],
      },
    };
    const ok = await createProductMetricsHandlers(host({ metrics: async () => valid })).GET(get());
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual(valid);
    const row = settlementRow(native, nativeAsset);
    for (const drift of [
      // The same asset twice (a cross-asset style sum), a priced figure, an unvalued flag turned off and overstated parts.
      { ...valid, settlement: { ...valid.settlement, byAsset: [row, row] } },
      {
        ...valid,
        settlement: { ...valid.settlement, byAsset: [{ ...row, usdValue: '1' }] },
      },
      { ...valid, settlement: { ...valid.settlement, valuation: 'USD' } },
      {
        ...valid,
        settlement: { ...valid.settlement, byAsset: [{ ...row, resolvedAmount: '501' }] },
      },
      { ...valid, settlement: { ...valid.settlement, byAsset: [{ ...row, dueAmount: '1.5' }] } },
      {
        ...valid,
        disputes: {
          ...valid.disputes,
          byAsset: [{ ...disputeRow(native, nativeAsset), openEngagements: 3 }],
        },
      },
      { ...valid, disputes: { ...valid.disputes, open: 5 } },
      { ...valid, launchConversion: { ...valid.launchConversion, paid: 0 } },
      { ...valid, launchConversion: { ...valid.launchConversion, unit: 'PARTICIPANT' } },
    ]) {
      const response = await createProductMetricsHandlers(host({ metrics: async () => drift })).GET(
        get(),
      );
      expect(response.status).toBe(503);
    }
  });
  it('refuses a review-delay distribution that does not account for every decided submission', async () => {
    const decided = { ...metric, numerator: 2, denominator: 3, rate: 2 / 3 };
    const delay = (counts: number[], samples = 2) => ({
      decided,
      timing: { samples, medianSeconds: 10, p90Seconds: 20 },
      distribution: buckets(counts),
    });
    for (const [reviewDelay, status] of [
      [delay([1, 1, 0, 0, 0]), 200],
      [delay([1, 0, 0, 0, 0]), 503],
      [delay([1, 1, 0, 0, 0], 3), 503],
      [{ ...delay([1, 1, 0, 0, 0]), distribution: buckets([1, 1, 0, 0, 0]).slice(1) }, 503],
    ] as const) {
      const response = await createProductMetricsHandlers(
        host({ metrics: async () => ({ ...empty, reviewDelay }) }),
      ).GET(get());
      expect(response.status).toBe(status);
    }
  });
  it('refuses a host that omits a port and throttles by operator identity', async () => {
    expect(() =>
      createProductMetricsHandlers({ version: 'v1' } as unknown as ProductMetricsHttpHost),
    ).toThrow();
    const rateLimit = vi.fn(async () => {});
    await createProductMetricsHandlers(
      host({ rateLimit, authorize: async () => 'operator-9' }),
    ).GET(get());
    expect(rateLimit).toHaveBeenCalledWith('operator-9');
  });
});
