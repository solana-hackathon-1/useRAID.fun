import type { GuildActor, GuildCommand } from '../guild-profiles/guild-storage-contracts';
import {
  editGuildProfile,
  listManagedGuilds,
  readManagedGuild,
} from '../guild-profiles/guild-storage';
import { runCommandTransaction } from './command-receipts-adapter';
import { config } from './config';
import { db } from './db';

/** Exact-string flag, default off. It gates new profile edits; replays and the caller's own reads stay available. */
export function guildProfileWriteConfiguration() {
  const writesAvailable = !config.demo && process.env.GUILD_PROFILE_EDITS_ENABLED === 'true';
  return { writesAvailable, unavailableReason: writesAvailable ? null : ('DISABLED' as const) };
}
export async function readProfileState(actor: GuildActor, guildId: string) {
  const { guild, authority } = await runCommandTransaction(db, (tx) =>
    readManagedGuild(tx, actor, guildId),
  );
  return { version: 'v1' as const, guild, authority, ...guildProfileWriteConfiguration() };
}
export const editProfile = (command: GuildCommand) =>
  runCommandTransaction(db, (tx) =>
    editGuildProfile(tx, command, {
      allowNewWrites: guildProfileWriteConfiguration().writesAvailable,
    }),
  );
/** The caller's own managed Guilds. The read needs no flag; the edit availability is reported beside it. */
export async function listManagedGuildsState(actor: GuildActor) {
  const { guilds } = await runCommandTransaction(db, (tx) => listManagedGuilds(tx, actor));
  return { version: 'v1' as const, guilds, ...guildProfileWriteConfiguration() };
}
