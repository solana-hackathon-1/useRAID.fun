import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  cookies: new Map<string, string>(),
  cleanup: vi.fn(),
  start: vi.fn(),
  claim: vi.fn(),
  profile: vi.fn(),
  complete: vi.fn(),
  disconnect: vi.fn(),
  origin: vi.fn(),
  user: vi.fn(),
  limit: vi.fn(),
  publicLimit: vi.fn(),
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      mocks.cookies.has(name) ? { value: mocks.cookies.get(name) } : undefined,
  }),
}));
vi.mock('../src/lib/db', () => ({ db: { oAuthAttempt: { deleteMany: mocks.cleanup } } }));
vi.mock('../src/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/auth')>()),
  checkOrigin: mocks.origin,
  requireUser: mocks.user,
  rateLimit: mocks.limit,
  publicRateLimit: mocks.publicLimit,
}));
vi.mock('../src/lib/x-oauth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/x-oauth')>()),
  oauthConfig: vi.fn(),
  startAttempt: mocks.start,
  claimAttempt: mocks.claim,
  fetchXIdentity: mocks.profile,
  completeConnection: mocks.complete,
  disconnectX: mocks.disconnect,
}));
import { callbackX, startX, disconnect } from '../src/lib/x-oauth-routes';
import { OAuthError } from '../src/lib/x-oauth';
import { HttpError } from '../src/lib/auth';
const state = 'a'.repeat(43);
const callback = (query = `state=${state}&code=fixture-code`) =>
  new Request(`http://localhost:3000/api/auth/x/callback?${query}`);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.cookies.clear();
  mocks.cookies.set('raid_oauth', state);
  mocks.cleanup.mockResolvedValue({ count: 1 });
  mocks.claim.mockResolvedValue({ stateHash: 'hash', verifier: 'fixture-verifier' });
  mocks.profile.mockResolvedValue({ id: '123', username: 'alice', name: 'Alice' });
  mocks.complete.mockResolvedValue('fixture-session');
  mocks.start.mockResolvedValue({ state, url: 'https://x.com/i/oauth2/authorize?fixture' });
  mocks.user.mockResolvedValue({ id: 'user' });
  mocks.origin.mockImplementation(() => {});
});
afterEach(() => vi.unstubAllEnvs());
it('limits sign-in starts per session when a session cookie exists, otherwise per client', async () => {
  mocks.cookies.set('raid_session', 'session-value');
  await startX(new Request('http://localhost:3000/api/auth/x'));
  expect(mocks.limit).toHaveBeenCalledWith(expect.stringMatching(/^oauth:session:/), 30, 600);
  expect(mocks.publicLimit).not.toHaveBeenCalled();
  mocks.cookies.delete('raid_session');
  mocks.limit.mockClear();
  await startX(new Request('http://localhost:3000/api/auth/x'));
  expect(mocks.publicLimit).toHaveBeenCalledWith(expect.any(Request), 'oauth', 30, 600, 600);
  expect(mocks.limit).not.toHaveBeenCalled();
});
it('starts with HttpOnly and SameSite cookies', async () => {
  const response = await startX(
    new Request('http://localhost:3000/api/auth/x?returnTo=https://evil.example'),
  );
  expect(response.headers.get('location')).toMatch(/^https:\/\/x.com\//);
  expect(response.cookies.get('raid_oauth')).toMatchObject({
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 600,
  });
  expect(response.headers.get('cache-control')).toBe('no-store');
});
it('callback success sets only an opaque session and clears state', async () => {
  const response = await callbackX(callback());
  expect(response.headers.get('location')).toBe('/creator?auth=connected');
  expect(response.cookies.get('raid_session')).toMatchObject({
    value: 'fixture-session',
    httpOnly: true,
    sameSite: 'lax',
  });
  expect(response.cookies.get('raid_oauth')?.maxAge).toBe(0);
  expect(JSON.stringify([...response.headers])).not.toMatch(/fixture-code|fixture-verifier/);
  expect(mocks.cleanup).toHaveBeenCalledOnce();
});
it('invalid state never reaches exchange', async () => {
  const response = await callbackX(callback('state=bad&code=code'));
  expect(response.headers.get('location')).toBe('/creator?auth=state');
  expect(mocks.profile).not.toHaveBeenCalled();
  expect(mocks.claim).not.toHaveBeenCalled();
});
it('expired or replayed attempt never reaches exchange', async () => {
  mocks.claim.mockRejectedValueOnce(new OAuthError('state'));
  expect((await callbackX(callback())).headers.get('location')).toBe('/creator?auth=state');
  expect(mocks.profile).not.toHaveBeenCalled();
});
it('cancellation validates and consumes state, then skips exchange', async () => {
  expect(
    (await callbackX(callback(`state=${state}&error=access_denied`))).headers.get('location'),
  ).toBe('/creator?auth=cancelled');
  expect(mocks.claim).toHaveBeenCalledOnce();
  expect(mocks.profile).not.toHaveBeenCalled();
  expect(mocks.cleanup).toHaveBeenCalledOnce();
});
it('provider failures do not create sessions or expose details', async () => {
  mocks.profile.mockRejectedValueOnce(new OAuthError('provider'));
  const response = await callbackX(callback());
  expect(response.headers.get('location')).toBe('/creator?auth=provider');
  expect(response.cookies.get('raid_session')).toBeUndefined();
  expect(mocks.complete).not.toHaveBeenCalled();
});
it('disconnect requires origin and session, then unlinks without signing out', async () => {
  const response = await disconnect(
    new Request('http://localhost:3000/api/auth/x/disconnect', { method: 'POST' }),
  );
  expect(response.status).toBe(200);
  expect(mocks.disconnect).toHaveBeenCalledWith('user');
  expect(response.cookies.get('raid_session')).toBeUndefined();
  mocks.origin.mockImplementationOnce(() => {
    throw new HttpError(403, 'Request origin rejected.');
  });
  expect((await disconnect(new Request('http://localhost:3000'))).status).toBe(403);
  mocks.user.mockRejectedValueOnce(new HttpError(401, 'Sign in to continue.'));
  expect((await disconnect(new Request('http://localhost:3000'))).status).toBe(401);
  expect(mocks.disconnect).toHaveBeenCalledTimes(1);
});

const state2 = 'b'.repeat(43);
const cuid = 'c'.repeat(25);
it('keeps several states so concurrent authorizations both complete', async () => {
  const first = await startX(new Request('http://localhost:3000/api/auth/x'));
  expect(first.cookies.get('raid_oauth')?.value).toBe(state);
  mocks.cookies.set('raid_oauth', state);
  mocks.start.mockResolvedValueOnce({ state: state2, url: 'https://x.com/i/oauth2/authorize?b' });
  const second = await startX(new Request('http://localhost:3000/api/auth/x'));
  expect(second.cookies.get('raid_oauth')?.value).toBe(`${state}.${state2}`);
  mocks.cookies.set('raid_oauth', `${state}.${state2}`);
  const response = await callbackX(callback());
  expect(response.headers.get('location')).toBe('/creator?auth=connected');
  expect(response.cookies.get('raid_oauth')).toMatchObject({ value: state2, maxAge: 600 });
});
it('ignores router prefetches without any side effect', async () => {
  for (const headers of [
    { 'next-router-prefetch': '1' },
    { 'sec-purpose': 'prefetch' },
    { purpose: 'prefetch' },
  ] as Record<string, string>[]) {
    const response = await startX(new Request('http://localhost:3000/api/auth/x', { headers }));
    expect(response.status).toBe(204);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.cookies.get('raid_oauth')).toBeUndefined();
  }
  expect(mocks.limit).not.toHaveBeenCalled();
  expect(mocks.publicLimit).not.toHaveBeenCalled();
  expect(mocks.start).not.toHaveBeenCalled();
});
it('returns to an allowlisted destination only', async () => {
  const started = await startX(new Request('http://localhost:3000/api/auth/x?return=account'));
  expect(started.cookies.get('raid_oauth_return')).toMatchObject({ value: 'account', maxAge: 600 });
  mocks.cookies.set('raid_oauth_return', 'account');
  const done = await callbackX(callback());
  expect(done.headers.get('location')).toBe('/creator/account?auth=connected');
  expect(done.cookies.get('raid_oauth_return')?.maxAge).toBe(0);
  expect(done.cookies.get('raid_oauth')?.maxAge).toBe(0);
  for (const bad of [
    'https://evil.example',
    '../x',
    '//evil.example',
    'raid:short',
    'constructor',
  ]) {
    const response = await startX(
      new Request(`http://localhost:3000/api/auth/x?return=${encodeURIComponent(bad)}`),
    );
    expect(response.cookies.get('raid_oauth_return')?.maxAge).toBe(0);
    mocks.cookies.set('raid_oauth_return', bad);
    expect((await callbackX(callback())).headers.get('location')).toBe('/creator?auth=connected');
  }
  mocks.cookies.set('raid_oauth_return', `raid:${cuid}`);
  expect((await callbackX(callback())).headers.get('location')).toBe(
    `/raids/${cuid}?auth=connected`,
  );
  mocks.cookies.set('raid_oauth_return', 'admin');
  mocks.claim.mockRejectedValueOnce(new OAuthError('state'));
  expect((await callbackX(callback())).headers.get('location')).toBe('/admin?auth=state');
});
it('clears the session cookie only when the session is really gone', async () => {
  mocks.cookies.set('raid_session', 'session-value');
  const kept = await startX(new Request('http://localhost:3000/api/auth/x'));
  expect(kept.cookies.get('raid_session')).toBeUndefined();
  mocks.start.mockResolvedValueOnce({ state, url: 'https://x.com/a', clearSession: true });
  const cleared = await startX(new Request('http://localhost:3000/api/auth/x'));
  expect(cleared.cookies.get('raid_session')?.maxAge).toBe(0);
  mocks.complete.mockRejectedValueOnce(new OAuthError('session'));
  const callbackResponse = await callbackX(callback());
  expect(callbackResponse.headers.get('location')).toBe('/creator?auth=session');
  expect(callbackResponse.cookies.get('raid_session')?.maxAge).toBe(0);
});
