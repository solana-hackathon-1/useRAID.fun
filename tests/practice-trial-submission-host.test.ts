import { afterEach, expect, it, vi } from 'vitest';
const storage = vi.hoisted(() => ({ submit: vi.fn(), port: {} }));
vi.mock('../src/skills/practice-trial-submission-storage', () => ({
  submitPracticeTrial: storage.submit,
}));
vi.mock('../src/lib/db', () => ({ db: {} }));
vi.mock('../src/lib/command-receipts-adapter', () => ({
  runCommandTransaction: vi.fn(async (_db, work) => work(storage.port)),
}));
import {
  practiceTrialSubmissionWriteConfiguration,
  submitPracticeTrialFromHost,
} from '../src/lib/practice-trial-submissions-host';
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
it('defaults new private submissions off and accepts only exact true', () => {
  for (const value of [undefined, '', 'false', 'TRUE', '1']) {
    vi.stubEnv('PRACTICE_TRIAL_SUBMISSIONS_ENABLED', value);
    expect(practiceTrialSubmissionWriteConfiguration()).toEqual({
      writesAvailable: false,
      unavailableReason: 'DISABLED',
    });
  }
  vi.stubEnv('PRACTICE_TRIAL_SUBMISSIONS_ENABLED', 'true');
  expect(practiceTrialSubmissionWriteConfiguration()).toEqual({
    writesAvailable: true,
    unavailableReason: null,
  });
});
it('passes disabled new-write policy inside SQL and preserves authorized original replay', async () => {
  vi.stubEnv('PRACTICE_TRIAL_SUBMISSIONS_ENABLED', 'false');
  storage.submit.mockResolvedValue({
    status: 'REPLAYED',
    submission: { reference: { recordId: 'original', revision: 1 } },
  });
  expect(await submitPracticeTrialFromHost(command)).toMatchObject({
    version: 'v1',
    status: 'REPLAYED',
    writesAvailable: false,
    unavailableReason: 'DISABLED',
  });
  expect(storage.submit).toHaveBeenCalledWith(storage.port, command, { allowNewWrites: false });
});
