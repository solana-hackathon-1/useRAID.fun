import { afterEach, expect, it, vi } from 'vitest';
const port = vi.hoisted(() => ({ tx: {}, read: vi.fn() }));
vi.mock('../src/lib/db', () => ({ db: {} }));
vi.mock('../src/lib/command-receipts-adapter', () => ({
  runCommandTransaction: async (_db: unknown, work: (tx: object) => unknown) => work(port.tx),
}));
vi.mock('../src/work-loop/metrics-storage', () => ({ readWorkMetrics: port.read }));
import { readMetricsFromHost, workMetricsAvailable } from '../src/lib/work-metrics-host';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
it('is closed unless the flag is exactly "true"', () => {
  for (const value of [undefined, '', 'TRUE', 'false', '1', 'yes']) {
    vi.stubEnv('WORK_METRICS_READS_ENABLED', value);
    expect(workMetricsAvailable()).toBe(false);
  }
  vi.stubEnv('WORK_METRICS_READS_ENABLED', 'true');
  expect(workMetricsAvailable()).toBe(true);
});
it('refuses to read while closed and reads through one transaction when open', async () => {
  await expect(readMetricsFromHost()).rejects.toMatchObject({ code: 'STORAGE_CONTRACT' });
  expect(port.read).not.toHaveBeenCalled();
  vi.stubEnv('WORK_METRICS_READS_ENABLED', 'true');
  port.read.mockResolvedValue({ version: 'v1' });
  expect(await readMetricsFromHost()).toEqual({ version: 'v1' });
  expect(port.read).toHaveBeenCalledWith(port.tx);
});
