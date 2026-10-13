import { z } from 'zod';
import { SavedGuildDraftSchema } from './draft-storage-contracts';
export const GuildDraftHttpStateSchema = z
  .strictObject({
    version: z.literal('v1'),
    draft: SavedGuildDraftSchema,
    writesAvailable: z.boolean(),
    unavailableReason: z.literal('DISABLED').nullable(),
  })
  .refine((s) => s.writesAvailable === (s.unavailableReason === null));
export const GuildDraftHttpSavedSchema = z.strictObject({
  status: z.enum(['EXECUTED', 'REPLAYED']),
  draft: SavedGuildDraftSchema,
});
export const GuildDraftFormStateSchema = z
  .strictObject({
    version: z.literal('v1'),
    draft: SavedGuildDraftSchema.nullable(),
    writesAvailable: z.boolean(),
    unavailableReason: z.literal('DISABLED').nullable(),
  })
  .refine((s) => s.writesAvailable === (s.unavailableReason === null));
export type GuildDraftFormState = z.infer<typeof GuildDraftFormStateSchema>;
