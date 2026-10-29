import type { GuildActor, GuildCommand } from '../guild-profiles/guild-storage-contracts';
import {
  draftGuildUpdate,
  listManagedGuildUpdates,
  publishGuildUpdate,
  withdrawGuildUpdate,
} from '../guild-profiles/guild-storage';
import { runCommandTransaction } from './command-receipts-adapter';
import { config } from './config';
import { db } from './db';

/** Exact-string flag, default off. It gates new drafts and publications; withdrawal and own reads stay available. */
export function guildUpdatesWriteConfiguration() {
  const writesAvailable = !config.demo && process.env.GUILD_UPDATES_ENABLED === 'true';
  return { writesAvailable, unavailableReason: writesAvailable ? null : ('DISABLED' as const) };
}
const host = () => ({ allowNewWrites: guildUpdatesWriteConfiguration().writesAvailable });
export async function listUpdatesState(actor: GuildActor, guildId: string) {
  const { updates } = await runCommandTransaction(db, (tx) =>
    listManagedGuildUpdates(tx, actor, guildId),
  );
  return { version: 'v1' as const, updates, ...guildUpdatesWriteConfiguration() };
}
export const draftUpdate = (command: GuildCommand) =>
  runCommandTransaction(db, (tx) => draftGuildUpdate(tx, command, host()));
export const publishUpdate = (command: GuildCommand) =>
  runCommandTransaction(db, (tx) => publishGuildUpdate(tx, command, host()));
export const withdrawUpdate = (command: GuildCommand) =>
  runCommandTransaction(db, (tx) => withdrawGuildUpdate(tx, command, host()));
