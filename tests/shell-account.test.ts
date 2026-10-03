import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ currentSession: vi.fn(), findUnique: vi.fn() }));
vi.mock('../src/lib/auth', () => ({ currentSession: mocks.currentSession }));
vi.mock('../src/lib/db', () => ({ db: { xAccount: { findUnique: mocks.findUnique } } }));
import { shellAccount } from '../src/lib/shell-account';

describe('shell account', () => {
  beforeEach(() => {
    mocks.currentSession.mockReset();
    mocks.findUnique.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  it('renders signed out instead of throwing when the database is down', async () => {
    mocks.currentSession.mockRejectedValue(new Error('db down'));
    await expect(shellAccount()).resolves.toBeNull();
    expect(console.error).toHaveBeenCalledWith('shell account unavailable', expect.any(Error));
  });
  it('also survives a failing X account lookup', async () => {
    mocks.currentSession.mockResolvedValue({
      user: { id: 'u1', handle: 'h', role: 'CREATOR', xId: 'x1', suspended: false },
      via: 'x',
    });
    mocks.findUnique.mockRejectedValue(new Error('db down'));
    await expect(shellAccount()).resolves.toBeNull();
  });
  it('maps the session and X account for the header', async () => {
    vi.stubEnv('ADMIN_X_IDS', 'x1');
    mocks.currentSession.mockResolvedValue({
      user: { id: 'u1', handle: 'fallback', role: 'ADMIN', xId: 'x1', suspended: false },
      via: 'x',
    });
    mocks.findUnique.mockResolvedValue({ username: 'real', profileImage: 'https://img/a.png' });
    await expect(shellAccount()).resolves.toEqual({
      handle: 'real',
      image: 'https://img/a.png',
      connected: true,
      admin: true,
    });
    vi.unstubAllEnvs();
  });
  it('returns null without a session', async () => {
    mocks.currentSession.mockResolvedValue(null);
    await expect(shellAccount()).resolves.toBeNull();
  });
});
