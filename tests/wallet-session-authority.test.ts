import { describe, expect, it } from 'vitest';
import { walletSessionAuthority } from '../src/lib/wallet-session-authority';

describe('wallet session authority v1', () => {
  const now = new Date('2026-10-10T00:00:00.500Z');
  const live = { userId: 'own', via: 'x', expiresAt: new Date('2026-10-10T00:00:01Z') };
  it('preserves only a live own X session under authenticated own context', () => {
    expect(walletSessionAuthority(live, 'own', 'own', now)).toBe('x');
  });
  it.each([
    ['absent', undefined, 'own', now],
    ['foreign owner', { ...live, userId: 'foreign' }, 'own', now],
    ['foreign context', live, 'foreign', now],
    ['missing context', live, undefined, now],
    ['wallet provider', { ...live, via: 'wallet' }, 'own', now],
    ['unknown provider', { ...live, via: 'unknown' }, 'own', now],
    ['expired whole second', { ...live, expiresAt: new Date('2026-10-10T00:00:00Z') }, 'own', now],
    ['expiry equality', { ...live, expiresAt: now }, 'own', now],
    ['invalid expiry', { ...live, expiresAt: new Date(NaN) }, 'own', now],
    ['invalid clock', live, 'own', new Date(NaN)],
  ] as const)('defaults to wallet authority for %s', (_label, previous, context, clock) => {
    expect(walletSessionAuthority(previous, context, 'own', clock)).toBe('wallet');
  });
});
