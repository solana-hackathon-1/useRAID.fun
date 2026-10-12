import { z } from 'zod';
import { InternalId } from '../contracts/ids';

const InterestId = InternalId;
function timezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
function publicPortfolio(value: string): boolean {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}
function internalPath(value: string): boolean {
  if (!value.startsWith('/') || value.startsWith('//') || value.trim() !== value) return false;
  try {
    return new URL(value, 'https://onboarding.invalid').origin === 'https://onboarding.invalid';
  } catch {
    return false;
  }
}
/** Self-described preferences; neither assessed skill nor a completed/persisted orientation. */
export const RaiderOrientationInputSchema = z
  .object({
    experience: z.enum(['BEGINNER', 'EXPERIENCED']),
    workInterests: z.array(InterestId).min(1).max(10),
    timezone: z.string().trim().min(1).max(80).refine(timezone),
    orientationAcknowledged: z.literal(true),
    evidencePath: z.enum(['PORTFOLIO', 'TRIAL']).optional(),
    portfolioUrl: z.string().trim().max(2048).refine(publicPortfolio).nullable().optional(),
  })
  .strict();
const Capability = z.discriminatedUnion('available', [
  z
    .object({ available: z.literal(true), href: z.string().max(2048).refine(internalPath) })
    .strict(),
  z
    .object({ available: z.literal(false), reason: z.enum(['NOT_CONFIGURED', 'NOT_READY']) })
    .strict(),
]);
/** Trusted host declarations of actually implemented navigation, never action authorization. */
export const RaiderOnboardingHostSchema = z
  .object({
    version: z.literal('v1'),
    interestIds: z
      .array(InterestId)
      .min(1)
      .max(1000)
      .refine((ids) => new Set(ids).size === ids.length),
    nextActions: z
      .object({ starterTasks: Capability, portfolio: Capability, trial: Capability })
      .strict(),
  })
  .strict();
export type RaiderOrientationInput = z.infer<typeof RaiderOrientationInputSchema>;
export type RaiderOnboardingHost = z.infer<typeof RaiderOnboardingHostSchema>;
export class OnboardingContractError extends Error {
  constructor(readonly code: 'INVALID_INPUT' | 'INVALID_HOST_CONTRACT') {
    super(code);
    this.name = 'OnboardingContractError';
  }
}
