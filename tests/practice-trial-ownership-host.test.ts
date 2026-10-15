import { afterEach, expect, it, vi } from 'vitest';
const storage = vi.hoisted(() => ({ record: vi.fn(), read: vi.fn(), port: {} }));
vi.mock('../src/skills/practice-trial-ownership-storage', () => ({
  recordPracticeTrialOwnership: storage.record,
  readPracticeTrialOwnership: storage.read,
}));
vi.mock('../src/lib/db', () => ({ db: {} }));
vi.mock('../src/lib/command-receipts-adapter', () => ({
  runCommandTransaction: vi.fn(async (_db, work) => work(storage.port)),
}));
import {
  practiceTrialOwnershipWriteConfiguration,
  recordPracticeTrialOwnershipFromHost,
  readPracticeTrialOwnershipFromHost,
} from '../src/lib/practice-trial-ownership-host';
const actor = { accountId: 'synthetic', sessionHash: 'a'.repeat(64) },
  command = { actor, input: {}, idempotencyKey: 'original', requestId: 'r' };
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
it('defaults writes off and accepts only exact true', () => {
  for (const v of [undefined, '', 'false', 'TRUE', '1']) {
    vi.stubEnv('PRACTICE_TRIAL_OWNERSHIP_ENABLED', v);
    expect(practiceTrialOwnershipWriteConfiguration()).toEqual({
      writesAvailable: false,
      unavailableReason: 'DISABLED',
    });
  }
  vi.stubEnv('PRACTICE_TRIAL_OWNERSHIP_ENABLED', 'true');
  expect(practiceTrialOwnershipWriteConfiguration()).toEqual({
    writesAvailable: true,
    unavailableReason: null,
  });
});
it('composes original retry when off and dynamic read/policy/write scope without granting permissions', async () => {
  vi.stubEnv('PRACTICE_REVIEW_READS_ENABLED', 'true');
  vi.stubEnv('PRACTICE_TRIAL_OWNERSHIP_ENABLED', 'false');
  storage.record.mockResolvedValue({ status: 'REPLAYED', view: { id: 'original' } });
  expect(await recordPracticeTrialOwnershipFromHost(command)).toMatchObject({
    status: 'REPLAYED',
    writesAvailable: false,
  });
  const [port, c, o] = storage.record.mock.calls[0];
  expect(port).toBe(storage.port);
  expect(c).toBe(command);
  expect(o.allowNewWrites).toBe(false);
  expect(o.canReview({})).toBe(false);
  expect(o.canRead({})).toBe(true);
  expect(o.canUsePolicy({})).toBe(true);
  vi.stubEnv('PRACTICE_REVIEW_READS_ENABLED', 'false');
  expect(o.canRead({})).toBe(false);
  expect(o.canUsePolicy({})).toBe(false);
  vi.stubEnv('PRACTICE_TRIAL_OWNERSHIP_ENABLED', 'true');
  expect(o.canReview({})).toBe(false);
  vi.stubEnv('PRACTICE_REVIEW_READS_ENABLED', 'true');
  expect(o.canReview({})).toBe(true);
});
it('uses actual scoped module for private history independent of new writes and drops result if read flag changes before delivery', async () => {
  vi.stubEnv('PRACTICE_REVIEW_READS_ENABLED', 'true');
  const body = { id: 'synthetic' };
  storage.read.mockImplementation(async (_tx, a, input, canRead) => {
    expect(a).toBe(actor);
    expect(input).toBe(body);
    expect(canRead({})).toBe(true);
    vi.stubEnv('PRACTICE_REVIEW_READS_ENABLED', 'false');
    expect(canRead({})).toBe(false);
    return { private: true };
  });
  expect(await readPracticeTrialOwnershipFromHost(actor, body)).toMatchObject({
    view: null,
    readsAvailable: false,
  });
  expect(storage.read.mock.calls[0][0]).toBe(storage.port);
});
it('drops command private result if reads close before commit/delivery without retrying a committed business outcome', async () => {
  vi.stubEnv('PRACTICE_REVIEW_READS_ENABLED', 'true');
  storage.record.mockImplementation(async () => {
    vi.stubEnv('PRACTICE_REVIEW_READS_ENABLED', 'false');
    return { status: 'EXECUTED', view: { private: true } };
  });
  expect(await recordPracticeTrialOwnershipFromHost(command)).toMatchObject({
    status: 'EXECUTED',
    view: null,
    readsAvailable: false,
  });
  expect(storage.record).toHaveBeenCalledTimes(1);
});
