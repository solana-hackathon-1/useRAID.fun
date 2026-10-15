import { afterEach, expect, it, vi } from 'vitest';
const storage = vi.hoisted(() => ({
  publish: vi.fn(),
  admin: vi.fn(),
  use: vi.fn(),
  observe: vi.fn(),
  port: {},
  admins: ['allowed-x'],
}));
vi.mock('../src/skills/practice-review-policy-storage', () => ({
  publishPracticeReviewPolicy: storage.publish,
  readPracticeReviewPolicyAsAdmin: storage.admin,
  lockApprovedPracticeReviewPolicy: storage.use,
  observeApprovedPracticeReviewPolicy: storage.observe,
}));
vi.mock('../src/lib/db', () => ({ db: {} }));
vi.mock('../src/lib/admins', () => ({ adminXIds: () => storage.admins }));
vi.mock('../src/lib/command-receipts-adapter', () => ({
  runCommandTransaction: vi.fn(async (_db, work) => work(storage.port)),
}));
vi.mock('../src/lib/practice-review-reads-host', () => ({
  practiceReviewReadConfiguration: () => ({
    readsAvailable: process.env.PRACTICE_REVIEW_READS_ENABLED === 'true',
    unavailableReason: process.env.PRACTICE_REVIEW_READS_ENABLED === 'true' ? null : 'DISABLED',
  }),
}));
import {
  practiceReviewPolicyWriteConfiguration,
  publishPracticeReviewPolicyFromHost,
  readPracticeReviewPolicyAsAdminFromHost,
  readApprovedPracticeReviewPolicyFromHost,
  observeApprovedPracticeReviewPolicyFromHost,
} from '../src/lib/practice-review-policies-host';
const actor = { accountId: 'a', sessionHash: 'a'.repeat(64) },
  command = { actor, input: {}, idempotencyKey: 'original', requestId: 'r' };
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  storage.admins = ['allowed-x'];
});
it('defaults new policy publication off and accepts only exact true', () => {
  for (const v of [undefined, '', 'false', 'TRUE', '1']) {
    vi.stubEnv('PRACTICE_REVIEW_POLICY_PUBLICATION_ENABLED', v);
    expect(practiceReviewPolicyWriteConfiguration()).toEqual({
      writesAvailable: false,
      unavailableReason: 'DISABLED',
    });
  }
  vi.stubEnv('PRACTICE_REVIEW_POLICY_PUBLICATION_ENABLED', 'true');
  expect(practiceReviewPolicyWriteConfiguration()).toEqual({
    writesAvailable: true,
    unavailableReason: null,
  });
});
it('preserves original publication receipt composition when off, using current X-admin scope', async () => {
  vi.stubEnv('PRACTICE_REVIEW_POLICY_PUBLICATION_ENABLED', 'false');
  storage.publish.mockResolvedValue({ status: 'REPLAYED', policy: { id: 'original' } });
  expect(await publishPracticeReviewPolicyFromHost(command)).toMatchObject({
    version: 'v1',
    status: 'REPLAYED',
    writesAvailable: false,
  });
  const [port, c, opts] = storage.publish.mock.calls[0];
  expect(port).toBe(storage.port);
  expect(c).toBe(command);
  expect(opts.allowNewWrites).toBe(false);
  expect(opts.canPublish({ xId: 'allowed-x' })).toBe(true);
  storage.admins = [];
  expect(opts.canPublish({ xId: 'allowed-x' })).toBe(false);
});
it('keeps current scoped admin history reads independent from publication flag', async () => {
  vi.stubEnv('PRACTICE_REVIEW_POLICY_PUBLICATION_ENABLED', 'false');
  storage.admin.mockResolvedValue(null);
  expect(await readPracticeReviewPolicyAsAdminFromHost(actor, 'p', 1)).toMatchObject({
    version: 'v1',
    view: null,
  });
  const [port, a, id, rev, canPublish] = storage.admin.mock.calls[0];
  expect(port).toBe(storage.port);
  expect(a).toBe(actor);
  expect(id).toBe('p');
  expect(rev).toBe(1);
  expect(canPublish({ xId: 'allowed-x' })).toBe(true);
  expect(canPublish({ xId: 'unknown-x' })).toBe(false);
});
it('uses current defaultoff case-read configuration for policy lookup and never returns a view after disablement', async () => {
  vi.stubEnv('PRACTICE_REVIEW_READS_ENABLED', 'false');
  const lookupRequest = {};
  storage.use.mockResolvedValue(null);
  expect(await readApprovedPracticeReviewPolicyFromHost(actor, lookupRequest)).toMatchObject({
    version: 'v1',
    view: null,
    readsAvailable: false,
  });
  const [port, a, body, canUse] = storage.use.mock.calls[0];
  expect(port).toBe(storage.port);
  expect(a).toBe(actor);
  expect(body).toBe(lookupRequest);
  expect(canUse({})).toBe(false);
  vi.stubEnv('PRACTICE_REVIEW_READS_ENABLED', 'true');
  expect(canUse({})).toBe(true);
  storage.use.mockImplementation(async () => {
    vi.stubEnv('PRACTICE_REVIEW_READS_ENABLED', 'false');
    return { private: true, policy: { guidance: 'synthetic-private-marker' } };
  });
  const r = await readApprovedPracticeReviewPolicyFromHost(actor, {});
  expect(r).toMatchObject({ view: null, readsAvailable: false });
  expect(JSON.stringify(r)).not.toContain('synthetic-private-marker');
});

it('composes current scoped observation without a guessed client policy reference', async () => {
  vi.stubEnv('PRACTICE_REVIEW_READS_ENABLED', 'false');
  storage.observe.mockResolvedValue(null);
  const input = {
    version: 'v1',
    assignmentId: 'opaque',
    submissionId: 'opaque',
    purpose: 'OWNERSHIP_REVIEW',
  };
  expect(await observeApprovedPracticeReviewPolicyFromHost(actor, input)).toMatchObject({
    view: null,
    readsAvailable: false,
  });
  const [port, a, body, canUse] = storage.observe.mock.calls[0];
  expect(port).toBe(storage.port);
  expect(a).toBe(actor);
  expect(body).toBe(input);
  expect(canUse({})).toBe(false);
  vi.stubEnv('PRACTICE_REVIEW_READS_ENABLED', 'true');
  expect(canUse({})).toBe(true);
});
