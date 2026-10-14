import { z } from 'zod';
import { InternalId } from '../contracts/ids';
import { SavedSkillClaimSchema, SaveSkillClaimInputSchema } from './claim-storage-contracts';
import { PublishedSkillTaxonomySchema } from './contracts';
export const SkillClaimHttpInputSchema = SaveSkillClaimInputSchema.omit({ skillId: true }).strict();
const availability = {
  writesAvailable: z.boolean(),
  unavailableReason: z.literal('DISABLED').nullable(),
};
export const SkillClaimHttpStateSchema = z
  .strictObject({
    version: z.literal('v1'),
    skillId: InternalId,
    claim: SavedSkillClaimSchema.nullable(),
    ...availability,
  })
  .refine((v) => v.writesAvailable === (v.unavailableReason === null))
  .refine((v) => v.claim === null || v.claim.skillId === v.skillId);
export const SkillClaimHttpSavedSchema = z
  .strictObject({
    version: z.literal('v1'),
    status: z.enum(['EXECUTED', 'REPLAYED']),
    claim: SavedSkillClaimSchema,
    ...availability,
  })
  .refine((v) => v.writesAvailable === (v.unavailableReason === null));
export const SkillCatalogHttpStateSchema = z
  .strictObject({
    version: z.literal('v1'),
    taxonomyId: InternalId,
    taxonomy: PublishedSkillTaxonomySchema.nullable(),
  })
  .refine((v) => v.taxonomy === null || v.taxonomy.id === v.taxonomyId);
export type SkillClaimHttpState = z.infer<typeof SkillClaimHttpStateSchema>;
