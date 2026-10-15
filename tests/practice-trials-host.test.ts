import { afterEach, expect, it, vi } from 'vitest';
const storage = vi.hoisted(() => ({ publish: vi.fn(), port: {} }));
vi.mock('../src/skills/practice-trial-storage', () => ({
  publishPracticeTrialDefinition: storage.publish,
}));
vi.mock('../src/lib/db', () => ({ db: {} }));
vi.mock('../src/lib/command-receipts-adapter', () => ({
  runCommandTransaction: vi.fn(async (_db, work) => work(storage.port)),
}));
import {
  practiceTrialWriteConfiguration,
  publishPracticeTrialFromHost,
} from '../src/lib/practice-trials-host';
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
it('defaults practice publication off and permits only exact true', () => {
  for (const value of [undefined, '', 'false', 'TRUE', '1']) {
    vi.stubEnv('PRACTICE_TRIAL_PUBLICATION_ENABLED', value);
    expect(practiceTrialWriteConfiguration()).toEqual({
      writesAvailable: false,
      unavailableReason: 'DISABLED',
    });
  }
  vi.stubEnv('PRACTICE_TRIAL_PUBLICATION_ENABLED', 'true');
  expect(practiceTrialWriteConfiguration()).toEqual({
    writesAvailable: true,
    unavailableReason: null,
  });
});
it('passes disabled new-write policy inside SQL while retaining authorized original replay', async () => {
  vi.stubEnv('PRACTICE_TRIAL_PUBLICATION_ENABLED', 'false');
  storage.publish.mockResolvedValue({
    status: 'REPLAYED',
    trial: { definition: { reference: { recordId: 'original', revision: 1 } } },
  });
  expect(await publishPracticeTrialFromHost(command)).toMatchObject({
    version: 'v1',
    status: 'REPLAYED',
    writesAvailable: false,
    unavailableReason: 'DISABLED',
  });
  expect(storage.publish).toHaveBeenCalledWith(storage.port, command, {
    allowNewWrites: false,
    canPublish: expect.any(Function),
  });
});
it('reevaluates actual X allowlist from locked facts and denies Studio-only privilege', async () => {
  vi.stubEnv('X_ADMIN_USER_ID', ' actual-x ');
  vi.stubEnv('ADMIN_X_IDS', ' another-x ');
  storage.publish.mockImplementation(async (_tx, _cmd, options) => {
    const actor = { accountId: 'self', xId: 'actual-x' };
    expect(options.canPublish(actor)).toBe(true);
    expect(options.canPublish({ ...actor, xId: 'another-x' })).toBe(true);
    expect(options.canPublish({ ...actor, xId: 'studio-only' })).toBe(false);
    vi.stubEnv('X_ADMIN_USER_ID', '');
    expect(options.canPublish(actor)).toBe(false);
    return { status: 'REPLAYED', trial: {} };
  });
  await publishPracticeTrialFromHost(command);
});
