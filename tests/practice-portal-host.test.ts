import { afterEach, expect, it, vi } from 'vitest';
const port = vi.hoisted(() => ({
  tx: {},
  list: vi.fn(),
  read: vi.fn(),
  start: vi.fn(),
  submit: vi.fn(),
}));
vi.mock('../src/lib/db', () => ({ db: {} }));
vi.mock('../src/lib/command-receipts-adapter', () => ({
  runCommandTransaction: async (_db: unknown, work: (tx: object) => unknown) => work(port.tx),
}));
vi.mock('../src/skills/practice-portal-storage', () => ({
  listOwnPracticeTrials: port.list,
  readOwnPracticeTrialProgress: port.read,
}));
vi.mock('../src/skills/practice-trial-attempt-storage', () => ({ startPracticeTrial: port.start }));
vi.mock('../src/skills/practice-trial-submission-storage', () => ({
  submitPracticeTrial: port.submit,
}));
import {
  practicePortalReadConfiguration,
  listPracticeTrialsFromHost,
  readPracticeProgressFromHost,
  startPracticeTrialFromPortal,
  submitPracticeTrialFromPortal,
} from '../src/lib/practice-portal-host';
const actor = { accountId: 'owner', sessionHash: 'a'.repeat(64) };
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
function enabled() {
  vi.stubEnv('PRACTICE_PORTAL_READS_ENABLED', 'true');
  vi.stubEnv('PRACTICE_TRIAL_CATALOG_ID', 'catalog');
}
it('defaults reads off and requires explicit valid trusted trial namespace', () => {
  for (const v of [undefined, '', 'TRUE', 'false', '1']) {
    vi.stubEnv('PRACTICE_PORTAL_READS_ENABLED', v);
    expect(practicePortalReadConfiguration()).toMatchObject({ readsAvailable: false });
  }
  enabled();
  expect(practicePortalReadConfiguration()).toMatchObject({ readsAvailable: true });
  vi.stubEnv('PRACTICE_TRIAL_CATALOG_ID', ' bad ');
  expect(practicePortalReadConfiguration()).toMatchObject({ readsAvailable: false });
});
it('never selects private data while read gate closed', async () => {
  await expect(readPracticeProgressFromHost(actor, 'id')).rejects.toMatchObject({
    code: 'STORAGE_UNAVAILABLE',
  });
  expect(port.read).not.toHaveBeenCalled();
});
it('binds discovery to current namespace and rejects delivery after namespace changes', async () => {
  enabled();
  port.list.mockImplementation(
    async (_tx: unknown, a: unknown, input: unknown, canRead: () => boolean) => {
      expect(a).toEqual(actor);
      expect(input).toEqual({ version: 'v1', taxonomyId: 'catalog', after: 'trial' });
      expect(canRead()).toBe(true);
      vi.stubEnv('PRACTICE_TRIAL_CATALOG_ID', 'other');
      expect(canRead()).toBe(false);
      return { private: true };
    },
  );
  await expect(listPracticeTrialsFromHost(actor, 'trial')).rejects.toMatchObject({
    code: 'STORAGE_UNAVAILABLE',
  });
});
it('preserves own accepted history independent of current namespace while current own read remains authorized', async () => {
  enabled();
  const value = { own: true };
  port.read.mockResolvedValue(value);
  expect(await readPracticeProgressFromHost(actor, 'id')).toBe(value);
  expect(port.read.mock.calls[0].slice(0, 3)).toEqual([port.tx, actor, 'id']);
});
it('start namespace/current-write callback binds actual locked source, replay still enters original command after writeoff', async () => {
  enabled();
  vi.stubEnv('PRACTICE_TRIAL_ATTEMPTS_ENABLED', 'true');
  port.start.mockImplementation(
    async (
      _tx: unknown,
      _command: unknown,
      o: {
        allowNewWrites: boolean;
        canStart: (scope: { taxonomyId: string }) => boolean;
        canSubmit: () => boolean;
      },
    ) => {
      expect(o.allowNewWrites).toBe(true);
      expect(o.canStart({ taxonomyId: 'catalog' })).toBe(true);
      expect(o.canStart({ taxonomyId: 'other' })).toBe(false);
      vi.stubEnv('PRACTICE_TRIAL_ATTEMPTS_ENABLED', 'false');
      expect(o.canStart({ taxonomyId: 'catalog' })).toBe(false);
      return { status: 'EXECUTED', start: { id: 'id' } };
    },
  );
  const c = { actor, input: {}, idempotencyKey: 'k', requestId: 'r' };
  expect(await startPracticeTrialFromPortal(c)).toMatchObject({
    writesAvailable: false,
    unavailableReason: 'DISABLED',
  });
  port.start.mockResolvedValue({ status: 'REPLAYED', start: { id: 'id' } });
  expect(await startPracticeTrialFromPortal(c)).toMatchObject({
    status: 'REPLAYED',
    writesAvailable: false,
  });
  expect(port.start.mock.calls[1][2].allowNewWrites).toBe(false);
});
it('submission current write callback closes after writeoff without restricting original definition namespace', async () => {
  enabled();
  vi.stubEnv('PRACTICE_TRIAL_SUBMISSIONS_ENABLED', 'true');
  port.submit.mockImplementation(
    async (
      _tx: unknown,
      _command: unknown,
      o: {
        allowNewWrites: boolean;
        canStart: (scope: { taxonomyId: string }) => boolean;
        canSubmit: () => boolean;
      },
    ) => {
      expect(o.canSubmit()).toBe(true);
      vi.stubEnv('PRACTICE_TRIAL_SUBMISSIONS_ENABLED', 'false');
      expect(o.canSubmit()).toBe(false);
      return { status: 'REPLAYED', submission: { id: 'id' } };
    },
  );
  expect(
    await submitPracticeTrialFromPortal({ actor, input: {}, idempotencyKey: 'k', requestId: 'r' }),
  ).toMatchObject({ status: 'REPLAYED', writesAvailable: false });
});
it('drops private command delivery if read gate closes afterCOMMIT without inventing failure/noeffect semantics', async () => {
  enabled();
  port.start.mockImplementation(async () => {
    vi.stubEnv('PRACTICE_PORTAL_READS_ENABLED', 'false');
    return { status: 'EXECUTED', start: { id: 'private' } };
  });
  await expect(
    startPracticeTrialFromPortal({ actor, input: {}, idempotencyKey: 'k', requestId: 'r' }),
  ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
});
