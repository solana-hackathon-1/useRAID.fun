import { cookies } from 'next/headers';
import { z } from 'zod';
import {
  GuildStorageError,
  ManagedGuildListSchema,
} from '../guild-profiles/guild-storage-contracts';
import { currentUser, hash } from './auth';
import { listManagedGuildsState } from './guild-profile-host';
import { sessionCookie } from './studio-mode';

const ListStateSchema = ManagedGuildListSchema.extend({
  writesAvailable: z.boolean(),
});
export type GuildManageList =
  | { kind: 'SIGNED_OUT' }
  | { kind: 'FAILED' }
  | {
      kind: 'READY';
      actor: { accountId: string; sessionHash: string };
      guilds: z.infer<typeof ManagedGuildListSchema>['guilds'];
      profileWritesAvailable: boolean;
    };
/**
 * The signed-in caller's own managed Guilds, read on the server with the session actor. An expired session reads as
 * signed out; any other failure (including a response that breaks the contract) is a generic failure with no detail.
 */
export async function loadManagedGuilds(): Promise<GuildManageList> {
  const user = await currentUser(),
    cookie = (await cookies()).get(sessionCookie())?.value;
  if (!user || !cookie) return { kind: 'SIGNED_OUT' };
  const actor = { accountId: user.id, sessionHash: hash(cookie) };
  try {
    const state = await listManagedGuildsState(actor);
    const parsed = ListStateSchema.safeParse({
      guilds: state.guilds,
      writesAvailable: state.writesAvailable,
    });
    if (!parsed.success) return { kind: 'FAILED' };
    return {
      kind: 'READY',
      actor,
      guilds: parsed.data.guilds,
      profileWritesAvailable: parsed.data.writesAvailable,
    };
  } catch (error) {
    if (error instanceof GuildStorageError && error.code === 'UNAUTHENTICATED')
      return { kind: 'SIGNED_OUT' };
    return { kind: 'FAILED' };
  }
}
