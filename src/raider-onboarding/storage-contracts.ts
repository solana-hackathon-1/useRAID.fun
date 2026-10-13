import { z } from 'zod';
import { RaiderOrientationInputSchema } from './contracts';

/** The trusted host derives these values from its current cookie, never request JSON. */
export interface OrientationActor {
  accountId: string;
  actorAccountId: string;
  sessionHash: string;
}
export interface OrientationSaveOptions {
  allowNewWrites: boolean;
}
export interface SaveOrientationCommand {
  actor: OrientationActor;
  idempotencyKey: string;
  requestId: string;
  input: unknown;
}
export const SaveRaiderOrientationInputSchema = z
  .object({
    expectedRevision: z.number().int().min(0).max(2147483646),
    preferences: RaiderOrientationInputSchema,
  })
  .strict();
const StoredPreferencesSchema = RaiderOrientationInputSchema.extend({
  evidencePath: z.enum(['PORTFOLIO', 'TRIAL']).nullable(),
  portfolioUrl: RaiderOrientationInputSchema.shape.portfolioUrl.unwrap().unwrap().nullable(),
}).strict();
export const SavedOrientationSchema = z
  .object({
    version: z.literal('v1'),
    state: z.literal('RECORDED'),
    revision: z.number().int().positive(),
    recordedAt: z.iso.datetime(),
    preferences: StoredPreferencesSchema,
  })
  .strict();
export type SavedOrientation = z.infer<typeof SavedOrientationSchema>;
export class OrientationStorageError extends Error {
  constructor(
    readonly code:
      | 'INVALID_INPUT'
      | 'WRONG_ACTOR'
      | 'UNAUTHENTICATED'
      | 'ACCOUNT_RESTRICTED'
      | 'WRITES_DISABLED'
      | 'REVISION_CONFLICT'
      | 'STORAGE_CONTRACT'
      | 'STORAGE_UNAVAILABLE',
  ) {
    super(code);
    this.name = 'OrientationStorageError';
  }
}
