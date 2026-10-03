import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { config } from '../src/lib/config';
import { authorizationUrl, validState, oauthConfig, fetchXIdentity } from '../src/lib/x-oauth';
const usage = vi.hoisted(() => ({
  reserve: vi.fn(),
  settle: vi.fn(),
}));
vi.mock('../src/lib/providers/x', () => ({
  reserveUsage: usage.reserve,
  settleReservation: usage.settle,
}));

beforeEach(() => {
  usage.reserve.mockReset().mockResolvedValue({ id: 'reservation' });
  usage.settle.mockReset();
  config.demo = false;
  config.appUrl = 'http://localhost:3000';
  vi.stubEnv('X_CLIENT_ID', 'fixture-client');
  vi.stubEnv('X_CLIENT_SECRET', 'fixture-secret');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe('X OAuth protocol', () => {
  it('uses the exact callback, read scopes, and S256 challenge without secrets', () => {
    const url = new URL(authorizationUrl('state', 'verifier'));
    expect(url.origin + url.pathname).toBe('https://x.com/i/oauth2/authorize');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      redirect_uri: 'http://localhost:3000/api/auth/x/callback',
      scope: 'tweet.read users.read',
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update('verifier').digest('base64url'),
    });
    expect(url.toString()).not.toMatch(/fixture-secret|verifier|offline.access/);
  });
  it('rejects missing, unequal, and malformed state', () => {
    const state = 'a'.repeat(43);
    expect(validState(state, state)).toBe(true);
    for (const value of [undefined, '', 'b'.repeat(43), 'short', 'é'.repeat(43)])
      expect(validState(state, value)).toBe(false);
    expect(validState(null, state)).toBe(false);
  });
  it('requires confidential credentials, a valid origin, and production HTTPS', () => {
    vi.stubEnv('X_CLIENT_SECRET', '');
    expect(oauthConfig).toThrow();
    vi.stubEnv('X_CLIENT_SECRET', 'fixture-secret');
    for (const origin of [
      'https://example.com/path',
      'https://user:pass@example.com',
      'https://example.com/?next=evil',
      'javascript:alert(1)',
    ]) {
      config.appUrl = origin;
      expect(oauthConfig).toThrow();
    }
    config.appUrl = 'http://localhost:3000';
    vi.stubEnv('NODE_ENV', 'production');
    expect(oauthConfig).toThrow();
    config.appUrl = 'https://useraid.example';
    expect(oauthConfig().callback).toBe('https://useraid.example/api/auth/x/callback');
  });
  it('exchanges on the server and returns only validated identity', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ access_token: 'fixture-token', token_type: 'bearer' }))
      .mockResolvedValueOnce(
        Response.json({
          data: {
            id: '123',
            username: 'alice',
            name: 'Alice',
            profile_image_url: 'https://pbs.twimg.com/profile.png',
          },
        }),
      );
    vi.stubGlobal('fetch', fetcher);
    const profile = await fetchXIdentity('code', 'verifier');
    expect(profile).toMatchObject({ id: '123', name: 'Alice' });
    expect(JSON.stringify(profile)).not.toContain('fixture-token');
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe('https://api.x.com/2/oauth2/token');
    expect(options.headers.Authorization).toMatch(/^Basic /);
    expect(options.body.get('code_verifier')).toBe('verifier');
    expect(options.body.get('redirect_uri')).toBe('http://localhost:3000/api/auth/x/callback');
    expect(fetcher.mock.calls[1][1].headers.Authorization).toBe('Bearer fixture-token');
    expect(options.redirect).toBe('error');
  });
  it.each(['token', 'profile', 'malformed', 'transport'])('sanitizes %s failure', async (kind) => {
    const fetcher = vi.fn();
    if (kind === 'transport') fetcher.mockRejectedValue(new Error('sensitive provider payload'));
    else if (kind === 'token')
      fetcher.mockResolvedValue(new Response('sensitive provider payload', { status: 401 }));
    else
      fetcher
        .mockResolvedValueOnce(
          Response.json({ access_token: 'fixture-token', token_type: 'bearer' }),
        )
        .mockResolvedValueOnce(
          kind === 'profile'
            ? new Response('sensitive provider payload', { status: 429 })
            : Response.json({ data: { id: 123 } }),
        );
    vi.stubGlobal('fetch', fetcher);
    await expect(fetchXIdentity('code', 'verifier')).rejects.toMatchObject({
      code: 'provider',
      message: 'provider',
    });
  });
  it('releases the sign-in reservation when users/me returns no billable response', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({ access_token: 'fixture-token', token_type: 'bearer' }),
        )
        .mockResolvedValueOnce(new Response('unauthorized', { status: 401 })),
    );
    await expect(fetchXIdentity('code', 'verifier')).rejects.toMatchObject({ code: 'provider' });
    expect(usage.settle).toHaveBeenCalledWith('reservation', 0, expect.stringContaining('401'));
  });
  it('keeps the sign-in reservation after a timeout but releases it after other transport errors', async () => {
    const token = () => Response.json({ access_token: 'fixture-token', token_type: 'bearer' });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(token())
        .mockRejectedValueOnce(new DOMException('slow', 'TimeoutError')),
    );
    await expect(fetchXIdentity('code', 'verifier')).rejects.toMatchObject({ code: 'provider' });
    expect(usage.settle).not.toHaveBeenCalled();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(token()).mockRejectedValueOnce(new TypeError('fetch failed')),
    );
    await expect(fetchXIdentity('code', 'verifier')).rejects.toMatchObject({ code: 'provider' });
    expect(usage.settle).toHaveBeenCalledWith('reservation', 0, expect.any(String));
  });
});

it('sets Secure cookies in production even if the configured URL is invalid HTTP', async () => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.resetModules();
  const { cookieOptions } = await import('../src/lib/auth');
  expect(cookieOptions).toMatchObject({ secure: true, httpOnly: true, sameSite: 'lax' });
});
