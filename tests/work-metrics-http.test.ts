import { describe, expect, it, vi } from 'vitest';
import { createMetricsHandlers, type MetricsHttpHost } from '../src/work-http/metrics-http';
import { WorkHttpError } from '../src/work-http/workspace-http';

const empty = {
  version: 'v1',
  generatedAt: '2026-10-27T00:00:00.000Z',
  fundingMode: 'SIMULATED',
  listings: {},
  slots: {},
  applications: {},
  offers: {},
  engagements: {},
  closures: {},
  reviews: {},
  submissions: 0,
  timings: {
    matching: { samples: 0, medianSeconds: null, p90Seconds: null },
    review: { samples: 0, medianSeconds: null, p90Seconds: null },
  },
  volumes: [],
  notMeasured: ['paidVolume'],
};
function host(overrides: Partial<MetricsHttpHost> = {}): MetricsHttpHost {
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
  new Request('http://localhost/api/v1/admin/work/metrics' + query, { method });
const error = async (response: Response) => (await response.json()).error;
describe('operator work-loop metrics HTTP boundary', () => {
  it('returns schema-checked, private, uncacheable metrics', async () => {
    const response = await createMetricsHandlers(host()).GET(get());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual(empty);
  });
  it('answers as if absent while the flag is off and never reads', async () => {
    const metrics = vi.fn(async () => empty);
    const response = await createMetricsHandlers(host({ available: () => false, metrics })).GET(
      get(),
    );
    expect(response.status).toBe(404);
    expect(metrics).not.toHaveBeenCalled();
  });
  it('requires operator authority and the rate limit before reading anything', async () => {
    const metrics = vi.fn(async () => empty);
    for (const [status, code] of [
      [401, 'AUTHENTICATION_REQUIRED'],
      [403, 'FORBIDDEN'],
      [429, 'RATE_LIMITED'],
    ] as const) {
      const denial = () => Promise.reject(new WorkHttpError(status));
      const handlers = createMetricsHandlers(
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
  it('rejects query strings and foreign methods, hides host failures and refuses contract drift', async () => {
    const handlers = createMetricsHandlers(host());
    expect((await handlers.GET(get('?x=1'))).status).toBe(422);
    expect((await handlers.GET(get('', 'POST'))).status).toBe(405);
    const crash = await createMetricsHandlers(
      host({
        metrics: async () => {
          throw new Error('postgres://secret');
        },
      }),
    ).GET(get());
    expect(crash.status).toBe(503);
    expect(JSON.stringify(await error(crash))).not.toContain('secret');
    const drift = await createMetricsHandlers(
      host({ metrics: async () => ({ ...empty, volumes: [{ usd: 1 }] }) }),
    ).GET(get());
    expect(drift.status).toBe(503);
  });
  it('refuses a host that omits a port', () => {
    expect(() => createMetricsHandlers({ version: 'v1' } as unknown as MetricsHttpHost)).toThrow();
  });
  it('throttles the authorized operator by identity, not by a shared variable', async () => {
    const rateLimit = vi.fn(async () => {});
    await createMetricsHandlers(host({ rateLimit, authorize: async () => 'operator-9' })).GET(
      get(),
    );
    expect(rateLimit).toHaveBeenCalledWith('operator-9');
  });
});
