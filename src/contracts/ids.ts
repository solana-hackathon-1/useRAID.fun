import { z } from 'zod';
// Opaque internal identifiers; never derive canonical identity from a wallet.
export const InternalId = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const AccountId = InternalId.brand<'AccountId'>();
export const ParticipantId = InternalId.brand<'ParticipantId'>();
export const OperatorId = InternalId.brand<'OperatorId'>();
export const GuildId = InternalId.brand<'GuildId'>();
export const TermsVersionId = InternalId.brand<'TermsVersionId'>();
export const EngagementId = InternalId.brand<'EngagementId'>();
export const UtcTimestamp = z.iso.datetime();
export const Revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export type AccountId = z.infer<typeof AccountId>;
export type ParticipantId = z.infer<typeof ParticipantId>;
export type OperatorId = z.infer<typeof OperatorId>;
export type GuildId = z.infer<typeof GuildId>;
export type TermsVersionId = z.infer<typeof TermsVersionId>;
export type EngagementId = z.infer<typeof EngagementId>;
