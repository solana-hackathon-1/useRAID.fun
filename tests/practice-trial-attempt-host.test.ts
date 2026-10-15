import { afterEach, expect, it, vi } from 'vitest';
const storage = vi.hoisted(() => ({ start: vi.fn(), port: {} }));
vi.mock('../src/skills/practice-trial-attempt-storage', () => ({
  startPracticeTrial: storage.start,
}));
vi.mock('../src/lib/db', () => ({ db: {} }));
vi.mock('../src/lib/command-receipts-adapter', () => ({
  runCommandTransaction: vi.fn(async (_db, work) => work(storage.port)),
}));
import {
  practiceTrialAttemptWriteConfiguration,
  startPracticeTrialFromHost,
} from '../src/lib/practice-trial-attempts-host';
const command = {
  actor: { accountId: 'self', sessionHash: 'a'.repeat(64) },
  input: {},
  idempotencyKey: 'original',
  requestId: 'r',
};
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
it('defaults new practice starts off and accepts only exact true', () => {
  for (const value of [undefined, '', 'false', 'TRUE', '1']) {
    vi.stubEnv('PRACTICE_TRIAL_ATTEMPTS_ENABLED', value);
    expect(practiceTrialAttemptWriteConfiguration()).toEqual({
      writesAvailable: false,
      unavailableReason: 'DISABLED',
    });
  }
  vi.stubEnv('PRACTICE_TRIAL_ATTEMPTS_ENABLED', 'true');
  expect(practiceTrialAttemptWriteConfiguration()).toEqual({
    writesAvailable: true,
    unavailableReason: null,
  });
});
it('passes disabled new-write policy inside the SQL boundary while preserving original replay', async () => {
  vi.stubEnv('PRACTICE_TRIAL_ATTEMPTS_ENABLED', 'false');
  storage.start.mockResolvedValue({ status: 'REPLAYED', start: { id: 'original' } });
  expect(await startPracticeTrialFromHost(command)).toMatchObject({
    version: 'v1',
    status: 'REPLAYED',
    start: { id: 'original' },
    writesAvailable: false,
    unavailableReason: 'DISABLED',
  });
  expect(storage.start).toHaveBeenCalledWith(storage.port, command, { allowNewWrites: false });
});
