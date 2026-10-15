import { z } from 'zod';
import { AccountId, InternalId } from '../contracts/ids';
import { SkillVersionReferenceSchema } from './contracts';
import { PracticeTrialDefinitionSchema } from './practice-trial-contracts';
import type { SkillTaxonomyActor, SkillTaxonomyStorageOptions } from './taxonomy-storage-contracts';
export const PracticeTrialDraftSchema = PracticeTrialDefinitionSchema.unwrap()
  .omit({
    reference: true,
    publishedAt: true,
    state: true,
  })
  .readonly();
const StoredReference = SkillVersionReferenceSchema.unwrap()
  .extend({
    revision: z.number().int().min(1).max(2147483647),
  })
  .readonly();
export const PublishPracticeTrialInputSchema = z
  .strictObject({
    trialId: InternalId,
    expectedRevision: z.number().int().min(0).max(2147483646),
    taxonomyReference: StoredReference,
    availability: z.enum(['AVAILABLE', 'RETIRED']),
    draft: PracticeTrialDraftSchema,
  })
  .superRefine((value, ctx) => {
    if (value.draft.rubric.reference.revision > 2147483647)
      ctx.addIssue({ code: 'custom', message: 'Stored rubric revision exceeds INTEGER.' });
    // Installed string max checks count code points; stored SQL bounds count UTF-16 units.
    // The draft is already normalized, so whitespace accepted previously remains accepted.
    const text = (value: string, maximum: number, path: (string | number)[]) => {
      if (value.length > maximum)
        ctx.addIssue({ code: 'custom', message: 'Stored text exceeds UTF-16 limit.', path });
    };
    const draft = value.draft;
    text(draft.title, 200, ['draft', 'title']);
    text(draft.brief, 4000, ['draft', 'brief']);
    draft.inputs.forEach((input, index) => {
      text(input.label, 200, ['draft', 'inputs', index, 'label']);
      text(input.content, 4000, ['draft', 'inputs', index, 'content']);
    });
    draft.tools.permitted.forEach((tool, index) =>
      text(tool, 200, ['draft', 'tools', 'permitted', index]),
    );
    text(draft.tools.disclosure, 4000, ['draft', 'tools', 'disclosure']);
    draft.rubric.criteria.forEach((criterion, index) =>
      text(criterion.description, 4000, ['draft', 'rubric', 'criteria', index, 'description']),
    );
    text(draft.passConditions, 4000, ['draft', 'passConditions']);
    text(draft.accommodationPolicy, 4000, ['draft', 'accommodationPolicy']);
    // JSONB has no representation for NUL or lone UTF-16 surrogates. Reject before receipt/query.
    const stack: unknown[] = [value];
    while (stack.length) {
      const item = stack.pop();
      if (
        typeof item === 'string' &&
        /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(item)
      ) {
        ctx.addIssue({ code: 'custom', message: 'Unsupported PostgreSQL string.' });
        break;
      }
      if (item && typeof item === 'object') stack.push(...Object.values(item));
    }
  })
  .readonly();
export const StoredPracticeTrialDefinitionSchema = z
  .strictObject({
    version: z.literal('v1'),
    definition: PracticeTrialDefinitionSchema,
    availability: z.enum(['AVAILABLE', 'RETIRED']),
    taxonomyReference: StoredReference,
    publishedByAccountId: AccountId,
    persisted: z.literal(true),
    verifiesSkill: z.literal(false),
    createsPermissionGrant: z.literal(false),
    consumesCapacity: z.literal(false),
    createsFinancialObligation: z.literal(false),
  })
  .readonly();
export type StoredPracticeTrialDefinition = z.output<typeof StoredPracticeTrialDefinitionSchema>;
export interface PublishPracticeTrialCommand {
  readonly actor: SkillTaxonomyActor;
  readonly input: unknown;
  readonly idempotencyKey: string;
  readonly requestId: string;
}
export type PracticeTrialStorageOptions = SkillTaxonomyStorageOptions;
export class PracticeTrialStorageError extends Error {
  constructor(
    readonly code:
      | 'INVALID_INPUT'
      | 'AUTHENTICATION_REQUIRED'
      | 'ACCOUNT_RESTRICTED'
      | 'FORBIDDEN'
      | 'WRITES_DISABLED'
      | 'STORAGE_CONTRACT'
      | 'STORAGE_UNAVAILABLE'
      | 'RESOURCE_UNAVAILABLE'
      | 'REVISION_CHANGED'
      | 'HISTORY_CONFLICT'
      | 'SKILL_UNAVAILABLE'
      | 'RUBRIC_CONFLICT'
      | 'RUBRIC_REVISION_CHANGED',
  ) {
    super(code);
    this.name = 'PracticeTrialStorageError';
  }
}
