import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../src/lib/auth-primitives';

const mocks = vi.hoisted(() => ({
  gate: { on: false },
  requireUser: vi.fn(),
  checkOrigin: vi.fn(),
  rateLimit: vi.fn(),
  publicRateLimit: vi.fn(),
  findLaunch: vi.fn(),
  prepareLaunch: vi.fn(),
  prepareMeteora: vi.fn(),
  buildLaunchTransaction: vi.fn(),
  nextLaunchStep: vi.fn(),
  submitLaunch: vi.fn(),
  submitMeteora: vi.fn(),
  approvePayout: vi.fn(),
  tokenView: vi.fn(),
}));
vi.mock('../src/lib/release', () => ({
  get launchpadsAvailable() {
    return mocks.gate.on;
  },
  assertLaunchpadsAvailable: (message = 'Launchpads are coming soon.') => {
    if (!mocks.gate.on) throw new HttpError(503, message);
  },
}));
vi.mock('../src/lib/db', () => ({ db: { tokenLaunch: { findUnique: mocks.findLaunch } } }));
vi.mock('../src/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/auth')>()),
  checkOrigin: mocks.checkOrigin,
  requireUser: mocks.requireUser,
  rateLimit: mocks.rateLimit,
  publicRateLimit: mocks.publicRateLimit,
  currentUser: async () => null,
}));
vi.mock('../src/lib/pump-launch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/pump-launch')>()),
  prepareLaunch: mocks.prepareLaunch,
  buildLaunchTransaction: mocks.buildLaunchTransaction,
  submitLaunch: mocks.submitLaunch,
}));
vi.mock('../src/lib/meteora/launch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/meteora/launch')>()),
  prepareMeteoraLaunch: mocks.prepareMeteora,
  nextLaunchStep: mocks.nextLaunchStep,
  submitMeteoraLaunch: mocks.submitMeteora,
}));
vi.mock('../src/lib/meteora/campaigns', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/meteora/campaigns')>()),
  approveLaunchPayout: mocks.approvePayout,
}));
vi.mock('../src/lib/meteora/view', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/meteora/view')>()),
  meteoraTokenView: mocks.tokenView,
}));
import { POST as prepare } from '../src/app/api/launch/prepare/route';
import { POST as submit } from '../src/app/api/launch/[id]/submit/route';
import { POST as retry } from '../src/app/api/launch/[id]/retry/route';
import { POST as admin } from '../src/app/api/admin/meteora/route';
import { GET as launchView } from '../src/app/api/tokens/[mint]/launch/route';
import { GET as launchConfig } from '../src/app/api/launch/config/route';
import { meteoraReadiness } from '../src/lib/meteora/config';
import { routeContext, routeRequest } from './helpers/route';

const keys = ['METEORA_LAUNCH_ENABLED', 'LAUNCH_ASSET_KEY', 'METEORA_NETWORK'] as const;
const previous = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
const post = (path: string, body: unknown) => routeRequest(`http://localhost${path}`, { body });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.gate.on = false;
  process.env.METEORA_LAUNCH_ENABLED = 'true';
  mocks.requireUser.mockResolvedValue({ id: 'u1' });
  mocks.prepareMeteora.mockResolvedValue({ ok: 'meteora' });
  mocks.nextLaunchStep.mockResolvedValue({ ok: 'meteora' });
  mocks.submitMeteora.mockResolvedValue({ ok: 'meteora' });
});
afterEach(() => {
  for (const k of keys)
    if (previous[k] === undefined) delete process.env[k];
    else process.env[k] = previous[k];
});

