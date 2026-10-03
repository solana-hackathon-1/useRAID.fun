import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../src/lib/auth-primitives';

const mocks = vi.hoisted(() => ({
  gate: { on: false },
  requireUser: vi.fn(),
  findLaunch: vi.fn(),
  transaction: vi.fn(),
  connection: vi.fn(),
  prepareLaunch: vi.fn(),
  buildLaunchTransaction: vi.fn(),
  submitLaunch: vi.fn(),
  reconcileLaunch: vi.fn(),
  enrollRaid: vi.fn(),
}));
vi.mock('../src/lib/release', () => ({
  get launchpadsAvailable() {
    return mocks.gate.on;
  },
  assertLaunchpadsAvailable: (message = 'Launchpads are coming soon.') => {
    if (!mocks.gate.on) throw new HttpError(503, message);
  },
}));
vi.mock('../src/lib/db', () => ({
  db: { tokenLaunch: { findUnique: mocks.findLaunch }, $transaction: mocks.transaction },
}));
vi.mock('../src/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/auth')>()),
  checkOrigin: vi.fn(),
  requireUser: mocks.requireUser,
  rateLimit: vi.fn(),
}));
vi.mock('../src/lib/pump-launch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/pump-launch')>()),
  connection: mocks.connection,
  prepareLaunch: mocks.prepareLaunch,
  buildLaunchTransaction: mocks.buildLaunchTransaction,
  submitLaunch: mocks.submitLaunch,
  reconcileLaunch: mocks.reconcileLaunch,
}));
vi.mock('../src/lib/tracking', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/tracking')>()),
  enrollRaid: mocks.enrollRaid,
}));
import { POST as prepare } from '../src/app/api/launch/prepare/route';
import { POST as upload } from '../src/app/api/launch/upload/route';
import { POST as submit } from '../src/app/api/launch/[id]/submit/route';
import { POST as retry } from '../src/app/api/launch/[id]/retry/route';
import { POST as enroll } from '../src/app/api/launch/[id]/enroll/route';
import { POST as renew } from '../src/app/api/launch/[id]/renew/route';
import { GET as status } from '../src/app/api/launch/[id]/route';
import { POST as admin } from '../src/app/api/admin/[action]/route';
import { publicLaunch } from '../src/lib/pump-launch';
import { routeContext, routeRequest } from './helpers/route';

const body = { transaction: 'AA==' };
const post = (path: string) => routeRequest(`http://localhost${path}`, { body });
const owned = {
  id: 'l1',
  userId: 'u1',
  mint: 'M',
  name: 'N',
  symbol: 'S',
  feeAddress: 'F',
  status: 'SUBMITTED',
  signature: 'sig',
  raidId: null,
  error: null,
};
const keys = ['X_TRACKING_V2_ENABLED', 'X_TRACKING_V2_SETTLEMENT_ENABLED'] as const;
const previous = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.gate.on = false;
  mocks.requireUser.mockResolvedValue({ id: 'u1' });
  mocks.findLaunch.mockResolvedValue(owned);
  mocks.reconcileLaunch.mockResolvedValue(publicLaunch({ ...owned, status: 'LIVE' }));
});
afterEach(() => {
  for (const k of keys)
    if (previous[k] === undefined) delete process.env[k];
    else process.env[k] = previous[k];
});

describe('launchpad gate', () => {
  it.each([
    ['prepare', () => prepare(post('/api/launch/prepare'))],
    ['upload', () => upload(post('/api/launch/upload'))],
    ['submit', () => submit(post('/api/launch/l1/submit'), routeContext({ id: 'l1' }))],
    ['retry', () => retry(post('/api/launch/l1/retry'), routeContext({ id: 'l1' }))],
    ['enroll', () => enroll(post('/api/launch/l1/enroll'), routeContext({ id: 'l1' }))],
    ['renew', () => renew(post('/api/launch/l1/renew'), routeContext({ id: 'l1' }))],
  ])('%s returns 503 without touching the database or the chain', async (_name, call) => {
    const response = await call();
    expect(response.status).toBe(503);
    expect(mocks.requireUser).not.toHaveBeenCalled();
    expect(mocks.findLaunch).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.connection).not.toHaveBeenCalled();
    expect(mocks.prepareLaunch).not.toHaveBeenCalled();
    expect(mocks.buildLaunchTransaction).not.toHaveBeenCalled();
    expect(mocks.submitLaunch).not.toHaveBeenCalled();
  });
  it('serves the stored launch row without reconciling on chain while gated', async () => {
    const response = await status(
      routeRequest('http://localhost/api/launch/l1'),
      routeContext({ id: 'l1' }),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe('SUBMITTED');
    expect(mocks.reconcileLaunch).not.toHaveBeenCalled();
  });
  it('reconciles a submitted launch on read once launchpads are available', async () => {
    mocks.gate.on = true;
    const response = await status(
      routeRequest('http://localhost/api/launch/l1'),
      routeContext({ id: 'l1' }),
    );
    expect((await response.json()).status).toBe('LIVE');
    expect(mocks.reconcileLaunch).toHaveBeenCalledWith('l1');
  });
  it('refuses to resume a paused launch while gated', async () => {
    mocks.requireUser.mockResolvedValue({ id: 'admin' });
    mocks.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({ $executeRaw: vi.fn(), tokenLaunch: { findUnique: mocks.findLaunch } }),
    );
    const response = await admin(
      routeRequest('http://localhost/api/admin/launch-resume', {
        body: { id: 'l1', reason: 'checked' },
      }),
      routeContext({ action: 'launch-resume' }),
    );
    expect(response.status).toBe(503);
    expect(mocks.findLaunch).not.toHaveBeenCalled();
  });
});

describe('launch reward copy', () => {
  it('reports review-based rewards unless v2 tracking is switched off', () => {
    delete process.env.X_TRACKING_V2_ENABLED;
    delete process.env.X_TRACKING_V2_SETTLEMENT_ENABLED;
    expect(publicLaunch(owned)).toMatchObject({ rewardMode: 'reviewed', settlementEnabled: false });
    process.env.X_TRACKING_V2_ENABLED = 'false';
    expect(publicLaunch(owned).rewardMode).toBe('hourly');
    process.env.X_TRACKING_V2_ENABLED = 'true';
    process.env.X_TRACKING_V2_SETTLEMENT_ENABLED = 'true';
    expect(publicLaunch(owned)).toMatchObject({ rewardMode: 'reviewed', settlementEnabled: true });
  });
});
