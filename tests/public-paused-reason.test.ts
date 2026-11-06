import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T091 (#161) W02/C14: a PAUSED launch stores the reason as raw text. FinancePauseError embeds the first simulation
 * logs an RPC node returned (URLs, query-string keys), and other reasons carry transaction signatures. The reward view
 * is public (anonymous GET /api/tokens/[mint] and the SSR token page), so it carries only a fixed safe reason; the raw
 * text stays in the row for operators and the admin view.
 */
const mocks = vi.hoisted(() => ({ findLaunch: vi.fn(), getToken: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh() {} }) }));
vi.mock('../src/components/wallet-login', () => ({ WalletLogin: () => null }));
vi.mock('../src/lib/db', () => ({
  db: {
    tokenLaunch: { findUnique: mocks.findLaunch },
    rewardPayout: { groupBy: async () => [], findMany: async () => [] },
    settings: { findUnique: async () => null },
  },
}));
vi.mock('../src/lib/data', () => ({ getToken: mocks.getToken }));
vi.mock('../src/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/auth')>()),
  currentUser: async () => null,
}));
import { GET as tokenRoute } from '../src/app/api/tokens/[mint]/route';
import { publicRewardView } from '../src/lib/reward-view';
import { RewardPanel } from '../src/components/reward-panel';
import { publicLaunch } from '../src/lib/pump-launch';
import { routeContext, routeRequest } from './helpers/route';

const SECRET = 'SECRET_KEY_123';
const RAW_SIMULATION = `CLAIM simulation failed; inspect chain accounts. Program log: https://rpc.example.test/v2/${SECRET}?api-key=${SECRET} | custom program error`;
const launchRow = (error: string | null, status = 'PAUSED') => ({
  id: 'l1',
  userId: 'owner',
  feeAddress: 'FeeAddr',
  status,
  error,
  raidId: null,
  signature: 'sig',
  imageUri: null,
  raid: null,
  rounds: [],
  claims: [],
});
const leaks = (text: string) => text.includes(SECRET) || text.includes('rpc.example.test');
beforeEach(() => {
  vi.clearAllMocks();
  mocks.getToken.mockResolvedValue({ mint: 'M', symbol: 'S', raids: [] });
});

describe('a paused launch never publishes its raw stored reason', () => {
  it('GET /api/tokens/[mint] answers anonymous callers with a fixed reason', async () => {
    mocks.findLaunch.mockResolvedValue(launchRow(RAW_SIMULATION));
    const response = await tokenRoute(
      routeRequest('http://localhost/api/tokens/M'),
      routeContext({ mint: 'M' }),
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(leaks(text)).toBe(false);
    expect(JSON.parse(text).rewards).toMatchObject({ status: 'PAUSED' });
    expect(JSON.parse(text).rewards.pausedReason).toBeTruthy();
  });
  it('the rendered RewardPanel shows a fixed reason, not the RPC log', async () => {
    mocks.findLaunch.mockResolvedValue(launchRow(RAW_SIMULATION));
    const view = await publicRewardView('M');
    const html = renderToStaticMarkup(
      createElement(RewardPanel, { view: view!, walletAddress: null, xConnected: false }),
    );
    expect(html).toContain('Payouts paused');
    expect(leaks(html)).toBe(false);
    expect(html).not.toContain('Program log');
  });
  it.each([
    ['simulation logs', RAW_SIMULATION],
    ['a transaction signature', 'On-chain payout failed; inspect 5xSIGNATUREsignature123.'],
    ['a lamport count and signature', 'Network fee 9000 differed from approved 5000 on 5xSIG.'],
    ['unrecognised text', 'something unexpected from a provider'],
  ])('projects %s to text that carries none of it', async (_label, stored) => {
    mocks.findLaunch.mockResolvedValue(launchRow(stored));
    const view = await publicRewardView('M');
    expect(view!.pausedReason).toBeTruthy();
    expect(view!.pausedReason).not.toContain('simulation logs');
    expect(view!.pausedReason).not.toMatch(
      /rpc\.example|SIGNATURE|5xSIG|9000|Program log|unexpected/,
    );
  });
  it.each([
    'Fee wallet balance insufficient',
    'Network fee changed before signing',
    'Unexpected network fee; payouts paused',
    'Fee recipient or bonding curve changed',
  ])('keeps the fixed pause reason: %s', async (reason) => {
    mocks.findLaunch.mockResolvedValue(launchRow(reason));
    expect((await publicRewardView('M'))!.pausedReason).toBe(reason);
  });
  it('a live launch carries no paused reason', async () => {
    mocks.findLaunch.mockResolvedValue(
      launchRow('Operator absorbed 5 lamports of failed cost.', 'LIVE'),
    );
    expect((await publicRewardView('M'))!.pausedReason).toBeNull();
  });
});

describe('publicLaunch takes the launch status into account', () => {
  const owned = (status: string, error: string | null) => ({
    id: 'l1',
    mint: 'M',
    name: 'N',
    symbol: 'S',
    feeAddress: 'F',
    status,
    signature: 'sig',
    raidId: null,
    error,
  });
  it('a PAUSED launch keeps a fixed pause reason for its owner', () => {
    expect(publicLaunch(owned('PAUSED', 'Fee wallet balance insufficient')).error).toBe(
      'Fee wallet balance insufficient',
    );
  });
  it('a PAUSED launch never shows the submission-pending text or the raw log', () => {
    const view = publicLaunch(owned('PAUSED', RAW_SIMULATION));
    expect(view.error).toBeTruthy();
    expect(view.error).not.toMatch(/submission pending/i);
    expect(leaks(JSON.stringify(view))).toBe(false);
  });
  it('a LIVE launch is not told its submission is pending', () => {
    expect(
      publicLaunch(owned('LIVE', 'Operator absorbed 5 lamports of failed cost.')).error,
    ).toBeNull();
  });
});
