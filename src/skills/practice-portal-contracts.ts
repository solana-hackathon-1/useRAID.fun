import { z } from 'zod';
import { InternalId } from '../contracts/ids';
import { StoredPracticeTrialDefinitionSchema } from './practice-trial-storage-contracts';
/** Public/synthetic definition only. Publisher account and all private submissions are absent. */
export const PracticePortalTrialSchema = StoredPracticeTrialDefinitionSchema.unwrap()
  .omit({ publishedByAccountId: true })
  .readonly();
export const PracticePortalListInputSchema = z
  .strictObject({
    version: z.literal('v1'),
    taxonomyId: InternalId,
    after: InternalId.nullable(),
  })
  .readonly();
export const PracticePortalCatalogSchema = z
  .strictObject({
    version: z.literal('v1'),
    taxonomyId: InternalId,
    trials: z.array(PracticePortalTrialSchema).max(50).readonly(),
    nextCursor: InternalId.nullable(),
  })
  .readonly();
export class PracticePortalError extends Error {
  constructor(
    readonly code:
      'INVALID_INPUT' | 'RESOURCE_UNAVAILABLE' | 'STORAGE_CONTRACT' | 'STORAGE_UNAVAILABLE',
  ) {
    super(code);
    this.name = 'PracticePortalError';
  }
}
