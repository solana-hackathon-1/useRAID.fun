import { afterEach, expect, it, vi } from 'vitest';
const ports = vi.hoisted(() => ({
  requireUser: vi.fn(),
  checkOrigin: vi.fn(),
  rateLimit: vi.fn(),
  cookies: vi.fn(),
  hash: vi.fn(),
  adminXIds: vi.fn(),
  issueHost: vi.fn(),
  revokeHost: vi.fn(),
  issue: vi.fn(),
  revoke: vi.fn(),
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
vi.mock('../src/lib/admins', () => ({ adminXIds: ports.adminXIds }));
vi.mock('../src/lib/studio-mode', () => ({ sessionCookie: () => 'test-session' }));
vi.mock('../src/lib/practice-review-assignments-host', () => ({
  issuePracticeReviewAssignmentFromHost: ports.issueHost,
  revokePracticeReviewAssignmentFromHost: ports.revokeHost,
}));
vi.mock('../src/skills/practice-review-assignment-http', async (original) => {
  const actual = await original<typeof import('../src/skills/practice-review-assignment-http')>();
  return {
    ...actual,
    createPracticeReviewAssignmentHandlers: (host: unknown) => {
      ports.host = host;
      return { issue: ports.issue, revoke: ports.revoke };
    },
  };
});
import { HttpError } from '../src/lib/auth';
import {
  PracticeReviewAssignmentHttpError,
  type PracticeReviewAssignmentHttpHost,
} from '../src/skills/practice-review-assignment-http';
import {
  POST as issuePost,
  dynamic as issueDynamic,
  runtime as issueRuntime,
} from '../src/app/api/v1/admin/practice/review-assignments/route';
import {
  POST as revokePost,
  dynamic as revokeDynamic,
  runtime as revokeRuntime,
} from '../src/app/api/v1/admin/practice/review-assignments/[assignmentId]/revocations/route';
const actor = { accountId: 'admin-account', sessionHash: 'a'.repeat(64) };
const host = () => ports.host as PracticeReviewAssignmentHttpHost;
const admin = (over: Record<string, unknown> = {}) => ({
  id: actor.accountId,
  xId: 'allowed-x',
  ...over,
});
const signedIn = () => {
  ports.requireUser.mockResolvedValue(admin());
  ports.adminXIds.mockReturnValue(['allowed-x']);
  ports.cookies.mockResolvedValue({ get: () => ({ value: 'private-session-cookie' }) });
  ports.hash.mockReturnValue(actor.sessionHash);
};
afterEach(() => vi.resetAllMocks());

it('requires an actual X-connected administrator and derives the session hash', async () => {
  signedIn();
  expect(await host().actor()).toEqual(actor);
  expect(ports.requireUser).toHaveBeenCalledExactlyOnceWith(true);
  expect(ports.hash).toHaveBeenCalledWith('private-session-cookie');
});
it.each([
  ['no X identity', () => ports.requireUser.mockResolvedValue(admin({ xId: null }))],
  ['non-admin X identity', () => ports.requireUser.mockResolvedValue(admin({ xId: 'other-x' }))],
])('denies %s with a sanitized 403', async (_name, arrange) => {
  signedIn();
  arrange();
  await expect(host().actor()).rejects.toBeInstanceOf(PracticeReviewAssignmentHttpError);
  await expect(host().actor()).rejects.toMatchObject({ status: 403 });
});
it('requires the live session cookie', async () => {
  signedIn();
  ports.cookies.mockResolvedValue({ get: () => undefined });
  await expect(host().actor()).rejects.toMatchObject({ status: 401 });
});
it.each([401, 403, 429] as const)(
  'maps Root authority %s without leaking its text',
  async (status) => {
    ports.requireUser.mockRejectedValue(new HttpError(status, 'private-marker'));
    await expect(host().actor()).rejects.toMatchObject({
      status,
      message: 'HTTP_AUTHORITY_DENIED',
    });
  },
);
it('lets an unrelated Root failure propagate for the transport to sanitize', async () => {
  ports.requireUser.mockRejectedValue(new Error('driver text'));
  await expect(host().actor()).rejects.toThrow('driver text');
});
it('checks origin with the Root policy and translates denial', async () => {
  const request = new Request('http://raid.test/', { method: 'POST' });
  await host().origin(request);
  expect(ports.checkOrigin).toHaveBeenCalledExactlyOnceWith(request);
  ports.checkOrigin.mockImplementation(() => {
    throw new HttpError(403, 'private-marker');
  });
  await expect(host().origin(request)).rejects.toMatchObject({ status: 403 });
});
it('limits the current admin account on a dedicated key', async () => {
  await host().rateLimit(actor);
  expect(ports.rateLimit).toHaveBeenCalledWith(
    'practice-review-assignments:' + actor.accountId,
    30,
    60,
  );
  ports.rateLimit.mockRejectedValue(new HttpError(429, 'private-marker'));
  await expect(host().rateLimit(actor)).rejects.toMatchObject({ status: 429 });
});
it('delegates to the existing committed host commands unchanged', async () => {
  const command = { actor, input: {}, idempotencyKey: 'k', requestId: 'r' };
  ports.issueHost.mockResolvedValue({ marker: 'issue' });
  ports.revokeHost.mockResolvedValue({ marker: 'revoke' });
  expect(await host().issue(command)).toEqual({ marker: 'issue' });
  expect(await host().revoke(command)).toEqual({ marker: 'revoke' });
  expect(ports.issueHost).toHaveBeenCalledExactlyOnceWith(command);
  expect(ports.revokeHost).toHaveBeenCalledExactlyOnceWith(command);
});
it('exposes POST only, dynamic Node, and forwards params as a promise', async () => {
  expect(issueDynamic).toBe('force-dynamic');
  expect(issueRuntime).toBe('nodejs');
  expect(revokeDynamic).toBe('force-dynamic');
  expect(revokeRuntime).toBe('nodejs');
  const routeModules = [
    await import('../src/app/api/v1/admin/practice/review-assignments/route'),
    await import('../src/app/api/v1/admin/practice/review-assignments/[assignmentId]/revocations/route'),
  ];
  for (const mod of routeModules)
    for (const verb of ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE'])
      expect(mod).not.toHaveProperty(verb);
  const request = new Request('http://raid.test/', { method: 'POST' });
  ports.issue.mockResolvedValue(new Response('i'));
  ports.revoke.mockResolvedValue(new Response('r'));
  expect(await (await issuePost(request)).text()).toBe('i');
  const params = Promise.resolve({ assignmentId: 'id' });
  expect(await (await revokePost(request, { params })).text()).toBe('r');
  expect(ports.revoke).toHaveBeenCalledExactlyOnceWith(request, params);
});
