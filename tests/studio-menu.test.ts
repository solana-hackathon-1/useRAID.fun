import { describe, expect, it } from 'vitest';
import { studioMenuItems } from '../src/lib/studio-menu';

const account = { handle: 'h', image: null, connected: true, admin: false };
describe('studio account menu', () => {
  it('offers one exit action: sign out, never a separate Disconnect X', () => {
    const labels = studioMenuItems(account).map((item) => item.label);
    expect(labels).toEqual(['Account', 'Balance', 'Sign out']);
    expect(labels).not.toContain('Disconnect X');
  });
  it('adds Operations for administrators only', () => {
    expect(studioMenuItems({ ...account, admin: true }).map((i) => i.label)).toEqual([
      'Account',
      'Balance',
      'Operations',
      'Sign out',
    ]);
  });
  it('signs out through the logout endpoint', () => {
    const signOut = studioMenuItems(account).find((i) => i.label === 'Sign out');
    expect(signOut).toEqual({ label: 'Sign out', action: '/api/auth/logout' });
  });
  it('shows work entry points between Balance and Operations, only the ones given', () => {
    const links = [
      { label: 'My Raid', href: '/raider/work' },
      { label: 'Notifications', href: '/notifications' },
    ];
    expect(studioMenuItems({ ...account, admin: true, links }).map((i) => i.label)).toEqual([
      'Account',
      'Balance',
      'My Raid',
      'Notifications',
      'Operations',
      'Sign out',
    ]);
    expect(studioMenuItems({ ...account, links: [] }).map((i) => i.label)).toEqual([
      'Account',
      'Balance',
      'Sign out',
    ]);
  });
});
