export type StudioMenuItem = { label: string; href: string } | { label: string; action: string };
type MenuAccount = { admin: boolean; links?: { label: string; href: string }[] };
// Signing out is the single exit. Disconnecting X lives on the Account page, not in this menu.
export function studioMenuItems(account: MenuAccount): StudioMenuItem[] {
  return [
    { label: 'Account', href: '/creator/account' },
    { label: 'Balance', href: '/creator/balance' },
    ...(account.links ?? []),
    ...(account.admin ? [{ label: 'Operations', href: '/admin' }] : []),
    { label: 'Sign out', action: '/api/auth/logout' },
  ];
}
