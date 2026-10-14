import { z } from 'zod';
import {
  PracticeTrialDiscoveryContextSchema,
  PracticeTrialAttemptContextSchema,
  PracticeTrialAttemptInputSchema,
  PracticeTrialPolicySchema,
  PracticeTrialContractError,
  type PracticeTrialDefinition,
  type PracticeTrialPolicy,
} from './practice-trial-contracts';

function parse<S extends z.ZodType>(
  schema: S,
  value: unknown,
  code: 'INVALID_INPUT' | 'INVALID_HOST_CONTRACT',
): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new PracticeTrialContractError(code);
  return result.data;
}
function approved(check: () => boolean): boolean {
  try {
    return check() === true;
  } catch {
    throw new PracticeTrialContractError('HOST_POLICY_UNAVAILABLE');
  }
}
function sameReference(
  a: { recordId: string; revision: number },
  b: { recordId: string; revision: number },
) {
  return a.recordId === b.recordId && a.revision === b.revision;
}
function current(observation: { observedAt: string; validUntil: string }, now: string) {
  return (
    Date.parse(observation.observedAt) <= Date.parse(now) &&
    Date.parse(now) < Date.parse(observation.validUntil)
  );
}
function definitionFor(
  context: z.output<typeof PracticeTrialDiscoveryContextSchema>,
  policy: PracticeTrialPolicy,
): PracticeTrialDefinition {
  const { definition, taxonomy, now } = context;
  if (
    Date.parse(taxonomy.publishedAt) > Date.parse(now) ||
    Date.parse(definition.publishedAt) > Date.parse(now)
  )
    throw new PracticeTrialContractError('INVALID_HOST_CONTRACT');
  const skill = taxonomy.skills.find((item) => item.id === definition.skillId);
  if (!skill || skill.status !== 'ACTIVE' || skill.domain !== definition.skillDomain)
    throw new PracticeTrialContractError('SKILL_UNAVAILABLE');
  if (!approved(() => policy.isApprovedDefinition(definition, now)))
    throw new PracticeTrialContractError('DEFINITION_UNAVAILABLE');
  return definition;
}
/** Safe public/synthetic approved policy only. Shape and publication flags do not prove approval. */
export function readPracticeTrial(
  contextValue: unknown,
  policyValue: unknown,
): PracticeTrialDefinition {
  const context = parse(PracticeTrialDiscoveryContextSchema, contextValue, 'INVALID_HOST_CONTRACT');
  const policy = parse(PracticeTrialPolicySchema, policyValue, 'INVALID_HOST_CONTRACT');
  return definitionFor(context, policy);
}
/** Private preparation; a durable host must atomically recheck and consume history before starting. */
export function preparePracticeTrialAttempt(
  contextValue: unknown,
  inputValue: unknown,
  policyValue: unknown,
) {
  const context = parse(PracticeTrialAttemptContextSchema, contextValue, 'INVALID_HOST_CONTRACT');
  const input = parse(PracticeTrialAttemptInputSchema, inputValue, 'INVALID_INPUT');
  const policy = parse(PracticeTrialPolicySchema, policyValue, 'INVALID_HOST_CONTRACT');
  if (!context.actorAccountId || !context.actorSessionAuthorized)
    throw new PracticeTrialContractError('AUTHENTICATION_REQUIRED');
  if (context.actorRestricted) throw new PracticeTrialContractError('ACCOUNT_RESTRICTED');
  if (context.participant.kind !== 'HUMAN')
    throw new PracticeTrialContractError('RESOURCE_UNAVAILABLE');
  if (context.participant.accountId !== context.actorAccountId)
    throw new PracticeTrialContractError('FORBIDDEN');
  const definition = definitionFor(context, policy);
  if (!sameReference(input.definitionReference, definition.reference))
    throw new PracticeTrialContractError('REVISION_CHANGED');
  const history = context.attemptHistory;
  if (
    history.status !== 'CURRENT' ||
    history.participantId !== context.participant.id ||
    history.trialId !== definition.reference.recordId ||
    !current(history, context.now)
  )
    throw new PracticeTrialContractError('ATTEMPT_HISTORY_UNAVAILABLE');
  if (
    (history.attemptsUsed === 0) !== (history.lastAttemptAt === null) ||
    (history.lastAttemptAt !== null &&
      Date.parse(history.lastAttemptAt) > Date.parse(history.observedAt))
  )
    throw new PracticeTrialContractError('INVALID_HOST_CONTRACT');
  const accommodation = context.accommodation;
  if (
    accommodation === null
      ? input.accommodationReference !== null
      : input.accommodationReference === null ||
        !sameReference(input.accommodationReference, accommodation.reference) ||
        accommodation.participantId !== context.participant.id ||
        !sameReference(accommodation.definitionReference, definition.reference) ||
        !current(accommodation, context.now) ||
        !approved(() => policy.isApprovedAccommodation(accommodation, context.now))
  )
    throw new PracticeTrialContractError('ACCOMMODATION_UNAVAILABLE');
  const limits = accommodation ?? definition;
  if (history.attemptsUsed >= limits.maximumAttempts)
    throw new PracticeTrialContractError('ATTEMPT_LIMIT_REACHED');
  if (
    history.lastAttemptAt !== null &&
    Date.parse(context.now) - Date.parse(history.lastAttemptAt) < limits.cooldownSeconds * 1000
  )
    throw new PracticeTrialContractError('COOLDOWN_ACTIVE');
  return Object.freeze({
    version: 'v1' as const,
    state: 'PREPARED' as const,
    participantId: context.participant.id,
    definitionReference: definition.reference,
    rubricReference: definition.rubric.reference,
    taxonomyReference: Object.freeze({
      recordId: context.taxonomy.id,
      revision: context.taxonomy.revision,
    }),
    accommodationReference: accommodation?.reference ?? null,
    skillId: definition.skillId,
    skillDomain: definition.skillDomain,
    targetRank: definition.targetRank,
    variantId: definition.variantId,
    preparedAt: new Date(context.now).toISOString(),
    attemptNumber: history.attemptsUsed + 1,
    expectedMinutes: limits.expectedMinutes,
    persisted: false as const,
    verifiesSkill: false as const,
    isAuthorizationToken: false as const,
    createsPermissionGrant: false as const,
    consumesCapacity: false as const,
    createsFinancialObligation: false as const,
  });
}
