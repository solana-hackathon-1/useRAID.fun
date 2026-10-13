import { z } from 'zod';
import { InternalId } from '../contracts/ids';
import { SavedOrientationSchema } from './storage-contracts';
export const OrientationCatalogSchema = z
  .array(z.object({ id: InternalId, label: z.string().trim().min(1).max(80) }).strict())
  .max(1000)
  .refine((items) => new Set(items.map((i) => i.id)).size === items.length);
export const OrientationStateSchema = z
  .object({
    version: z.literal('v1'),
    orientation: SavedOrientationSchema.nullable(),
    catalog: OrientationCatalogSchema,
    writesAvailable: z.boolean(),
    unavailableReason: z.enum(['DISABLED', 'NOT_CONFIGURED']).nullable(),
  })
  .strict();
export type OrientationState = z.infer<typeof OrientationStateSchema>;
