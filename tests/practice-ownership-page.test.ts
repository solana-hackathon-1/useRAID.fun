import { beforeEach, expect, it, vi } from 'vitest';
const ports = vi.hoisted(() => ({
  actor: vi.fn(),
  rateLimit: vi.fn(),
  read: vi.fn(),
  enabled: true,
  writes: true,
  tx: {},
}));
vi.mock('../src/lib/practice-ownership-http', () => ({
  practiceOwnershipHttpHost: { actor: ports.actor, rateLimit: ports.rateLimit },
}));
vi.mock('../src/lib/db', () => ({ db: {} }));
vi.mock('../src/lib/command-receipts-adapter', () => ({
  runCommandTransaction: async (_db: unknown, work: (tx: unknown) => unknown) => work(ports.tx),
}));
vi.mock('../src/lib/practice-review-reads-host', () => ({
  practiceReviewReadConfiguration: () => ({ readsAvailable: ports.enabled }),
}));
vi.mock('../src/lib/practice-trial-ownership-host', () => ({
  practiceTrialOwnershipWriteConfiguration: () => ({ writesAvailable: ports.writes }),
}));
vi.mock('../src/skills/practice-ownership-context', async (original) => ({
  ...(await original<object>()),
  readPracticeOwnershipContext: ports.read,
}));
import { loadPracticeOwnershipPage } from '../src/lib/practice-ownership-page';
import { PracticeOwnershipHttpError } from '../src/skills/practice-ownership-http';
import { ownershipContextFixture as context } from './helpers/practice-ownership-view-fixture';
const path = {
  assignmentId: context.review.assignment.id,
  submissionId: context.review.submission.reference.recordId,
};
const actor = {
  accountId: context.review.assignment.evaluatorAccountId,
  sessionHash: 'a'.repeat(64),
};
beforeEach(() => {
  vi.resetAllMocks();
  ports.enabled = true;
  ports.writes = true;
  ports.actor.mockResolvedValue(actor);
  const { writesAvailable: _writes, ...data } = context;
  ports.read.mockResolvedValue(data);
});
it('loads actual server session/quota and transaction context bound to ownership path', async () => {
  expect(await loadPracticeOwnershipPage(path)).toEqual({ status: 'READY', context });
  expect(ports.read).toHaveBeenCalledWith(
    ports.tx,
    actor,
    { version: 'v1', ...path, purpose: 'OWNERSHIP_REVIEW' },
    expect.any(Function),
  );
  expect(ports.rateLimit).toHaveBeenCalledExactlyOnceWith(actor);
});
it.each([
  [401, 'SIGN_IN'],
  [403, 'DENIED'],
  [429, 'RATE_LIMITED'],
] as const)('maps current auth %s without reading context', async (status, result) => {
  ports.actor.mockRejectedValue(new PracticeOwnershipHttpError(status));
  expect(await loadPracticeOwnershipPage(path)).toEqual({ status: result });
  expect(ports.read).not.toHaveBeenCalled();
});
it('drops private context if read gate closes after committed observation', async () => {
  ports.read.mockImplementation(async () => {
    ports.enabled = false;
    return context;
  });
  expect(await loadPracticeOwnershipPage(path)).toEqual({ status: 'UNAVAILABLE' });
});
it('preserves context read-only with new writes disabled', async () => {
  ports.writes = false;
  expect(await loadPracticeOwnershipPage(path)).toEqual({
    status: 'READY',
    context: { ...context, writesAvailable: false },
  });
});
it('denies invalid path without calling auth/storage', async () => {
  expect(await loadPracticeOwnershipPage({ ...path, accountId: 'forged' })).toEqual({
    status: 'NOT_FOUND',
  });
  expect(ports.actor).not.toHaveBeenCalled();
});
it('rejects internally coherent context for another appointed account', async () => {
  const { writesAvailable: _writes, ...data } = context;
  ports.read.mockResolvedValue({
    ...data,
    review: {
      ...data.review,
      assignment: { ...data.review.assignment, evaluatorAccountId: 'foreign' },
    },
  });
  expect(await loadPracticeOwnershipPage(path)).toEqual({ status: 'UNAVAILABLE' });
});
it('returns a private-free not-found for missing/denied context', async () => {
  ports.read.mockResolvedValue(null);
  expect(await loadPracticeOwnershipPage(path)).toEqual({ status: 'NOT_FOUND' });
});
