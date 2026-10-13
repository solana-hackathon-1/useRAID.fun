import type { GuildDraftActor, GuildDraftCommand } from '../guild-profiles/draft-storage-contracts';
import { config } from './config';
import { db } from './db';
import { runCommandTransaction } from './command-receipts-adapter';
import { readGuildDraft, saveGuildDraft } from '../guild-profiles/draft-storage';
export function guildDraftWriteConfiguration() {
  const writesAvailable = !config.demo && process.env.GUILD_DRAFTS_ENABLED === 'true';
  return { writesAvailable, unavailableReason: writesAvailable ? null : ('DISABLED' as const) };
}
export async function readGuildDraftState(actor: GuildDraftActor, id: string) {
  const draft = await runCommandTransaction(db, (tx) => readGuildDraft(tx, actor, id));
  return { version: 'v1' as const, draft, ...guildDraftWriteConfiguration() };
}
export async function saveDraft(command: GuildDraftCommand) {
  return runCommandTransaction(db, (tx) =>
    saveGuildDraft(tx, command, { allowNewWrites: guildDraftWriteConfiguration().writesAvailable }),
  );
}
