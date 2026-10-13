import type { z } from 'zod';
import {
  PublishedSkillTaxonomySchema,
  SkillTaxonomyUpdateInputSchema,
  SkillAliasSchema,
  SkillClaimContextSchema,
  SkillClaimInputSchema,
  SkillClaimContractError,
} from './contracts';
export * from './contracts';
function parse<T>(
  schema: z.ZodType<T>,
  value: unknown,
  code: 'INVALID_INPUT' | 'INVALID_HOST_CONTRACT',
): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new SkillClaimContractError(code);
  return result.data;
}
/** Preparation only. Host authorizes actual catalog administration/publication and preserves old versions. */
export function prepareSkillTaxonomyUpdate(previousValue: unknown, inputValue: unknown) {
  const previous =
    previousValue === null
      ? null
      : parse(PublishedSkillTaxonomySchema, previousValue, 'INVALID_HOST_CONTRACT');
  const input = parse(SkillTaxonomyUpdateInputSchema, inputValue, 'INVALID_INPUT');
  if (
    input.expectedRevision !== (previous?.revision ?? 0) ||
    (previous && input.taxonomyId !== previous.id) ||
    input.expectedRevision === Number.MAX_SAFE_INTEGER
  )
    throw new SkillClaimContractError('REVISION_CHANGED');
  if (previous)
    for (const old of previous.skills) {
      const current = input.skills.find((skill) => skill.id === old.id);
      if (
        !current ||
        current.domain !== old.domain ||
        old.aliases.some((alias) => !current.aliases.includes(alias))
      )
        throw new SkillClaimContractError('HISTORY_CONFLICT');
    }
  return Object.freeze({
    version: 'v1' as const,
    state: 'TAXONOMY_UPDATE_PROPOSAL' as const,
    persisted: false as const,
    publishesTaxonomy: false as const,
    createsPermissionGrant: false as const,
    taxonomy: Object.freeze({
      id: input.taxonomyId,
      revision: input.expectedRevision + 1,
      skills: input.skills,
    }),
  });
}
export function resolveSkillAlias(catalogValue: unknown, aliasValue: unknown) {
  const catalog = parse(PublishedSkillTaxonomySchema, catalogValue, 'INVALID_HOST_CONTRACT');
  const alias = parse(SkillAliasSchema, aliasValue, 'INVALID_INPUT');
  const skill = catalog.skills.find((s) => s.aliases.includes(alias));
  if (!skill || skill.status !== 'ACTIVE') throw new SkillClaimContractError('SKILL_UNAVAILABLE');
  return Object.freeze({
    skillId: skill.id,
    domain: skill.domain,
    name: skill.name,
    taxonomyReference: Object.freeze({ recordId: catalog.id, revision: catalog.revision }),
  });
}
/** Private unverified preparation only; creates neither participant nor assessment/rank/access/capacity. */
export function prepareSkillClaim(contextValue: unknown, inputValue: unknown) {
  const context = parse(SkillClaimContextSchema, contextValue, 'INVALID_HOST_CONTRACT');
  const input = parse(SkillClaimInputSchema, inputValue, 'INVALID_INPUT');
  if (!context.actorAccountId || !context.actorSessionAuthorized)
    throw new SkillClaimContractError('AUTHENTICATION_REQUIRED');
  if (context.actorRestricted) throw new SkillClaimContractError('ACCOUNT_RESTRICTED');
  if (context.participant.kind !== 'HUMAN')
    throw new SkillClaimContractError('RESOURCE_UNAVAILABLE');
  if (context.participant.accountId !== context.actorAccountId)
    throw new SkillClaimContractError('FORBIDDEN');
  if (Date.parse(context.taxonomy.publishedAt) > Date.parse(context.now))
    throw new SkillClaimContractError('INVALID_HOST_CONTRACT');
  const skill = context.taxonomy.skills.find((s) => s.id === input.skillId);
  if (!skill || skill.status !== 'ACTIVE') throw new SkillClaimContractError('SKILL_UNAVAILABLE');
  return Object.freeze({
    version: 'v1' as const,
    state: 'CLAIMED' as const,
    participantId: context.participant.id,
    skillId: skill.id,
    skillDomain: skill.domain,
    taxonomyReference: Object.freeze({
      recordId: context.taxonomy.id,
      revision: context.taxonomy.revision,
    }),
    preparedAt: new Date(context.now).toISOString(),
    claimedLevel: input.claimedLevel,
    supportingReferences: input.supportingReferences,
    assessedRank: null,
    rubric: null,
    evaluator: null,
    confidence: null,
    sampleSize: 0,
    issuedAt: null,
    reassessmentAt: null,
    assessmentHistory: Object.freeze([]),
    informational: true as const,
    isAuthorizationToken: false as const,
    persisted: false as const,
    verifiesSkill: false as const,
    createsPermissionGrant: false as const,
    consumesCapacity: false as const,
  });
}
