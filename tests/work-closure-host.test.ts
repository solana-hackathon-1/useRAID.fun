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

import { WORK_CLOSURE_PRINCIPAL } from '../src/work-loop/closure-contracts';

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
it('authorizes the service principal for the Root host without the operator allowlist, and no other principal', async () => {
  vi.stubEnv('RAID_WORK_OPERATOR_ACCOUNT_IDS', '');
  const host = createRootClosureHost(true);
  const target = { engagementId: 'e', guildId: 'g' };
  expect(await host.authorize({} as never, { principal: WORK_CLOSURE_PRINCIPAL }, target)).toBe(
    true,
  );
  expect(await host.authorize({} as never, { principal: 'other' as never }, target)).toBe(false);
});
it('checks an actor with an account against the operator allowlist even if it also carries a principal key', async () => {
  vi.stubEnv('RAID_WORK_OPERATOR_ACCOUNT_IDS', 'operator-1');
  const host = createRootClosureHost(true);
  const target = { engagementId: 'e', guildId: 'g' };
  const spoof = (accountId: string) =>
    ({ accountId, sessionHash: 'a'.repeat(64), principal: WORK_CLOSURE_PRINCIPAL }) as never;
  expect(await host.authorize({} as never, spoof('stranger'), target)).toBe(false);
  expect(await host.authorize({} as never, spoof('operator-1'), target)).toBe(true);
});
it('runs no worker pass unless the flag is on, and needs no worker account (retired)', async () => {
  vi.stubEnv('WORK_CLOSURE_ENABLED', '');
  expect(await runWorkClosureWorker()).toBeNull();
  expect(port.pass).not.toHaveBeenCalled();
  vi.stubEnv('WORK_CLOSURE_ENABLED', 'true');
  port.pass.mockResolvedValue({ considered: 0, closed: 0, skipped: [], failed: [] });
  await runWorkClosureWorker();
  expect(port.pass).toHaveBeenCalledTimes(1);
  // The retired setting is ignored: it neither enables a pass nor names an account the pass acts as.
  vi.stubEnv('WORK_CLOSURE_WORKER_ACCOUNT_ID', 'operator-1');
  await runWorkClosureWorker();
  const ports = port.pass.mock.calls[1][0] as Record<string, unknown>;
  expect(ports).not.toHaveProperty('workerAccountId');
  expect(JSON.stringify(ports)).not.toContain('operator-1');
});
it('fails visibly when a pass had failures', async () => {
  vi.stubEnv('WORK_CLOSURE_ENABLED', 'true');
  port.pass.mockResolvedValue({
    considered: 1,
    closed: 0,
    skipped: [],
    failed: [{ engagementId: 'e', code: 'FORBIDDEN' }],
  });
  await expect(runWorkClosureWorker()).rejects.toThrow(/FORBIDDEN/);
});
it('surfaces a pass that throws on every tick, with no session outage state to hide it', async () => {
  vi.stubEnv('WORK_CLOSURE_ENABLED', 'true');
  port.pass.mockRejectedValue(new Error('storage down'));
  await expect(runWorkClosureWorker()).rejects.toThrow('storage down');
  await expect(runWorkClosureWorker()).rejects.toThrow('storage down');
});
it('passes the pass a value-free logger that adds correlation fields, and logs no stuck alert after the pass (#460)', async () => {
  vi.stubEnv('WORK_CLOSURE_ENABLED', 'true');
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  port.pass.mockResolvedValue({
    considered: 1,
    closed: 0,
    skipped: [],
    failed: [{ engagementId: 'e1', code: 'FORBIDDEN' }],
    stuck: [{ engagementId: 'e1', code: 'FORBIDDEN', failures: 10 }],
  });
  // One summary line for the failure; the stuck alert is the pass's own, raised when it happens.
  await expect(runWorkClosureWorker()).rejects.toThrow(/FORBIDDEN/);
  expect(log).not.toHaveBeenCalled();
  const pass = port.pass.mock.calls[0][0] as { log: (line: Record<string, unknown>) => void };
  pass.log({ alert: 'work-closure-stuck', engagementId: 'e1', code: 'X', failures: 10 });
  pass.log({ event: 'work-closure-backoff-unrecorded', engagementId: 'e2', code: 'Y' });
  const lines = log.mock.calls.map(([line]) => JSON.parse(String(line)));
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatchObject({ alert: 'work-closure-stuck', engagementId: 'e1', failures: 10 });
  expect(lines[1]).toMatchObject({ event: 'work-closure-backoff-unrecorded', engagementId: 'e2' });
  expect(JSON.stringify(lines)).not.toMatch(/message|stack/);
  log.mockRestore();
});