describe('Meteora launch routes behind the Pump release gate', () => {
  it('serve Meteora launches while launchpadsAvailable is false and its own switch is on', async () => {
    expect((await prepare(post('/api/launch/prepare', { provider: 'METEORA' }))).status).toBe(201);
    expect(mocks.prepareMeteora).toHaveBeenCalledWith('u1', { provider: 'METEORA' });
    mocks.findLaunch.mockResolvedValue({ id: 'l1', provider: 'METEORA' });
    const ctx = routeContext({ id: 'l1' });
    expect((await retry(post('/api/launch/l1/retry', {}), ctx)).status).toBe(200);
    expect(mocks.nextLaunchStep).toHaveBeenCalledWith('l1', 'u1');
    const response = await submit(
      post('/api/launch/l1/submit', { transaction: 'AA==', stepId: 's1' }),
      ctx,
    );
    expect(response.status).toBe(200);
    expect(mocks.submitMeteora).toHaveBeenCalledWith('l1', 'u1', 's1', 'AA==');
  });
  it('still refuse Pump launches while Meteora is switched on', async () => {
    mocks.findLaunch.mockResolvedValue({ id: 'l1', provider: 'PUMP' });
    const ctx = routeContext({ id: 'l1' });
    for (const response of [
      await prepare(post('/api/launch/prepare', { name: 'x' })),
      await retry(post('/api/launch/l1/retry', {}), ctx),
      await submit(post('/api/launch/l1/submit', { transaction: 'AA==' }), ctx),
    ])
      expect(response.status).toBe(503);
    expect(mocks.prepareLaunch).not.toHaveBeenCalled();
    expect(mocks.buildLaunchTransaction).not.toHaveBeenCalled();
    expect(mocks.submitLaunch).not.toHaveBeenCalled();
  });
  it('refuse everything before authentication when both switches are off', async () => {
    delete process.env.METEORA_LAUNCH_ENABLED;
    const ctx = routeContext({ id: 'l1' });
    for (const response of [
      await prepare(post('/api/launch/prepare', { provider: 'METEORA' })),
      await retry(post('/api/launch/l1/retry', {}), ctx),
      await submit(post('/api/launch/l1/submit', { transaction: 'AA==' }), ctx),
    ])
      expect(response.status).toBe(503);
    expect(mocks.requireUser).not.toHaveBeenCalled();
    expect(mocks.prepareMeteora).not.toHaveBeenCalled();
  });
  it('report malformed bodies as 400 through readJson', async () => {
    const response = await prepare(
      routeRequest('http://localhost/api/launch/prepare', { rawBody: 'not json' }),
    );
    expect(response.status).toBe(400);
  });
});

describe('Meteora admin and public routes', () => {
  it('requires an administrator and the origin check for payout decisions', async () => {
    mocks.requireUser.mockRejectedValue(new HttpError(403, 'Administrator access required.'));
    const response = await admin(post('/api/admin/meteora', { id: 'p1', action: 'approve' }));
    expect(response.status).toBe(403);
    expect(mocks.checkOrigin).toHaveBeenCalled();
    expect(mocks.requireUser).toHaveBeenCalledWith(true);
    expect(mocks.approvePayout).not.toHaveBeenCalled();
  });
  it('parses the decision body with readJson', async () => {
    const bad = await admin(post('/api/admin/meteora', { id: '', action: 'approve' }));
    expect(bad.status).toBe(400);
    const ok = await admin(post('/api/admin/meteora', { id: 'p1', action: 'hold', reason: 'x' }));
    expect(ok.status).toBe(200);
    expect(mocks.approvePayout).toHaveBeenCalledWith('p1', 'u1', false, 'x');
  });
  it('rate limits the unauthenticated launch view and readiness endpoints', async () => {
    mocks.tokenView.mockResolvedValue(null);
    await launchView(
      routeRequest('http://localhost/api/tokens/M/launch'),
      routeContext({ mint: 'M' }),
    );
    await launchConfig(routeRequest('http://localhost/api/launch/config'));
    expect(mocks.publicRateLimit.mock.calls.map((c) => c[1])).toEqual([
      'launch-view',
      'launch-config',
    ]);
  });
  it('stays off until the web-only image signing key is configured', () => {
    process.env.METEORA_NETWORK = 'devnet';
    delete process.env.LAUNCH_ASSET_KEY;
    expect(meteoraReadiness().issues).toContain('Launch image verification needs configuration.');
    process.env.LAUNCH_ASSET_KEY = Buffer.alloc(32, 3).toString('base64');
    expect(meteoraReadiness().issues).not.toContain(
      'Launch image verification needs configuration.',
    );
  });
});
