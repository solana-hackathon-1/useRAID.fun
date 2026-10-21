import { afterEach, expect, it, vi } from 'vitest';
const ports = vi.hoisted(() => ({
  requireUser: vi.fn(),
  checkOrigin: vi.fn(),
  record: vi.fn(),
  POST: vi.fn(),
  rateLimit: vi.fn(),
  cookies: vi.fn(),
  hash: vi.fn(),
  read: vi.fn(),
  GET: vi.fn(),
  host: null as unknown,
}));
vi.mock('next/headers', () => ({ cookies: ports.cookies }));
vi.mock('../src/lib/auth', () => ({
  requireUser: ports.requireUser,
  checkOrigin: ports.checkOrigin,
  rateLimit: ports.rateLimit,
  hash: ports.hash,
  HttpError: class extends Error {
    constructor(readonly status: number) {
      super('private-marker');
    }
  },
}));
vi.mock('../src/lib/studio-mode', () => ({ sessionCookie: () => 'test-session' }));
vi.mock('../src/lib/practice-trial-ownership-host', () => ({
  readPracticeTrialOwnershipFromHost: ports.read,
  recordPracticeTrialOwnershipFromHost: ports.record,
}));
vi.mock('../src/skills/practice-ownership-http', async (original) => {
  const actual = await original<typeof import('../src/skills/practice-ownership-http')>();
  return {
    ...actual,
    createPracticeOwnershipHandlers: (host: unknown) => {
      ports.host = host;
      return { GET: ports.GET, POST: ports.POST };
    },
  };
});
import { HttpError } from '../src/lib/auth';
import {
  PracticeOwnershipHttpError,
  type PracticeOwnershipHttpHost,
} from '../src/skills/practice-ownership-http';
import {
  GET,
  POST,
  dynamic,
  runtime,
} from '../src/app/api/v1/practice/reviews/[assignmentId]/submissions/[submissionId]/ownership/route';
const actor = { accountId: 'current-evaluator', sessionHash: 'a'.repeat(64) };
const host = () => ports.host as PracticeOwnershipHttpHost;
afterEach(() => vi.resetAllMocks());
it('derives actual actor from current server session/cookie, without admin-role inference', async () => {
  ports.requireUser.mockResolvedValue({ id: actor.accountId });
  const cookie = vi.fn(() => ({ value: 'private-session-cookie' }));
  ports.cookies.mockResolvedValue({ get: cookie });
  ports.hash.mockReturnValue(actor.sessionHash);
  expect(await host().actor()).toEqual(actor);
  expect(ports.requireUser).toHaveBeenCalledExactlyOnceWith();
  expect(cookie).toHaveBeenCalledWith('test-session');
  expect(ports.hash).toHaveBeenCalledWith('private-session-cookie');
});
it('requires actual session cookie', async () => {
  ports.requireUser.mockResolvedValue({ id: actor.accountId });
  ports.cookies.mockResolvedValue({ get: () => undefined });
  await expect(host().actor()).rejects.toMatchObject({ status: 401 });
});
it.each([401, 403, 429] as const)(
  'maps Root authority %s to sanitized typed denial',
  async (status) => {
    ports.requireUser.mockRejectedValue(new HttpError(status, 'private-marker'));
    await expect(host().actor()).rejects.toBeInstanceOf(PracticeOwnershipHttpError);
    await expect(host().actor()).rejects.toMatchObject({
      status,
      message: 'HTTP_AUTHORITY_DENIED',
    });
  },
);
it('limits current account and translates rate-limit failure', async () => {
  await host().rateLimit(actor);
  expect(ports.rateLimit).toHaveBeenCalledWith('practice-ownership:' + actor.accountId, 30, 60);
  ports.rateLimit.mockRejectedValue(new HttpError(429, 'private-marker'));
  await expect(host().rateLimit(actor)).rejects.toMatchObject({ status: 429 });
});
it('uses existing transaction-held scoped/audited source and opaque request correlation', async () => {
  const input = {
    version: 'v1',
    assignmentId: 'case',
    submissionId: 'item',
    purpose: 'OWNERSHIP_REVIEW',
  };
  ports.read.mockResolvedValue({ review: null });
  expect(await host().read(actor, input)).toEqual({ review: null });
  expect(ports.read).toHaveBeenCalledExactlyOnceWith(actor, input);
  expect(host().requestId()).toMatch(/^[a-f0-9-]{36}$/);
  expect(host().version).toBe('v1');
});
it('forwards async path context through a dynamic Node GET without resolving private data itself', async () => {
  const request = new Request(
    'http://localhost/api/v1/practice/reviews/case/submissions/item?purpose=OWNERSHIP_REVIEW',
  );
  const params = Promise.resolve({ assignmentId: 'case', submissionId: 'item' });
  const response = new Response(null, { status: 404 });
  ports.GET.mockResolvedValue(response);
  expect(await GET(request, { params })).toBe(response);
  expect(ports.GET).toHaveBeenCalledExactlyOnceWith(request, params);
  expect(dynamic).toBe('force-dynamic');
  expect(runtime).toBe('nodejs');
});

it('requires actual origin through Root authority before command transport', async () => {
  const request = new Request('http://localhost/ownership', { method: 'POST' });
  await host().origin(request);
  expect(ports.checkOrigin).toHaveBeenCalledExactlyOnceWith(request);
  ports.checkOrigin.mockImplementation(() => {
    throw new HttpError(403, 'private-marker');
  });
  await expect(host().origin(request)).rejects.toMatchObject({
    status: 403,
    message: 'HTTP_AUTHORITY_DENIED',
  });
});
it('uses original transactional ownership command and forwards POST context', async () => {
  const command = { actor, input: { version: 'v1' }, idempotencyKey: 'stable', requestId: 'r' };
  ports.record.mockResolvedValue({ status: 'REPLAYED' });
  expect(await host().record(command)).toEqual({ status: 'REPLAYED' });
  expect(ports.record).toHaveBeenCalledExactlyOnceWith(command);
  const request = new Request('http://localhost/ownership', { method: 'POST' });
  const params = Promise.resolve({ assignmentId: 'case', submissionId: 'item' });
  const response = new Response(null, { status: 409 });
  ports.POST.mockResolvedValue(response);
  expect(await POST(request, { params })).toBe(response);
  expect(ports.POST).toHaveBeenCalledExactlyOnceWith(request, params);
});
