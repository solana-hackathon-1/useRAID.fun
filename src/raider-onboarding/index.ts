import {
  OnboardingContractError,
  RaiderOnboardingHostSchema,
  RaiderOrientationInputSchema,
} from './contracts';
export {
  OnboardingContractError,
  RaiderOnboardingHostSchema,
  RaiderOrientationInputSchema,
} from './contracts';
export type * from './contracts';

/**
 * Prepare unpaid orientation from self-described preferences and host-declared routes.
 * No account lookup, persistence, assessment, capacity, permission or payment side effect.
 * Hosts must authorize stored data and recheck every actual action at its server boundary.
 */
export function prepareRaiderOrientation(input: unknown, host: unknown) {
  const options = RaiderOnboardingHostSchema.safeParse(host);
  if (!options.success) throw new OnboardingContractError('INVALID_HOST_CONTRACT');
  const parsed = RaiderOrientationInputSchema.safeParse(input);
  if (!parsed.success) throw new OnboardingContractError('INVALID_INPUT');
  const data = parsed.data;
  const allowed = new Set(options.data.interestIds);
  if (data.workInterests.some((id) => !allowed.has(id)))
    throw new OnboardingContractError('INVALID_INPUT');
  const kind =
    data.evidencePath ?? (data.experience === 'BEGINNER' ? 'STARTER_TASKS' : 'PORTFOLIO');
  const capability =
    options.data.nextActions[
      kind === 'STARTER_TASKS' ? 'starterTasks' : kind === 'PORTFOLIO' ? 'portfolio' : 'trial'
    ];
  const nextAction = Object.freeze(
    capability.available
      ? { kind, available: true as const, href: capability.href }
      : { kind, available: false as const, reason: capability.reason, href: null },
  );
  return Object.freeze({
    version: 'v1' as const,
    state: 'PREPARED' as const,
    persisted: false as const,
    assignsVerifiedSkill: false as const,
    reservesCapacity: false as const,
    authorizesPaidCommitment: false as const,
    requiresVerifiedPayoutForPaidWork: true as const,
    preferences: Object.freeze({
      experience: data.experience,
      workInterests: Object.freeze([...new Set(data.workInterests)].sort()),
      timezone: data.timezone,
      orientationAcknowledged: true as const,
      evidencePath: data.evidencePath ?? null,
      portfolioUrl: data.portfolioUrl ?? null,
    }),
    nextAction,
  });
}
export type RaiderOrientationPlan = ReturnType<typeof prepareRaiderOrientation>;
