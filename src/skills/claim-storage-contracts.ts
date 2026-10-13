import { z } from 'zod';
import { InternalId, ParticipantId, UtcTimestamp } from '../contracts/ids';
import { SkillClaimInputSchema } from './contracts';
import { SkillTaxonomyActorSchema, type SkillTaxonomyActor } from './taxonomy-storage-contracts';
export const SkillClaimActorSchema = SkillTaxonomyActorSchema;
export type SkillClaimActor = SkillTaxonomyActor;
export const SaveSkillClaimInputSchema = SkillClaimInputSchema.extend({
  taxonomyId: InternalId,
  expectedTaxonomyRevision: z.number().int().min(1).max(2147483647),
  expectedClaimRevision: z.number().int().min(0).max(2147483646),
});
/** Claimant-controlled facts only. Assessment/rank/history have separate authority and ownership. */
export const SavedSkillClaimSchema = z
  .strictObject({
    version: z.literal('v1'),
    id: z.uuid(),
    revision: z.number().int().min(1).max(2147483647),
    state: z.literal('CLAIMED'),
    participantId: ParticipantId,
    skillId: InternalId,
    skillDomain: InternalId,
    taxonomyReference: z
      .strictObject({ recordId: InternalId, revision: z.number().int().min(1).max(2147483647) })
      .readonly(),
    recordedAt: UtcTimestamp.refine((v) => (v.match(/\.(\d+)Z$/)?.[1]?.length ?? 0) <= 3),
    claimedLevel: SkillClaimInputSchema.shape.claimedLevel,
    supportingReferences: SkillClaimInputSchema.shape.supportingReferences,
    persisted: z.literal(true),
    informational: z.literal(true),
    isAuthorizationToken: z.literal(false),
    verifiesSkill: z.literal(false),
    createsPermissionGrant: z.literal(false),
    consumesCapacity: z.literal(false),
  })
  .readonly();
export type SavedSkillClaim = z.infer<typeof SavedSkillClaimSchema>;
export interface SaveSkillClaimCommand {
  readonly actor: SkillClaimActor;
  readonly input: unknown;
  readonly idempotencyKey: string;
  readonly requestId: string;
}
export interface SkillClaimSaveOptions {
  readonly allowNewWrites: boolean;
}
export class SkillClaimStorageError extends Error {
  constructor(
    readonly code:
      | 'INVALID_INPUT'
      | 'AUTHENTICATION_REQUIRED'
      | 'ACCOUNT_RESTRICTED'
      | 'RESOURCE_UNAVAILABLE'
      | 'WRITES_DISABLED'
      | 'STORAGE_CONTRACT'
      | 'STORAGE_UNAVAILABLE',
  ) {
    super(code);
    this.name = 'SkillClaimStorageError';
  }
}
