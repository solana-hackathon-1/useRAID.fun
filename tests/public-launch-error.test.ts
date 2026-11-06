import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T091 (#161) W02/C14: TokenLaunch.error is stored raw (an RPC node's message can carry its URL, an API key in a query
 * string, or a response body). The launch status read is owner-only, but it is still a response body, so it carries a
 * stable safe message; the raw text stays in the row for operators.
 */
const mocks = vi.hoisted(() => ({ findLaunch: vi.fn(), requireUser: vi.fn() }));
vi.mock('../src/lib/release', () => ({ launchpadsAvailable: false }));
vi.mock('../src/lib/db', () => ({ db: { tokenLaunch: { findUnique: mocks.findLaunch } } }));
vi.mock('../src/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/auth')>()),
  requireUser: mocks.requireUser,
}));
import { GET as status } from '../src/app/api/launch/[id]/route';
import { LAUNCH_SUBMISSION_PENDING, publicLaunch } from '../src/lib/pump-launch';
import { routeContext, routeRequest } from './helpers/route';

const RAW =
  '503 Service Unavailable: https://rpc.example.test/v2/SECRET_KEY_123?api-key=SECRET_KEY_123 {"jsonrpc":"2.0"}';
const row = (error: string | null, status = 'SUBMITTED') => ({
  id: 'l1',
  userId: 'u1',
  mint: 'M',
  name: 'N',
  symbol: 'S',
  feeAddress: 'F',
  status,
  signature: 'sig',
  raidId: null,
  error,
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue({ id: 'u1' });
});

describe('launch status never returns raw stored error text', () => {
  it('replaces raw RPC text with a stable safe message', () => {
    const view = publicLaunch(row(RAW));
    expect(view.error).toBe(LAUNCH_SUBMISSION_PENDING);
    expect(JSON.stringify(view)).not.toContain('SECRET_KEY_123');
    expect(JSON.stringify(view)).not.toContain('rpc.example.test');
  });
  it('replaces any unrecognised stored text, even short or empty-looking', () => {
    expect(publicLaunch(row('Broadcast failed')).error).toBe(LAUNCH_SUBMISSION_PENDING);
    expect(publicLaunch(row('x')).error).toBe(LAUNCH_SUBMISSION_PENDING);
  });
  it.each([
    'Launch transaction failed on chain.',
    'Blockhash expired. Sign a fresh transaction.',
    'Mint exists but no reviewed creation transaction was found; operator review required.',
  ])('keeps the fixed message the launch screen already shows: %s', (message) => {
    expect(publicLaunch(row(message, 'FAILED')).error).toBe(message);
  });
  it('keeps a null error null', () => {
    expect(publicLaunch(row(null)).error).toBeNull();
  });
  it('GET /api/launch/[id] returns the safe message to the owner, not the raw text', async () => {
    mocks.findLaunch.mockResolvedValue(row(RAW));
    const response = await status(
      routeRequest('http://localhost/api/launch/l1'),
      routeContext({ id: 'l1' }),
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain('SECRET_KEY_123');
    expect(text).not.toContain('rpc.example.test');
    expect(JSON.parse(text)).toMatchObject({ id: 'l1', error: LAUNCH_SUBMISSION_PENDING });
  });
});
