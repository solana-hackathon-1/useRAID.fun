import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../src/lib/auth-primitives';
import { routeContext, routeRequest } from './helpers/route';

// DEC-2026-11-07-04: while O02 and O08 are OPEN the launch flow is a controlled "not configured"
// state, Pump takes no new launch intents, and existing intents stay pinned to their protocol.
const mocks = vi.hoisted(() => ({
  gate: { on: true },
  requireUser: vi.fn(),
  checkOrigin: vi.fn(),
  rateLimit: vi.fn(),
  pinMetadata: vi.fn(),
  pinFile: vi.fn(),
  submitLaunch: vi.fn(),
  reconcileLaunch: vi.fn(),
  findLaunch: vi.fn(),
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
  db: new Proxy(
    { tokenLaunch: { findUnique: mocks.findLaunch } },
    {
      get: (target, key) => {
        if (key in target) return Reflect.get(target, key);
        throw new Error(`database touched: ${String(key)}`);
      },
    },
  ),
}));
vi.mock('../src/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/auth')>()),
  checkOrigin: mocks.checkOrigin,
  requireUser: mocks.requireUser,
  rateLimit: mocks.rateLimit,
  currentUser: async () => {
    throw new Error('current user read');
  },
}));
vi.mock('../src/lib/launch-ipfs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/launch-ipfs')>()),
  verifyAsset: () => {},
  pinMetadata: mocks.pinMetadata,
  pinFile: mocks.pinFile,
}));
vi.mock('../src/lib/pump-launch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/pump-launch')>()),
  submitLaunch: mocks.submitLaunch,
  reconcileLaunch: mocks.reconcileLaunch,
}));
import LaunchPage from '../src/app/launch/page';
import { POST as prepare } from '../src/app/api/launch/prepare/route';
import { POST as upload } from '../src/app/api/launch/upload/route';
import { POST as submit } from '../src/app/api/launch/[id]/submit/route';
import { GET as status } from '../src/app/api/launch/[id]/route';
import { prepareLaunch } from '../src/lib/pump-launch';
import { launchRouteState } from '../src/lib/launch-route-state';
import { config } from '../src/lib/config';

const names = [
  'LAUNCH_ENABLED',
  'PAYOUT_ENABLED',
  'OPERATOR_PUBLIC_KEY',
  'PLATFORM_TREASURY_ADDRESS',
  'X_BEARER_TOKEN',
  'SOLANA_RPC_URL',
  'PINATA_JWT',
  'LAUNCH_KEY_1',
  'FEE_SEAL_PUBLIC_1',
  'LAUNCH_ASSET_KEY',
] as const;
const previous = Object.fromEntries(names.map((n) => [n, process.env[n]]));
const previousConfig = { demo: config.demo, liveApproved: config.liveApproved };
const input = {
  name: 'Fixture',
  symbol: 'FIX',
  description: 'A fixture token launch',
  imageUri: 'ipfs://bafybeigdyrzt4j5q2p3x7uh5tlvnruzbwpjlvszwncln6q2jv7idv2uyvu',
  imageProof: '1.1.proof',
};
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
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

beforeAll(() => {
  // Every Pump launch precondition is satisfied: only the decision may stop a new intent.
  config.demo = false;
  config.liveApproved = true;
  Object.assign(process.env, {
    LAUNCH_ENABLED: 'true',
    PAYOUT_ENABLED: 'true',
    OPERATOR_PUBLIC_KEY: '11111111111111111111111111111112',
    PLATFORM_TREASURY_ADDRESS: '11111111111111111111111111111113',
    X_BEARER_TOKEN: 'token',
    SOLANA_RPC_URL: 'https://rpc.example',
    PINATA_JWT: 'jwt',
    LAUNCH_KEY_1: 'key',
    FEE_SEAL_PUBLIC_1: 'seal',
    LAUNCH_ASSET_KEY: 'asset',
  });
});
afterAll(() => {
  for (const n of names)
    if (previous[n] === undefined) delete process.env[n];
    else process.env[n] = previous[n];
  Object.assign(config, previousConfig);
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.gate.on = true;
  mocks.requireUser.mockResolvedValue({ id: 'u1' });
  mocks.findLaunch.mockResolvedValue(owned);
  mocks.submitLaunch.mockResolvedValue({ id: 'l1', status: 'SUBMITTED' });
  mocks.reconcileLaunch.mockResolvedValue({ ...owned, status: 'LIVE' });
});

describe('launch route state', () => {
  it('reports NOT_CONFIGURED naming O02 and O08, with no supply, allocation, curve or fee value', () => {
    expect(launchRouteState()).toEqual({
      configured: false,
      protocol: 'METEORA_DBC',
      network: 'DEVNET',
      quoteAsset: 'USDC',
      openDecisions: ['O02', 'O08'],
    });
  });
});

describe('Pump takes no new launch intents', () => {
  it('prepare refuses as not configured before auth, database, chain or storage', async () => {
    const response = await prepare(
      routeRequest('http://localhost/api/launch/prepare', { body: input }),
    );
    expect(response.status).toBe(503);
    expect((await response.json()).error).toMatch(/not configured/i);
    expect(mocks.requireUser).not.toHaveBeenCalled();
    expect(mocks.pinMetadata).not.toHaveBeenCalled();
  });
  it('prepareLaunch itself refuses even if called directly, creating nothing', async () => {
    await expect(prepareLaunch('u1', input)).rejects.toMatchObject({
      status: 503,
      message: expect.stringMatching(/not configured/i),
    });
    expect(mocks.pinMetadata).not.toHaveBeenCalled();
  });
  it('the image upload that only prepares a new intent refuses as well', async () => {
    const response = await upload(routeRequest('http://localhost/api/launch/upload', { body: {} }));
    expect(response.status).toBe(503);
    expect((await response.json()).error).toMatch(/not configured/i);
    expect(mocks.requireUser).not.toHaveBeenCalled();
    expect(mocks.pinFile).not.toHaveBeenCalled();
  });
});

describe('existing intents stay on their pinned protocol', () => {
  it('still serves and reconciles an existing launch', async () => {
    const response = await status(
      routeRequest('http://localhost/api/launch/l1'),
      routeContext({ id: 'l1' }),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe('LIVE');
    expect(mocks.reconcileLaunch).toHaveBeenCalledWith('l1');
  });
  it('still submits the signed transaction of an existing intent', async () => {
    const response = await submit(
      routeRequest('http://localhost/api/launch/l1/submit', { body: { transaction: 'AA==' } }),
      routeContext({ id: 'l1' }),
    );
    expect(response.status).toBe(200);
    expect(mocks.submitLaunch).toHaveBeenCalledWith('l1', 'u1', 'AA==');
  });
});

describe('launch page', () => {
  it('shows the controlled not-configured state: no wizard, no pump.fun, no invented values', async () => {
    const html = renderToStaticMarkup(await LaunchPage());
    const words = text(html);
    expect(words).toMatch(/not configured/i);
    expect(words).toContain('O02');
    expect(words).toContain('O08');
    expect(words).not.toMatch(/pump\.?fun/i);
    expect(html).not.toMatch(/<(form|input|select|textarea|button)\b/);
    expect(words).not.toMatch(/\d+\s*%|\bSOL\b|supply of|\d{3,}/);
  });
  it('keeps the coming-soon page while launchpads are unavailable', async () => {
    mocks.gate.on = false;
    const words = text(renderToStaticMarkup(createElement('div', null, await LaunchPage())));
    expect(words).toMatch(/coming soon/i);
  });
});
