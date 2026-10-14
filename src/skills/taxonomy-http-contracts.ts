import { z } from 'zod';
import { PublishSkillTaxonomyInputSchema } from './taxonomy-storage-contracts';
import { PublishedSkillTaxonomySchema } from './contracts';
export const SkillTaxonomyHttpInputSchema = PublishSkillTaxonomyInputSchema.omit({
  taxonomyId: true,
}).strict();
export const SkillTaxonomyHttpPublishedSchema = z
  .strictObject({
    version: z.literal('v1'),
    status: z.enum(['EXECUTED', 'REPLAYED']),
    taxonomy: PublishedSkillTaxonomySchema,
    writesAvailable: z.boolean(),
    unavailableReason: z.literal('DISABLED').nullable(),
  })
  .refine((v) => v.writesAvailable === (v.unavailableReason === null));
export type SkillTaxonomyHttpInput = z.infer<typeof SkillTaxonomyHttpInputSchema>;
export type SkillTaxonomyHttpPublished = z.infer<typeof SkillTaxonomyHttpPublishedSchema>;
