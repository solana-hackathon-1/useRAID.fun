import { listPublicGuildUpdates, readPublicGuild } from '../guild-profiles/guild-storage';
import { runCommandTransaction } from './command-receipts-adapter';
import { db } from './db';

/** Exact-string flag, default off: a closed feature advertises and answers nothing. */
export function guildPublicAvailable() {
  return process.env.GUILD_PUBLIC_READS_ENABLED === 'true';
}
export async function readGuildFromHost(slug: string) {
  return runCommandTransaction(db, (tx) => readPublicGuild(tx, slug));
}
export async function readGuildUpdatesFromHost(
  slug: string,
  query: { limit?: number; before?: string },
) {
  return runCommandTransaction(db, (tx) => listPublicGuildUpdates(tx, slug, query));
}
