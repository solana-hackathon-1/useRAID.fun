import { afterEach, expect, it, vi } from 'vitest';
const storage = vi.hoisted(() => ({ read: vi.fn(), port: {} }));
vi.mock('../src/skills/practice-review-read-storage', () => ({
  readPracticeTrialForReview: storage.read,
}));
vi.mock('../src/lib/db', () => ({ db: {} }));
vi.mock('../src/lib/command-receipts-adapter', () => ({
  runCommandTransaction: vi.fn(async (_db, work) => work(storage.port)),
}));
import {
  practiceReviewReadConfiguration,
  readPracticeTrialForReviewFromHost,
} from '../src/lib/practice-review-reads-host';
const actor = { accountId: 'a', sessionHash: 'a'.repeat(64) },
  input = {
    version: 'v1',
    assignmentId: 'opaque',
    submissionId: 'opaque',
    purpose: 'OWNERSHIP_REVIEW',
  };
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
it('defaults private review reads off and accepts only exact true', () => {
  for (const value of [undefined, '', 'false', 'TRUE', '1']) {
    vi.stubEnv('PRACTICE_REVIEW_READS_ENABLED', value);
    expect(practiceReviewReadConfiguration()).toEqual({
      readsAvailable: false,
      unavailableReason: 'DISABLED',
    });
  }
  vi.stubEnv('PRACTICE_REVIEW_READS_ENABLED', 'true');
  expect(practiceReviewReadConfiguration()).toEqual({
    readsAvailable: true,
    unavailableReason: null,
  });
});
it('composes current guarded transaction/actor/scope and current read flag policy', async () => {
  vi.stubEnv('PRACTICE_REVIEW_READS_ENABLED', 'false');
  storage.read.mockResolvedValue(null);
  expect(await readPracticeTrialForReviewFromHost(actor, input)).toEqual({
    version: 'v1',
    review: null,
    readsAvailable: false,
    unavailableReason: 'DISABLED',
  });
  const [port, a, scope, canRead] = storage.read.mock.calls[0];
  expect(port).toBe(storage.port);
  expect(a).toBe(actor);
  expect(scope).toBe(input);
  expect(canRead({})).toBe(false);
  vi.stubEnv('PRACTICE_REVIEW_READS_ENABLED', 'true');
  expect(canRead({})).toBe(true);
});
it('does not return a private result if the read flag turns off after the module returns', async () => {
  vi.stubEnv('PRACTICE_REVIEW_READS_ENABLED', 'true');
  storage.read.mockImplementation(async () => {
    vi.stubEnv('PRACTICE_REVIEW_READS_ENABLED', 'false');
    return { private: true, answer: 'synthetic-private-marker' };
  });
  const r = await readPracticeTrialForReviewFromHost(actor, input);
  expect(r).toMatchObject({ review: null, readsAvailable: false });
  expect(JSON.stringify(r)).not.toContain('synthetic-private-marker');
});
