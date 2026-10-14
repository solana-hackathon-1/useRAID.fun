import { z } from 'zod';
import { PublishSkillTaxonomyInputSchema } from './taxonomy-storage-contracts';
import { PublishedSkillTaxonomySchema } from './contracts';
import { AccountId, InternalId } from '../contracts/ids';
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
export const SkillTaxonomyEditorStateSchema = z
  .strictObject({
    version: z.literal('v1'),
    taxonomyId: InternalId,
    publisherAccountId: AccountId,
    taxonomy: PublishedSkillTaxonomySchema.nullable(),
    writesAvailable: z.boolean(),
    unavailableReason: z.literal('DISABLED').nullable(),
  })
  .refine((v) => v.writesAvailable === (v.unavailableReason === null))
  .refine((v) => v.taxonomy === null || v.taxonomy.id === v.taxonomyId);
export type SkillTaxonomyEditorState = z.infer<typeof SkillTaxonomyEditorStateSchema>;
export type SkillTaxonomyEditorInput = z.input<typeof SkillTaxonomyEditorStateSchema>;
