import { z } from 'zod';
import { PublicGuildSchema, GuildSchema } from '../contracts/entities';
import { AccountId, GuildId, InternalId, Revision, UtcTimestamp } from '../contracts/ids';
const MillisecondUtcTimestamp = UtcTimestamp.refine((value) => {
  const fraction = value.match(/\.(\d+)Z$/)?.[1];
  return !fraction || fraction.length <= 3;
});
export const GuildProfileFieldSchema = z.enum(['name', 'description']);
export const GuildProfileDraftInputSchema = PublicGuildSchema.pick({
  name: true,
  slug: true,
  description: true,
})
  .extend({
    name: z.string().trim().pipe(PublicGuildSchema.shape.name),
    slug: z.string().trim().pipe(PublicGuildSchema.shape.slug),
    description: z.string().trim().pipe(PublicGuildSchema.shape.description),
  })
  .strict();
export const GuildPublicProjectionSourceSchema = z
  .object({
    version: z.literal('v1'),
    guild: GuildSchema,
    publicProfile: PublicGuildSchema,
    publicProfileApproved: z.boolean(),
    privateContext: z.unknown().optional(),
  })
  .strict();
export const GuildProfileGrantSchema = z
  .object({
    id: InternalId,
    guildId: GuildId,
    granteeAccountId: AccountId,
    status: z.enum(['ACTIVE', 'REVOKED']),
    fields: z
      .array(GuildProfileFieldSchema)
      .min(1)
      .max(2)
      .refine((a) => new Set(a).size === a.length),
    canDelegateProfile: z.boolean(),
    validFrom: MillisecondUtcTimestamp,
    expiresAt: MillisecondUtcTimestamp.nullable(),
  })
  .strict()
  .refine((g) => g.expiresAt === null || Date.parse(g.expiresAt) > Date.parse(g.validFrom));
/** Trusted host facts, not HTTP input. No global role/token balance creates these grants. */
export const GuildProfilePermissionFactsSchema = z
  .object({
    version: z.literal('v1'),
    guild: GuildSchema,
    founderControlVerified: z.boolean(),
    actorAccountId: AccountId.nullable(),
    actorSessionAuthorized: z.boolean(),
    actorRestricted: z.boolean(),
    holderEligible: z.boolean().nullable(),
    now: MillisecondUtcTimestamp,
    grants: z
      .array(GuildProfileGrantSchema)
      .max(1000)
      .refine((grants) => new Set(grants.map((grant) => grant.id)).size === grants.length),
  })
  .strict();
export const GuildProfilePermissionRequestSchema = z
  .object({
    guildId: GuildId,
    expectedRevision: Revision,
    action: z.string().min(1).max(64),
    fields: z.array(z.string().min(1).max(80)).min(1).max(20),
  })
  .strict();
export type GuildProfilePermissionFacts = z.infer<typeof GuildProfilePermissionFactsSchema>;
export type GuildProfilePermissionRequest = z.infer<typeof GuildProfilePermissionRequestSchema>;
export type GuildProfileDecisionReason =
  | 'ALLOWED'
  | 'AUTHENTICATION_REQUIRED'
  | 'ACCOUNT_RESTRICTED'
  | 'WRONG_GUILD'
  | 'REVISION_CHANGED'
  | 'UNSUPPORTED_ACTION'
  | 'UNSUPPORTED_FIELD'
  | 'FOUNDER_VERIFICATION_REQUIRED'
  | 'PERMISSION_NOT_GRANTED';
export class GuildProfileContractError extends Error {
  constructor(
    readonly code: 'INVALID_INPUT' | 'INVALID_HOST_CONTRACT' | 'PUBLIC_PROFILE_UNAVAILABLE',
  ) {
    super(code);
    this.name = 'GuildProfileContractError';
  }
}
