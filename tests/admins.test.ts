import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminXIds, isAdmin } from '../src/lib/admins';

const admin = { role: 'ADMIN' as const, xId: '42', suspended: false };
afterEach(() => vi.unstubAllEnvs());
describe('isAdmin', () => {
  it('requires the ADMIN role and an id on the environment allowlist', () => {
    vi.stubEnv('X_ADMIN_USER_ID', '42');
    expect(isAdmin(admin)).toBe(true);
    expect(isAdmin({ ...admin, role: 'CREATOR' })).toBe(false);
    expect(isAdmin({ ...admin, xId: null })).toBe(false);
    expect(isAdmin({ ...admin, xId: '43' })).toBe(false);
    expect(isAdmin(null)).toBe(false);
    expect(isAdmin(undefined)).toBe(false);
  });
  it('reads both variables on every call and trusts neither blank entries nor handles', () => {
    vi.stubEnv('X_ADMIN_USER_ID', '');
    vi.stubEnv('ADMIN_X_IDS', ' 7 ,, 42 ');
    expect(adminXIds()).toEqual(['7', '42']);
    expect(isAdmin(admin)).toBe(true);
    vi.stubEnv('ADMIN_X_IDS', '7');
    expect(isAdmin(admin)).toBe(false);
  });
  it('is false for a suspended administrator', () => {
    vi.stubEnv('X_ADMIN_USER_ID', '42');
    expect(isAdmin({ ...admin, suspended: true })).toBe(false);
  });
  it('does not honour the sandbox exemption outside the Studio sandbox', () => {
    expect(isAdmin({ ...admin, xId: 'studio-local-creator' })).toBe(false);
  });
});
