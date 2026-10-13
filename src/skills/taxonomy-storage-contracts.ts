import { z } from 'zod';
import { InternalId } from '../contracts/ids';
import { SkillTaxonomyUpdateInputSchema } from './contracts';
/** Existing audit/projection revisions are PostgreSQL INTEGER. Pure preparation remains wider. */
export const PublishSkillTaxonomyInputSchema = SkillTaxonomyUpdateInputSchema.extend({
  expectedRevision: z.number().int().min(0).max(2147483646),
});
export const SkillTaxonomyActorSchema = z
  .strictObject({
    accountId: InternalId,
    sessionHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .readonly();
export type SkillTaxonomyActor = z.infer<typeof SkillTaxonomyActorSchema>;
export interface SkillTaxonomyStorageOptions {
  readonly allowNewWrites: boolean;
  /** Trusted synchronous current scoped policy; receives locked DB facts, never client flags. */
  readonly canPublish: (actor: Readonly<{ accountId: string; xId: string }>) => boolean;
}
export interface PublishSkillTaxonomyCommand {
  readonly actor: SkillTaxonomyActor;
  readonly input: unknown;
  readonly idempotencyKey: string;
  readonly requestId: string;
}
export class SkillTaxonomyStorageError extends Error {
  constructor(
    readonly code:
      | 'INVALID_INPUT'
      | 'AUTHENTICATION_REQUIRED'
      | 'ACCOUNT_RESTRICTED'
      | 'FORBIDDEN'
      | 'WRITES_DISABLED'
      | 'STORAGE_CONTRACT'
      | 'STORAGE_UNAVAILABLE',
  ) {
    super(code);
    this.name = 'SkillTaxonomyStorageError';
  }
}
