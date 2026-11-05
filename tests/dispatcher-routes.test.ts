import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T089 / blueprint §26.2 and §28: no generic "set the money/rank/state" mutation. `[action]` routes are the one
 * place a path segment selects behavior, so each must be a closed allowlist: an unknown or generic-sounding action is
 * refused before any write, a non-admin or cross-origin caller reaches nothing, and adding an action is a deliberate,
 * reviewed change to the pinned list below (a new money/rank/state action must also satisfy tests/api-route-guard).
 */
const calls: string[] = [];
const tx = new Proxy(
  {},
  {
    get: (_, model) =>
      new Proxy(
        {},
        {
          get:
            (_m, method) =>
            (...args: unknown[]) => {
              calls.push(`${String(model)}.${String(method)}`);
              void args;
              return Promise.resolve(null);
            },
        },
      ),
  },
);
const gate = vi.hoisted(() => ({ checkOrigin: vi.fn(), requireUser: vi.fn() }));
const discard = vi.hoisted(() => ({ discardSession: vi.fn() }));
vi.mock('@/lib/db', () => ({
  db: { $transaction: async (work: (t: unknown) => unknown) => work(tx) },
}));
vi.mock('@/lib/auth', async (original) => ({
  ...(await original<typeof import('@/lib/auth')>()),
  checkOrigin: gate.checkOrigin,
  requireUser: gate.requireUser,
}));
vi.mock('@/lib/identity-protocol', () => ({
  lockAdvisory: async () => undefined,
  prepareIdentity: async () => ({}),
  identityWriter: () => ({}),
}));
vi.mock('@/lib/studio-finance', () => ({ releaseFundedRaid: vi.fn() }));
vi.mock('@/lib/raid-funding', () => ({ fundingPricing: () => null, fundingQuote: () => 0n }));
vi.mock('@/lib/release', () => ({ assertLaunchpadsAvailable: () => undefined }));
vi.mock('@/lib/identity-leaves', () => discard);
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: 'cookie' }), delete: vi.fn() }),
}));

import { HttpError } from '@/lib/auth';
import { POST as adminPost } from '@/app/api/admin/[action]/route';
import { GET as authGet, POST as authPost } from '@/app/api/auth/[action]/route';

const admin = { id: 'admin-1', role: 'ADMIN' };
const post = (action: string, body: unknown, route = adminPost) =>
  route(
    new Request(`https://example.test/api/x/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ action }) },
  );

beforeEach(() => {
  calls.length = 0;
  vi.clearAllMocks();
  gate.checkOrigin.mockReturnValue(undefined);
  gate.requireUser.mockResolvedValue(admin);
});

describe('admin [action] dispatcher is a closed allowlist', () => {
  it('pins the supported actions; adding one is a deliberate change', () => {
    const source = readFileSync('src/app/api/admin/[action]/route.ts', 'utf8');
    const actions = [...new Set([...source.matchAll(/action === '([^']+)'/g)].map((m) => m[1]))];
    expect(actions.sort()).toEqual([
      'creator',
      'finance',
      'funding-quote',
      'launch-resume',
      'post',
      'raid',
      'raid-release',
      'retry',
      'settings',
    ]);
    const generic =
      /(^|[-_])(set|force|override|mark)[-_]?(paid|rank|state|status|score|balance|funded)/i;
    expect(actions.filter((name) => generic.test(name))).toEqual([]);
  });

  it.each([
    'set-paid',
    'setPaid',
    'set-rank',
    'set-state',
    'mark-funded',
    'force-release',
    'settings/../finance',
    '__proto__',
    'constructor',
    '',
  ])('refuses the unlisted action %j with 400 before any write or audit row', async (action) => {
    const response = await post(action, { reason: 'because', id: 'x', paid: true, rank: 'S' });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('Unsupported admin action.');
    expect(calls).toEqual([]);
  });

  it('requires an audit reason before dispatching even a supported action', async () => {
    for (const body of [{}, { reason: '   ' }, { reason: 7 }]) {
      const response = await post('finance', { launchPaused: true, payoutPaused: true, ...body });
      expect(response.status).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  it('rejects a cross-origin request before authenticating or doing anything', async () => {
    gate.checkOrigin.mockImplementation(() => {
      throw new HttpError(403, 'Cross-origin request blocked.');
    });
    const response = await post('finance', { reason: 'r', launchPaused: true, payoutPaused: true });
    expect(response.status).toBe(403);
    expect(gate.requireUser).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('asks for an administrator and does nothing when the caller is not one', async () => {
    gate.requireUser.mockRejectedValue(new HttpError(403, 'Forbidden.'));
    const response = await post('finance', { reason: 'r', launchPaused: true, payoutPaused: true });
    expect(response.status).toBe(403);
    expect(gate.requireUser).toHaveBeenCalledWith(true);
    expect(calls).toEqual([]);
  });

  it('positive control: a listed action with a reason performs its write and records the audit row', async () => {
    const response = await post('finance', {
      reason: 'pause',
      launchPaused: true,
      payoutPaused: false,
    });
    expect(response.status).toBe(200);
    expect(calls).toEqual(['settings.upsert', 'moderationEvent.create']);
  });
});

describe('auth [action] route', () => {
  it('only logs out on POST logout; any other action is 404 and discards no session', async () => {
    for (const action of ['login', 'set-session', 'admin', 'logout/../x']) {
      const response = await authPost(
        new Request('https://example.test/api/auth/' + action, { method: 'POST' }),
        { params: Promise.resolve({ action }) },
      );
      expect(response.status).toBe(404);
    }
    expect(discard.discardSession).not.toHaveBeenCalled();
    const ok = await authPost(
      new Request('https://example.test/api/auth/logout', { method: 'POST' }),
      {
        params: Promise.resolve({ action: 'logout' }),
      },
    );
    expect(ok.status).toBe(200);
    expect(discard.discardSession).toHaveBeenCalledTimes(1);
  });

  it('GET only redirects for login/callback and mutates nothing', async () => {
    const get = (action: string) =>
      authGet(new Request('https://example.test/api/auth/' + action), {
        params: Promise.resolve({ action }),
      });
    expect((await get('login')).status).toBe(303);
    expect((await get('callback')).status).toBe(303);
    expect((await get('logout')).status).toBe(404);
    expect(discard.discardSession).not.toHaveBeenCalled();
  });
});
