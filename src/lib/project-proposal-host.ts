import type { GuildDraftActor, GuildDraftCommand } from '../guild-profiles/draft-storage-contracts';
import {
  readGuildProjectProposal,
  saveGuildProjectProposal,
} from '../guild-profiles/project-proposal-storage';
import { runCommandTransaction } from './command-receipts-adapter';
import { db } from './db';
import { guildDraftWriteConfiguration } from './guild-draft-host';
export function projectProposalWriteConfiguration() {
  const writesAvailable =
    guildDraftWriteConfiguration().writesAvailable &&
    process.env.GUILD_PROJECT_PROPOSALS_ENABLED === 'true';
  return { writesAvailable, unavailableReason: writesAvailable ? null : ('DISABLED' as const) };
}
export async function readProjectProposalState(actor: GuildDraftActor, id: string) {
  const proposal = await runCommandTransaction(db, (tx) => readGuildProjectProposal(tx, actor, id));
  return {
    version: 'v1' as const,
    guildDraftId: id,
    proposal,
    ...projectProposalWriteConfiguration(),
  };
}
export async function saveProjectProposal(command: GuildDraftCommand) {
  const result = await runCommandTransaction(db, (tx) =>
    saveGuildProjectProposal(tx, command, {
      allowNewWrites: projectProposalWriteConfiguration().writesAvailable,
    }),
  );
  return {
    version: 'v1' as const,
    guildDraftId: result.proposal.guildDraftId,
    ...result,
    ...projectProposalWriteConfiguration(),
  };
}
