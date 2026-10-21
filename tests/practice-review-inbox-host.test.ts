import { afterEach, expect, it, vi } from 'vitest';
const ports = vi.hoisted(() => ({
  actor: vi.fn(),
  cookies: vi.fn(),
  hash: vi.fn(),
  rateLimit: vi.fn(),
  list: vi.fn(),
  GET: vi.fn(),
  HEAD: vi.fn(),
  host: null as unknown,
  port: {},
}));
vi.mock('next/headers', () => ({ cookies: ports.cookies }));
vi.mock('../src/lib/auth', () => ({
  requireUser: ports.actor,
  hash: ports.hash,
  rateLimit: ports.rateLimit,
  HttpError: class extends Error {
    constructor(readonly status: number) {
      super('private-marker');
    }
  },
}));
vi.mock('../src/lib/db', () => ({ db: {} }));
vi.mock('../src/lib/studio-mode', () => ({ sessionCookie: () => 'test-session' }));
vi.mock('../src/lib/command-receipts-adapter', () => ({
  runCommandTransaction: vi.fn(async (_db, work) => work(ports.port)),
}));
vi.mock('../src/skills/practice-review-inbox-storage', () => ({
  listPracticeReviewInbox: ports.list,
}));
vi.mock('../src/skills/practice-review-inbox-http', () => ({
  createPracticeReviewInboxHandlers: (host: unknown) => {
    ports.host = host;
    return { GET: ports.GET, HEAD: ports.HEAD };
  },
}));
import { HttpError } from '../src/lib/auth';
import type { PracticeReviewInboxHttpHost } from '../src/skills/practice-review-inbox-http';
import { listPracticeReviewInboxFromHost } from '../src/lib/practice-review-inbox';
import { GET, HEAD, dynamic, runtime } from '../src/app/api/v1/practice/reviews/route';
const host = () => ports.host as PracticeReviewInboxHttpHost;
const actor = { accountId: 'evaluator', sessionHash: 'a'.repeat(64) },
  input = { version: 'v1', after: null };
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});
it('derives own actual server cookie/hash identity without evaluator request input', async () => {
  ports.actor.mockResolvedValue({ id: actor.accountId });
  ports.cookies.mockResolvedValue({
    get: (key: string) => (key === 'test-session' ? { value: 'actual-cookie' } : undefined),
  });
  ports.hash.mockReturnValue(actor.sessionHash);
  expect(await host().actor()).toEqual(actor);
  expect(ports.hash).toHaveBeenCalledWith('actual-cookie');
});
it('requires actual session cookie', async () => {
  ports.actor.mockResolvedValue({ id: actor.accountId });
  ports.cookies.mockResolvedValue({ get: () => undefined });
  await expect(host().actor()).rejects.toMatchObject({ status: 401 });
});
it.each([401, 403, 429])('sanitizes Root auth%s', async (status) => {
  ports.actor.mockRejectedValue(new HttpError(status, 'secret'));
  await expect(host().actor()).rejects.toMatchObject({ status, message: 'HTTP_AUTHORITY_DENIED' });
});
it('shares account quota with exact case readers', async () => {
  await host().rateLimit(actor);
  expect(ports.rateLimit).toHaveBeenCalledWith('practice-review:' + actor.accountId, 30, 60);
  ports.rateLimit.mockRejectedValueOnce(new HttpError(429, 'secret'));
  await expect(host().rateLimit(actor)).rejects.toMatchObject({ status: 429 });
});
it('composes actual transaction, own actor and existing live flag with exact input', async () => {
  vi.stubEnv('PRACTICE_REVIEW_READS_ENABLED', 'true');
  ports.list.mockResolvedValue({ accountId: actor.accountId, page: {} });
  expect(await listPracticeReviewInboxFromHost(actor, input)).toMatchObject({
    version: 'v1',
    readsAvailable: true,
    result: { accountId: actor.accountId },
  });
  const [tx, a, i, policy] = ports.list.mock.calls[0];
  expect(tx).toBe(ports.port);
  expect(a).toBe(actor);
  expect(i).toBe(input);
  expect(policy({ accountId: actor.accountId })).toBe(true);
  vi.stubEnv('PRACTICE_REVIEW_READS_ENABLED', 'TRUE');
  expect(policy({ accountId: actor.accountId })).toBe(false);
});
it('drops metadata if feature closes after commit', async () => {
  vi.stubEnv('PRACTICE_REVIEW_READS_ENABLED', 'true');
  ports.list.mockImplementationOnce(async () => {
    vi.stubEnv('PRACTICE_REVIEW_READS_ENABLED', 'false');
    return { page: { secret: 'metadata' } };
  });
  expect(await listPracticeReviewInboxFromHost(actor, input)).toEqual({
    version: 'v1',
    readsAvailable: false,
    unavailableReason: 'DISABLED',
    result: null,
  });
});
it('exports dynamic Node GET/HEAD using only protected handlers', () => {
  expect(GET).toBe(ports.GET);
  expect(HEAD).toBe(ports.HEAD);
  expect(dynamic).toBe('force-dynamic');
  expect(runtime).toBe('nodejs');
  expect(host().version).toBe('v1');
  expect(host().requestId()).toMatch(/^[a-f0-9-]{36}$/);
});
