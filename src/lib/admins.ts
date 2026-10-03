import type { User } from '@prisma/client';
import { studioSandbox } from './studio-mode';

export function adminXIds() {
  return [process.env.X_ADMIN_USER_ID || '', ...(process.env.ADMIN_X_IDS || '').split(',')]
    .map((s) => s.trim())
    .filter(Boolean);
}
// The environment allowlist is authoritative on every request, so removing an id revokes access immediately.
export function isAdmin<T extends Pick<User, 'role' | 'xId' | 'suspended'>>(
  user: T | null | undefined,
): user is T {
  return (
    !!user &&
    !user.suspended &&
    user.role === 'ADMIN' &&
    !!user.xId &&
    (adminXIds().includes(user.xId) || (studioSandbox() && user.xId.startsWith('studio-')))
  );
}
