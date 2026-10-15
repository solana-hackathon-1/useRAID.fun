import { afterEach, expect, it, vi } from 'vitest';
const storage = vi.hoisted(() => ({
  issue: vi.fn(),
  revoke: vi.fn(),
  port: {},
  admins: ['allowed-x'],
}));
vi.mock('../src/skills/practice-review-assignment-storage', () => ({
  issuePracticeReviewAssignment: storage.issue,
  revokePracticeReviewAssignment: storage.revoke,
}));
vi.mock('../src/lib/db', () => ({ db: {} }));
vi.mock('../src/lib/admins', () => ({ adminXIds: () => storage.admins }));
vi.mock('../src/lib/command-receipts-adapter', () => ({
  runCommandTransaction: vi.fn(async (_db, work) => work(storage.port)),
}));
import {
  practiceReviewAssignmentWriteConfiguration,
  issuePracticeReviewAssignmentFromHost,
  revokePracticeReviewAssignmentFromHost,
} from '../src/lib/practice-review-assignments-host';
const command = {
  actor: { accountId: 'a', sessionHash: 'a'.repeat(64) },
  input: {},
  idempotencyKey: 'key',
  requestId: 'r',
};
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  storage.admins = ['allowed-x'];
});
it('defaults management new writes off and accepts only exact true', () => {
  for (const value of [undefined, '', 'false', 'TRUE', '1']) {
    vi.stubEnv('PRACTICE_REVIEW_ASSIGNMENTS_ENABLED', value);
    expect(practiceReviewAssignmentWriteConfiguration()).toEqual({
      writesAvailable: false,
      unavailableReason: 'DISABLED',
    });
  }
  vi.stubEnv('PRACTICE_REVIEW_ASSIGNMENTS_ENABLED', 'true');
  expect(practiceReviewAssignmentWriteConfiguration()).toEqual({
    writesAvailable: true,
    unavailableReason: null,
  });
});
it.each([
  ['issue', issuePracticeReviewAssignmentFromHost],
  ['revoke', revokePracticeReviewAssignmentFromHost],
] as const)(
  'composes current X-admin host policy for %s and preserves original receipts when off',
  async (kind, fn) => {
    vi.stubEnv('PRACTICE_REVIEW_ASSIGNMENTS_ENABLED', 'false');
    storage[kind].mockResolvedValue({ status: 'REPLAYED' });
    expect(await fn(command)).toMatchObject({
      version: 'v1',
      status: 'REPLAYED',
      writesAvailable: false,
    });
    const [port, c, options] = storage[kind].mock.calls[0];
    expect(port).toBe(storage.port);
    expect(c).toBe(command);
    expect(options.allowNewWrites).toBe(false);
    expect(options.canManage({ xId: 'allowed-x' })).toBe(true);
    expect(options.canManage({ xId: 'other-x' })).toBe(false);
    storage.admins = [];
    expect(options.canManage({ xId: 'allowed-x' })).toBe(false);
  },
);
