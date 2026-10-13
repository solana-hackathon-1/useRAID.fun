import { z } from 'zod';
import { TokenAssetIdSchema } from '../contracts/assets';
export { GuildDraftStorageError } from './draft-storage-contracts';
export type {
  GuildDraftActor,
  GuildDraftCommand,
  GuildDraftSaveOptions,
} from './draft-storage-contracts';
const ReferenceUrl = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => {
    try {
      const u = new URL(value);
      return u.protocol === 'https:' && !u.username && !u.password;
    } catch {
      return false;
    }
  })
  .transform((value) => new URL(value).href)
  .pipe(z.string().max(2048));
const References = z
  .array(ReferenceUrl)
  .min(1)
  .max(5)
  .refine((values) => new Set(values).size === values.length)
  .readonly();
export const SaveGuildProjectProposalInputSchema = z.strictObject({
  guildDraftId: z.uuid().transform((id) => id.toLowerCase()),
  expectedDraftRevision: z.number().int().min(1).max(2147483647),
  expectedProposalRevision: z.number().int().min(0).max(2147483646),
  candidateToken: TokenAssetIdSchema,
  publicEvidenceRefs: References,
});
export const SavedGuildProjectProposalSchema = z
  .strictObject({
    version: z.literal('v1'),
    id: z.uuid(),
    guildDraftId: z.uuid(),
    revision: z.number().int().min(1).max(2147483647),
    draftRevision: z.number().int().min(1).max(2147483647),
    recordedAt: z.iso.datetime(),
    projectType: z.literal('EXISTING_PROJECT'),
    state: z.literal('PENDING_VERIFICATION'),
    persisted: z.literal(true),
    candidateToken: TokenAssetIdSchema,
    publicEvidenceRefs: References,
    founderControlVerified: z.literal(false),
    recognizesGuild: z.literal(false),
    activatesToken: z.literal(false),
    createsPermissionGrant: z.literal(false),
    publicProfileApproved: z.literal(false),
  })
  .readonly();
export type SavedGuildProjectProposal = z.infer<typeof SavedGuildProjectProposalSchema>;
