import { afterEach, expect, it, vi } from 'vitest';
const port = vi.hoisted(() => ({ tx: {}, read: vi.fn(), require: vi.fn(), limit: vi.fn() }));
vi.mock('../src/lib/db', () => ({ db: {} }));
vi.mock('../src/lib/command-receipts-adapter', () => ({
  runCommandTransaction: async (_db: unknown, work: (tx: object) => unknown) => work(port.tx),
}));
vi.mock('../src/metrics/storage', () => ({ readProductMetrics: port.read }));
vi.mock('../src/lib/auth', () => {
  class HttpError extends Error {
    constructor(
      public status: number,
      message?: string,
    ) {
      super(message ?? 'http');
    }
  }
  return { HttpError, requireUser: port.require, rateLimit: port.limit };
});
import {
  readProductMetricsFromHost,
  productMetricsAvailable,
} from '../src/lib/product-metrics-host';
import { productMetricsHandlers } from '../src/lib/product-metrics-http';
import { HttpError } from '../src/lib/auth';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
const get = () => new Request('http://localhost/api/v1/admin/metrics/product');

it('is closed unless the flag is exactly "true" (and independent of the work-loop flag)', () => {
  for (const value of [undefined, '', 'TRUE', 'false', '1', 'yes']) {
    vi.stubEnv('PRODUCT_METRICS_READS_ENABLED', value);
    expect(productMetricsAvailable()).toBe(false);
  }
  vi.stubEnv('PRODUCT_METRICS_READS_ENABLED', 'false');
  vi.stubEnv('WORK_METRICS_READS_ENABLED', 'true');
  expect(productMetricsAvailable()).toBe(false);
  vi.stubEnv('PRODUCT_METRICS_READS_ENABLED', 'true');
  expect(productMetricsAvailable()).toBe(true);
});
it('refuses to read while closed and reads through one transaction when open', async () => {
  await expect(readProductMetricsFromHost()).rejects.toMatchObject({ code: 'STORAGE_CONTRACT' });
  expect(port.read).not.toHaveBeenCalled();
  vi.stubEnv('PRODUCT_METRICS_READS_ENABLED', 'true');
  port.read.mockResolvedValue({ version: 'v1' });
  expect(await readProductMetricsFromHost()).toEqual({ version: 'v1' });
  expect(port.read).toHaveBeenCalledWith(port.tx);
});
it('is absent with the flag off, and with it on requires the shared administrator rule', async () => {
  expect((await productMetricsHandlers.GET(get())).status).toBe(404);
  expect(port.require).not.toHaveBeenCalled();
  vi.stubEnv('PRODUCT_METRICS_READS_ENABLED', 'true');
  // A signed-out caller, a non-administrator and a throttled operator never reach the read.
  for (const status of [401, 403]) {
    port.require.mockRejectedValueOnce(new HttpError(status, 'denied'));
    expect((await productMetricsHandlers.GET(get())).status).toBe(status);
  }
  port.require.mockResolvedValue({ id: 'operator-1' });
  port.limit.mockRejectedValueOnce(new HttpError(429, 'slow'));
  expect((await productMetricsHandlers.GET(get())).status).toBe(429);
  expect(port.require).toHaveBeenCalledWith(true);
  expect(port.limit).toHaveBeenCalledWith('product-metrics:operator-1', 30, 60);
  expect(port.read).not.toHaveBeenCalled();
});
