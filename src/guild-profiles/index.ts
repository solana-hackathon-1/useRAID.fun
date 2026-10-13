import {
  GuildProfileContractError,
  GuildProfileDraftInputSchema,
  GuildPublicProjectionSourceSchema,
  GuildProfilePermissionFactsSchema,
  GuildProfilePermissionRequestSchema,
  GuildProfileFieldSchema,
  type GuildProfileDecisionReason,
} from './contracts';
export * from './contracts';
/** Preparation only: no id/store, founder verification, token relationship or permission side effect. */
export function prepareGuildProfileDraft(input: unknown) {
  const parsed = GuildProfileDraftInputSchema.safeParse(input);
  if (!parsed.success) throw new GuildProfileContractError('INVALID_INPUT');
  return Object.freeze({
    version: 'v1' as const,
    state: 'DRAFT_PROPOSAL' as const,
    persisted: false as const,
    founderControlVerified: false as const,
    createsPermissionGrant: false as const,
    profile: Object.freeze({ ...parsed.data, primaryToken: null }),
  });
}
/** Host supplies approved public fields from its authoritative record; private data is never copied. */
export function projectPublicGuildProfile(record: unknown) {
  const parsed = GuildPublicProjectionSourceSchema.safeParse(record);
  if (!parsed.success) throw new GuildProfileContractError('INVALID_HOST_CONTRACT');
  const { guild, publicProfile, publicProfileApproved } = parsed.data;
  if (!publicProfileApproved) throw new GuildProfileContractError('PUBLIC_PROFILE_UNAVAILABLE');
  if (
    guild.id !== publicProfile.id ||
    JSON.stringify(guild.primaryToken) !== JSON.stringify(publicProfile.primaryToken)
  )
    throw new GuildProfileContractError('INVALID_HOST_CONTRACT');
  return Object.freeze({
    id: publicProfile.id,
    slug: publicProfile.slug,
    name: publicProfile.name,
    description: publicProfile.description,
    primaryToken:
      publicProfile.primaryToken === null ? null : Object.freeze({ ...publicProfile.primaryToken }),
  });
}
/** Informational policy only. The command host must authenticate and rebuild facts under its locks. */
export function evaluateGuildProfilePermission(facts: unknown, request: unknown) {
  const parsed = GuildProfilePermissionFactsSchema.safeParse(facts);
  if (!parsed.success) throw new GuildProfileContractError('INVALID_HOST_CONTRACT');
  const command = GuildProfilePermissionRequestSchema.safeParse(request);
  if (!command.success) throw new GuildProfileContractError('INVALID_INPUT');
  const data = parsed.data;
  const target = command.data;
  const decision = (reason: GuildProfileDecisionReason) =>
    Object.freeze({
      version: 'v1' as const,
      allowed: reason === 'ALLOWED',
      reason,
      informational: true as const,
      isAuthorizationToken: false as const,
      persists: false as const,
    });
  if (!data.actorSessionAuthorized || data.actorAccountId === null)
    return decision('AUTHENTICATION_REQUIRED');
  if (data.actorRestricted) return decision('ACCOUNT_RESTRICTED');
  if (data.guild.id !== target.guildId) return decision('WRONG_GUILD');
  if (data.guild.revision !== target.expectedRevision) return decision('REVISION_CHANGED');
  if (!['EDIT_PROFILE', 'DELEGATE_PROFILE'].includes(target.action))
    return decision('UNSUPPORTED_ACTION');
  if (target.fields.some((field) => !GuildProfileFieldSchema.safeParse(field).success))
    return decision('UNSUPPORTED_FIELD');
  if (!data.founderControlVerified) return decision('FOUNDER_VERIFICATION_REQUIRED');
  if (data.actorAccountId === data.guild.founderAccountId) return decision('ALLOWED');
  const live = data.grants.filter(
    (grant) =>
      grant.guildId === target.guildId &&
      grant.granteeAccountId === data.actorAccountId &&
      grant.status === 'ACTIVE' &&
      Date.parse(grant.validFrom) <= Date.parse(data.now) &&
      (grant.expiresAt === null || Date.parse(grant.expiresAt) > Date.parse(data.now)) &&
      (target.action !== 'DELEGATE_PROFILE' || grant.canDelegateProfile),
  );
  return decision(
    target.fields.every((field) =>
      live.some((grant) => grant.fields.includes(field as 'name' | 'description')),
    )
      ? 'ALLOWED'
      : 'PERMISSION_NOT_GRANTED',
  );
}
