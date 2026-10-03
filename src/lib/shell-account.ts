import { currentSession } from './auth';
import { isAdmin } from './admins';
import { db } from './db';
import type { StudioAccount } from '@/components/studio-account-menu';

// The header must not take every page down with it when the database is unavailable.
export async function shellAccount(): Promise<StudioAccount | null> {
  try {
    const session = await currentSession();
    const user = session?.user ?? null;
    if (!user) return null;
    const account = await db.xAccount.findUnique({ where: { userId: user.id } });
    return {
      handle: account?.username || user.handle,
      image: account?.profileImage || null,
      connected: !!account,
      admin: isAdmin(user) && session?.via === 'x',
    };
  } catch (e) {
    console.error('shell account unavailable', e);
    return null;
  }
}
