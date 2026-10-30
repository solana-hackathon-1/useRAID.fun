import { afterEach, expect, it, vi } from 'vitest';

const port = vi.hoisted(() => ({ tx: {}, close: vi.fn(), pass: vi.fn() }));
vi.mock('../src/lib/db', () => ({ db: {} }));
vi.mock('../src/lib/command-receipts-adapter', () => ({
  runCommandTransaction: async (_db: unknown, work: (tx: object) => unknown) => work(port.tx),
}));
vi.mock('../src/work-loop/closure-storage', () => ({ closeOverdueEngagement: port.close }));
vi.mock('../src/work-loop/closure-pass', () => ({ closeOverdueBatch: port.pass }));
import { workClosureEnabled } from '../src/lib/config';
import {
  closeEngagementFromHost,
  createRootClosureHost,
  runWorkClosureWorker,
} from '../src/lib/work-closure-host';

const actor = { accountId: 'operator-1', sessionHash: 'a'.repeat(64) };
const command = { actor, input: {}, idempotencyKey: 'key-1', requestId: 'req-1' };
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
it('defaults the closure flag off and requires the exact string true', () => {
  for (const value of [undefined, '', 'TRUE', 'false', '1']) {
    if (value === undefined) vi.stubEnv('WORK_CLOSURE_ENABLED', '');
    else vi.stubEnv('WORK_CLOSURE_ENABLED', value);
    expect(workClosureEnabled()).toBe(false);
  }
  vi.stubEnv('WORK_CLOSURE_ENABLED', 'true');
  expect(workClosureEnabled()).toBe(true);
});
it('authorizes only the synthetic operator allowlist and never by Guild id', async () => {
  vi.stubEnv('RAID_WORK_OPERATOR_ACCOUNT_IDS', 'operator-1, operator-2');
  const host = createRootClosureHost(true);
  const tx = {} as never;
  expect(host.allowNewWrites).toBe(true);
  expect(await host.authorize(tx, actor, { engagementId: 'e', guildId: 'any-guild' })).toBe(true);
  expect(
    await host.authorize(
      tx,
      { ...actor, accountId: 'stranger' },
      { engagementId: 'e', guildId: 'g' },
    ),
  ).toBe(false);
  vi.stubEnv('RAID_WORK_OPERATOR_ACCOUNT_IDS', '');
  expect(await host.authorize(tx, actor, { engagementId: 'e', guildId: 'g' })).toBe(false);
});
it('passes the flag to the closure command as the only write switch', async () => {
  port.close.mockResolvedValue({ status: 'EXECUTED' });
  vi.stubEnv('WORK_CLOSURE_ENABLED', '');
  await closeEngagementFromHost(command);
  expect(port.close).toHaveBeenLastCalledWith(
    port.tx,
    command,
    expect.objectContaining({ allowNewWrites: false }),
  );
  vi.stubEnv('WORK_CLOSURE_ENABLED', 'true');
  await closeEngagementFromHost(command);
  expect(port.close).toHaveBeenLastCalledWith(
    port.tx,
    command,
    expect.objectContaining({ allowNewWrites: true }),
  );
});
it('runs no worker pass unless the flag is on and a worker account is configured', async () => {
  vi.stubEnv('WORK_CLOSURE_ENABLED', '');
  vi.stubEnv('WORK_CLOSURE_WORKER_ACCOUNT_ID', 'operator-1');
  expect(await runWorkClosureWorker()).toBeNull();
  vi.stubEnv('WORK_CLOSURE_ENABLED', 'true');
  vi.stubEnv('WORK_CLOSURE_WORKER_ACCOUNT_ID', '');
  expect(await runWorkClosureWorker()).toBeNull();
  expect(port.pass).not.toHaveBeenCalled();
  vi.stubEnv('WORK_CLOSURE_WORKER_ACCOUNT_ID', 'operator-1');
  vi.stubEnv('RAID_WORK_OPERATOR_ACCOUNT_IDS', 'operator-1');
  port.pass.mockResolvedValue({ considered: 0, closed: 0, skipped: [], failed: [] });
  await runWorkClosureWorker();
  expect(port.pass).toHaveBeenCalledTimes(1);
});
it('fails visibly when a pass had failures', async () => {
  vi.stubEnv('WORK_CLOSURE_ENABLED', 'true');
  vi.stubEnv('WORK_CLOSURE_WORKER_ACCOUNT_ID', 'operator-1');
  port.pass.mockResolvedValue({
    considered: 1,
    closed: 0,
    skipped: [],
    failed: [{ engagementId: 'e', code: 'FORBIDDEN' }],
  });
  await expect(runWorkClosureWorker()).rejects.toThrow(/FORBIDDEN/);
});
