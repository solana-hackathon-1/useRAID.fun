import { z } from 'zod';
import {
  SavedGuildProjectProposalSchema,
  SaveGuildProjectProposalInputSchema,
} from './project-proposal-contracts';
const fields = {
  version: z.literal('v1'),
  guildDraftId: z.uuid().transform((id) => id.toLowerCase()),
  writesAvailable: z.boolean(),
  unavailableReason: z.literal('DISABLED').nullable(),
};
export const GuildProjectProposalHttpInputSchema = SaveGuildProjectProposalInputSchema.omit({
  guildDraftId: true,
}).strict();
export const GuildProjectProposalHttpStateSchema = z
  .strictObject({ ...fields, proposal: SavedGuildProjectProposalSchema.nullable() })
  .refine((s) => s.writesAvailable === (s.unavailableReason === null))
  .refine((s) => s.proposal === null || s.proposal.guildDraftId.toLowerCase() === s.guildDraftId);
export const GuildProjectProposalHttpSavedSchema = z
  .strictObject({
    ...fields,
    status: z.enum(['EXECUTED', 'REPLAYED']),
    proposal: SavedGuildProjectProposalSchema,
  })
  .refine((s) => s.writesAvailable === (s.unavailableReason === null))
  .refine((s) => s.proposal.guildDraftId.toLowerCase() === s.guildDraftId);
export type GuildProjectProposalHttpState = z.infer<typeof GuildProjectProposalHttpStateSchema>;
