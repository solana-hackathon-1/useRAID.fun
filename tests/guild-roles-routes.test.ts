import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  user: vi.fn(),
  rate: vi.fn(),
  cookie: vi.fn(),
  grant: vi.fn(),
  revoke: vi.fn(),
  propose: vi.fn(),
  respond: vi.fn(),
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: mocks.cookie }) }));
vi.mock('../src/lib/auth', async (original) => ({
  ...(await original<typeof import('../src/lib/auth')>()),
  requireUser: mocks.user,
  rateLimit: mocks.rate,
}));
vi.mock('../src/lib/guild-roles-host', () => ({
  grantRole: mocks.grant,
  revokeRole: mocks.revoke,
  proposeTransfer: mocks.propose,
  respondTransfer: mocks.respond,
}));
import { POST as grantRoute } from '../src/app/api/v1/guild-grants/route';
import { POST as revokeRoute } from '../src/app/api/v1/guild-grants/[grantId]/revoke/route';
import { POST as proposeRoute } from '../src/app/api/v1/guild-ownership-transfers/route';
import { POST as respondRoute } from '../src/app/api/v1/guild-ownership-transfers/[transferId]/route';
import { hash, HttpError } from '../src/lib/auth-primitives';
import { config } from '../src/lib/config';
import { routeRequest } from './helpers/route';

const guildId = '11111111-1111-4111-8111-111111111111';
const grantId = '22222222-2222-4222-8222-222222222222';
const transferId = '33333333-3333-4333-8333-333333333333';
const origin = 'http://localhost:3014';
const send = (path: string, body: unknown, headers: Record<string, string> = {}, from = origin) =>
  routeRequest(origin + path, {
    body,
    origin: from,
    headers: { 'Idempotency-Key': 'k-1', ...headers },
  });
const grantBody = { guildId, granteeAccountId: 'delegate-1', kind: 'TREASURY' };
const all = () => [
  grantRoute(send('/api/v1/guild-grants', grantBody)),
  revokeRoute(send(`/api/v1/guild-grants/${grantId}/revoke`, { guildId }), {
    params: Promise.resolve({ grantId }),
  }),
  proposeRoute(
    send('/api/v1/guild-ownership-transfers', {
      guildId,
      toAccountId: 'heir-1',
      expiresAt: '2027-01-01T00:00:00.000Z',
    }),
  ),
  respondRoute(
    send(`/api/v1/guild-ownership-transfers/${transferId}`, { guildId, decision: 'DECLINE' }),
    {
      params: Promise.resolve({ transferId }),
    },
  ),
];
const none = () =>
  [mocks.grant, mocks.revoke, mocks.propose, mocks.respond].every((m) => m.mock.calls.length === 0);

beforeEach(() => {
  vi.resetAllMocks();
  config.demo = false;
  config.appUrl = origin;
  mocks.user.mockResolvedValue({ id: 'synthetic-self' });
  mocks.cookie.mockReturnValue({ value: 'synthetic-cookie' });
  mocks.rate.mockResolvedValue(undefined);
});

it('derives the actor only from the own server cookie and passes it, the key and the strict input to the host', async () => {
  mocks.grant.mockResolvedValue({ status: 'EXECUTED', grant: {} });
  await grantRoute(send('/api/v1/guild-grants', grantBody));
  expect(mocks.grant).toHaveBeenCalledWith(
    expect.objectContaining({
      actor: { accountId: 'synthetic-self', sessionHash: hash('synthetic-cookie') },
      idempotencyKey: 'k-1',
      input: grantBody,
    }),
  );
});

it('denies a missing session or own cookie, a foreign origin and a throttled caller before any host call', async () => {
  mocks.user.mockRejectedValue(new HttpError(401, 'Sign in'));
  for (const response of await Promise.all(all())) expect(response.status).toBe(401);
  mocks.user.mockResolvedValue({ id: 'synthetic-self' });
  mocks.cookie.mockReturnValue(undefined);
  for (const response of await Promise.all(all())) expect(response.status).toBe(401);
  mocks.cookie.mockReturnValue({ value: 'synthetic-cookie' });
  const foreign = await grantRoute(
    send('/api/v1/guild-grants', grantBody, {}, 'https://foreign.invalid'),
  );
  expect(foreign.status).toBe(403);
  mocks.rate.mockRejectedValue(new HttpError(429, 'Slow down'));
  for (const response of await Promise.all(all())) expect(response.status).toBe(429);
  expect(none()).toBe(true);
});

it('throttles commands per account in their own bucket, away from the profile and updates buckets', async () => {
  mocks.grant.mockResolvedValue({ status: 'EXECUTED', grant: {} });
  await grantRoute(send('/api/v1/guild-grants', grantBody));
  expect(mocks.rate).toHaveBeenCalledWith('guild-roles:synthetic-self', 30, 60);
});

it('refuses bodies carrying an actor, a role grant id or unknown fields with 422', async () => {
  for (const body of [
    { ...grantBody, actorAccountId: 'foreign' },
    { ...grantBody, grantedByAccountId: 'foreign' },
    { ...grantBody, sessionHash: 'forged' },
  ])
    expect((await grantRoute(send('/api/v1/guild-grants', body))).status).toBe(422);
  expect(
    (await grantRoute(send('/api/v1/guild-grants', grantBody, { 'Idempotency-Key': '' }))).status,
  ).toBe(422);
  expect(none()).toBe(true);
});
