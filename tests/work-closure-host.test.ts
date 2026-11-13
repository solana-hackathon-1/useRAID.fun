import { afterEach, expect, it, vi } from 'vitest';

const port = vi.hoisted(() => ({ tx: {}, close: vi.fn(), pass: vi.fn() }));
vi.mock('../src/lib/db', () => ({ db: {} }));
vi.mock('../src/lib/command-receipts-adapter', () => ({
  runCommandTransaction: async (_db: unknown, work: (tx: object) => unknown) => work(port.tx),
}));
vi.mock('../src/work-loop/closure-storage', () => ({ closeOverdueEngagement: port.close }));
vi.mock('../src/work-loop/closure-pass', () => ({ closeOverdueBatch: port.pass }));
import { WorkError } from '../src/work-loop/contracts';
import { workClosureEnabled } from '../src/lib/config';
import {
  closeEngagementFromHost,
  createRootClosureHost,
  runWorkClosureWorker,
  WORK_CLOSURE_REALARM_MS,
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
it('reports a missing worker session once per outage, not on every tick, and again after it recovers', async () => {
  vi.stubEnv('WORK_CLOSURE_ENABLED', 'true');
  vi.stubEnv('WORK_CLOSURE_WORKER_ACCOUNT_ID', 'operator-1');
  const ok = { considered: 0, closed: 0, skipped: [], failed: [] };
  port.pass.mockRejectedValue(new WorkError('UNAUTHENTICATED'));
  await expect(runWorkClosureWorker()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  // The same condition on later ticks fails closed (nothing runs) without another alarm.
  expect(await runWorkClosureWorker()).toBeNull();
  expect(await runWorkClosureWorker()).toBeNull();
  expect(port.pass).toHaveBeenCalledTimes(3);
  port.pass.mockResolvedValue(ok);
  expect(await runWorkClosureWorker()).toEqual(ok);
  port.pass.mockRejectedValue(new WorkError('UNAUTHENTICATED'));
  await expect(runWorkClosureWorker()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  // Any other failure is always surfaced.
  port.pass.mockRejectedValue(new Error('storage down'));
  await expect(runWorkClosureWorker()).rejects.toThrow('storage down');
  port.pass.mockResolvedValue(ok);
  await runWorkClosureWorker();
});
it('re-raises a persistent missing worker session at a bounded interval so a lost log line cannot hide the outage', async () => {
  vi.stubEnv('WORK_CLOSURE_ENABLED', 'true');
  vi.stubEnv('WORK_CLOSURE_WORKER_ACCOUNT_ID', 'operator-1');
  const ok = { considered: 0, closed: 0, skipped: [], failed: [] };
  let now = 1_000_000;
  const clock = () => now;
  port.pass.mockResolvedValueOnce(ok);
  await runWorkClosureWorker(clock);
  port.pass.mockRejectedValue(new WorkError('UNAUTHENTICATED'));
  await expect(runWorkClosureWorker(clock)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  // Within the interval every tick stays quiet and fails closed.
  now += WORK_CLOSURE_REALARM_MS - 1;
  expect(await runWorkClosureWorker(clock)).toBeNull();
  // At the interval the same outage is raised again, then quiet for another interval.
  now += 1;
  await expect(runWorkClosureWorker(clock)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  now += WORK_CLOSURE_REALARM_MS - 1;
  expect(await runWorkClosureWorker(clock)).toBeNull();
  now += 1;
  await expect(runWorkClosureWorker(clock)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  // Every tick still ran the pass, which is what fails closed.
  expect(port.pass).toHaveBeenCalledTimes(6);
  port.pass.mockResolvedValue(ok);
  expect(await runWorkClosureWorker(clock)).toEqual(ok);
});
it('raises one operator alert per stuck engagement with code and counts only', async () => {
  vi.stubEnv('WORK_CLOSURE_ENABLED', 'true');
  vi.stubEnv('WORK_CLOSURE_WORKER_ACCOUNT_ID', 'operator-1');
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  port.pass.mockResolvedValue({
    considered: 1,
    closed: 0,
    skipped: [],
    failed: [{ engagementId: 'e1', code: 'FORBIDDEN' }],
    stuck: [{ engagementId: 'e1', code: 'FORBIDDEN', failures: 10 }],
  });
  await expect(runWorkClosureWorker()).rejects.toThrow(/FORBIDDEN/);
  const alerts = log.mock.calls
    .map(([line]) => JSON.parse(String(line)))
    .filter((l) => l.alert === 'work-closure-stuck');
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toMatchObject({ engagementId: 'e1', code: 'FORBIDDEN', failures: 10 });
  expect(JSON.stringify(alerts[0])).not.toMatch(/message|stack/);
  log.mockRestore();
});
