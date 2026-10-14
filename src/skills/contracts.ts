import { z } from 'zod';
import { AccountId, InternalId, Revision, UtcTimestamp } from '../contracts/ids';
import { ParticipantSchema } from '../contracts/entities';
/** Immutable skill-owned definition, rubric, evidence or assessment version. */
export const SkillVersionReferenceSchema = z
  .strictObject({ recordId: InternalId, revision: Revision })
  .readonly();
const Timestamp = UtcTimestamp.refine((value) => {
  const fraction = value.match(/\.(\d+)Z$/)?.[1];
  return !fraction || fraction.length <= 3;
});
export const SkillAliasSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);
export const SkillCategorySchema = z
  .strictObject({
    id: InternalId,
    domain: InternalId,
    name: z.string().trim().min(1).max(200),
    status: z.enum(['ACTIVE', 'RETIRED']),
    aliases: z.array(SkillAliasSchema).min(1).max(100).readonly(),
  })
  .readonly();
export const SkillCategoriesSchema = z
  .array(SkillCategorySchema)
  .min(1)
  .max(1000)
  .refine((skills) => {
    const ids = new Set<string>(),
      aliases = new Set<string>();
    for (const skill of skills) {
      if (ids.has(skill.id)) return false;
      ids.add(skill.id);
      for (const alias of skill.aliases) {
        if (aliases.has(alias)) return false;
        aliases.add(alias);
      }
    }
    return true;
  })
  .readonly();
/** Actual admin-published server record, not a candidate or caller approval flag. */
export const PublishedSkillTaxonomySchema = z
  .strictObject({
    version: z.literal('v1'),
    id: InternalId,
    revision: Revision,
    state: z.literal('PUBLISHED'),
    publishedByAccountId: AccountId,
    publishedAt: Timestamp,
    skills: SkillCategoriesSchema,
  })
  .readonly();
export const SkillTaxonomyUpdateInputSchema = z.strictObject({
  taxonomyId: InternalId,
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  skills: SkillCategoriesSchema,
});
export const SkillClaimContextSchema = z.strictObject({
  version: z.literal('v1'),
  now: Timestamp,
  actorAccountId: AccountId.nullable(),
  actorSessionAuthorized: z.boolean(),
  actorRestricted: z.boolean(),
  participant: ParticipantSchema,
  taxonomy: PublishedSkillTaxonomySchema,
});
const Reference = z
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
export const SkillClaimInputSchema = z.strictObject({
  skillId: InternalId,
  claimedLevel: z.string().trim().min(1).max(200),
  supportingReferences: z
    .array(Reference)
    .max(5)
    .refine((values) => new Set(values).size === values.length)
    .readonly(),
});
export type PublishedSkillTaxonomy = z.infer<typeof PublishedSkillTaxonomySchema>;
export type SkillClaimContext = z.infer<typeof SkillClaimContextSchema>;
export type SkillClaimInput = z.infer<typeof SkillClaimInputSchema>;
export class SkillClaimContractError extends Error {
  constructor(
    readonly code:
      | 'INVALID_INPUT'
      | 'INVALID_HOST_CONTRACT'
      | 'REVISION_CHANGED'
      | 'HISTORY_CONFLICT'
      | 'SKILL_UNAVAILABLE'
      | 'AUTHENTICATION_REQUIRED'
      | 'ACCOUNT_RESTRICTED'
      | 'FORBIDDEN'
      | 'RESOURCE_UNAVAILABLE',
  ) {
    super(code);
    this.name = 'SkillClaimContractError';
  }
}
