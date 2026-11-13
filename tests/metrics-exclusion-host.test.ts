import { afterEach, expect, it, vi } from 'vitest';
const port = vi.hoisted(() => ({
  tx: {},
  set: vi.fn(),
  require: vi.fn(),
  limit: vi.fn(),
  origin: vi.fn(),
}));
vi.mock('../src/lib/db', () => ({ db: {} }));
vi.mock('../src/lib/command-receipts-adapter', () => ({
  runCommandTransaction: async (_db: unknown, work: (tx: object) => unknown) => work(port.tx),
}));
vi.mock('../src/metrics/exclusion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/metrics/exclusion')>()),
  setMetricsExclusion: port.set,
}));
vi.mock('../src/lib/auth', () => {
  class HttpError extends Error {
    constructor(
      public status: number,
      message?: string,
    ) {
      super(message ?? 'http');
    }
  }
  return {
    HttpError,
    requireUser: port.require,
    rateLimit: port.limit,
    checkOrigin: port.origin,
  };
});
import { metricsExclusionHandlers } from '../src/lib/metrics-exclusion-http';
import { HttpError } from '../src/lib/auth';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
const body = {
  subjectType: 'GUILD',
  subjectId: 'guild-1',
  reason: 'FIXTURE',
  evidenceRef: 'ticket-1',
  effect: 'EXCLUDE',
  supersedesMarkerId: null,
};
const post = () =>
  new Request('http://localhost/api/v1/admin/metrics/exclusions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

it('is closed unless the product-metrics flag is exactly "true"', async () => {
  for (const value of [undefined, '', 'TRUE', '1']) {
    vi.stubEnv('PRODUCT_METRICS_READS_ENABLED', value);
    expect((await metricsExclusionHandlers.POST(post())).status).toBe(404);
  }
  expect(port.require).not.toHaveBeenCalled();
  expect(port.set).not.toHaveBeenCalled();
});

it('requires the shared administrator rule and a same-origin request, then sets as that operator', async () => {
  vi.stubEnv('PRODUCT_METRICS_READS_ENABLED', 'true');
  for (const status of [401, 403]) {
    port.require.mockRejectedValueOnce(new HttpError(status, 'denied'));
    expect((await metricsExclusionHandlers.POST(post())).status).toBe(status);
  }
  port.origin.mockImplementationOnce(() => {
    throw new HttpError(403, 'origin');
  });
  expect((await metricsExclusionHandlers.POST(post())).status).toBe(403);
  expect(port.set).not.toHaveBeenCalled();

  port.require.mockResolvedValue({ id: 'operator-1' });
  port.set.mockResolvedValue({
    id: '11111111-1111-4111-8111-111111111111',
    ...body,
    actorAccountId: 'operator-1',
    recordedAt: '2026-11-13T10:00:00.000Z',
  });
  expect((await metricsExclusionHandlers.POST(post())).status).toBe(201);
  expect(port.require).toHaveBeenCalledWith(true);
  expect(port.limit).toHaveBeenCalledWith('metrics-exclusion:operator-1', 20, 60);
  expect(port.set).toHaveBeenCalledWith(port.tx, { operatorAccountId: 'operator-1', input: body });
});
