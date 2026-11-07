import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  user: vi.fn(),
  rate: vi.fn(),
  cookie: vi.fn(),
  activate: vi.fn(),
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: mocks.cookie }) }));
vi.mock('../src/lib/auth', async (original) => ({
  ...(await original<typeof import('../src/lib/auth')>()),
  requireUser: mocks.user,
  rateLimit: mocks.rate,
}));
vi.mock('../src/lib/guild-activation-host', () => ({ activateGuildAsOperator: mocks.activate }));
import { POST as activateRoute } from '../src/app/api/v1/guild-activations/route';
import { hash, HttpError } from '../src/lib/auth-primitives';
import { config } from '../src/lib/config';
import { routeRequest } from './helpers/route';

const origin = 'http://localhost:3014';
const body = {
  guildDraftId: '44444444-4444-4444-8444-444444444444',
  expectedDraftRevision: 2,
  activationRef: 'evidence-1',
};
const send = (payload: unknown, headers: Record<string, string> = {}, from = origin) =>
  routeRequest(origin + '/api/v1/guild-activations', {
    body: payload,
    origin: from,
    headers: { 'Idempotency-Key': 'k-1', ...headers },
  });

beforeEach(() => {
  vi.resetAllMocks();
  config.demo = false;
  config.appUrl = origin;
  mocks.user.mockResolvedValue({ id: 'synthetic-operator' });
  mocks.cookie.mockReturnValue({ value: 'synthetic-cookie' });
  mocks.rate.mockResolvedValue(undefined);
});

it('derives the actor only from the own server cookie and passes it, the key and the strict input to the host', async () => {
  mocks.activate.mockResolvedValue({ status: 'EXECUTED', guild: {} });
  await activateRoute(send(body));
  expect(mocks.activate).toHaveBeenCalledWith(
    expect.objectContaining({
      actor: { accountId: 'synthetic-operator', sessionHash: hash('synthetic-cookie') },
      idempotencyKey: 'k-1',
      input: body,
    }),
  );
});

it('denies a missing session or cookie, a foreign origin and a throttled caller before any host call', async () => {
  mocks.user.mockRejectedValue(new HttpError(401, 'Sign in'));
  expect((await activateRoute(send(body))).status).toBe(401);
  mocks.user.mockResolvedValue({ id: 'synthetic-operator' });
  mocks.cookie.mockReturnValue(undefined);
  expect((await activateRoute(send(body))).status).toBe(401);
  mocks.cookie.mockReturnValue({ value: 'synthetic-cookie' });
  expect((await activateRoute(send(body, {}, 'https://foreign.invalid'))).status).toBe(403);
  mocks.rate.mockRejectedValue(new HttpError(429, 'Slow down'));
  expect((await activateRoute(send(body))).status).toBe(429);
  expect(mocks.activate).not.toHaveBeenCalled();
});

it('throttles commands per account in their own bucket, away from the other Guild buckets', async () => {
  mocks.activate.mockResolvedValue({ status: 'EXECUTED', guild: {} });
  await activateRoute(send(body));
  expect(mocks.rate).toHaveBeenCalledWith('guild-activation:synthetic-operator', 30, 60);
});

it('refuses bodies carrying an actor, a founder or unknown fields, and a missing key, with 422', async () => {
  for (const payload of [
    { ...body, actorAccountId: 'foreign' },
    { ...body, founderAccountId: 'foreign' },
    { ...body, activatedByAccountId: 'foreign' },
    { ...body, sessionHash: 'forged' },
  ])
    expect((await activateRoute(send(payload))).status).toBe(422);
  expect((await activateRoute(send(body, { 'Idempotency-Key': '' }))).status).toBe(422);
  expect(mocks.activate).not.toHaveBeenCalled();
});

it('exposes POST only', async () => {
  const routes = await import('../src/app/api/v1/guild-activations/route');
  expect(Object.keys(routes).filter((k) => /^(GET|PUT|PATCH|DELETE)$/.test(k))).toEqual([]);
});
