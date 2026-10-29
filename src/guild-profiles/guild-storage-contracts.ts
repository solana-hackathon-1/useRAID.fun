import { z } from 'zod';
import type { CommandReceiptTransaction } from '../command-receipts';
import { PublicGuildSchema } from '../contracts/entities';
import { InternalId } from '../contracts/ids';

/** Cookie-derived own authority supplied by the host; never browser JSON. */
export interface GuildActor {
  accountId: string;
  sessionHash: string;
}
export interface GuildCommand {
  actor: GuildActor;
  input: unknown;
  idempotencyKey: string;
  requestId: string;
}
/** Explicit host policy: there is no implicit write default. */
export interface GuildHost {
  allowNewWrites: boolean;
}
/**
 * Founder control of an existing project is verified by a process outside this module (T010 evidence review, O11/G10).
 * The host answers whether this account may record that approval; the module stores the account and the opaque
 * evidence reference it names, and never decides project control itself.
 */
export interface GuildActivationHost extends GuildHost {
  authorizeActivation(
    tx: CommandReceiptTransaction,
    actor: { accountId: string },
  ): Promise<boolean>;
}
/** The host's say over the ownership change itself (for example a recorded re-verification of project control). */
export interface GuildOwnershipHost extends GuildHost {
  authorizeOwnershipTransfer(
    tx: CommandReceiptTransaction,
    change: { guildId: string; fromAccountId: string; toAccountId: string },
  ): Promise<boolean>;
}
export type GuildAuthorityKind = 'PROFILE' | 'WORK' | 'TREASURY' | 'DISPUTE';
export const GUILD_AUTHORITY_KINDS: readonly GuildAuthorityKind[] = [
  'PROFILE',
  'WORK',
  'TREASURY',
  'DISPUTE',
];
const profileName = z.string().trim().pipe(PublicGuildSchema.shape.name);
const profileDescription = z.string().trim().pipe(PublicGuildSchema.shape.description);
/** Live grants per Guild, and live grants one delegate may have passed on (bounds the cascade audit on revocation). */
export const GUILD_GRANT_LIMIT = 200;
export const DELEGATED_GRANT_LIMIT = 10;
const profileFields = z.enum(['name', 'description']);
/**
 * Id inputs are canonicalized to lowercase: they are stored verbatim in receipts (`resultRef`, request digest) and
 * compared with the database's `id::text`, so a non-canonical spelling must not fail at commit or change the digest.
 */
const uuid = z.uuid().transform((value) => value.toLowerCase());
export const GrantGuildRoleInputSchema = z
  .strictObject({
    guildId: uuid,
    granteeAccountId: InternalId,
    kind: z.enum(['PROFILE', 'WORK', 'TREASURY', 'DISPUTE']),
    fields: z.array(profileFields).min(1).max(2).optional(),
    canDelegate: z.boolean().optional(),
    expiresAt: z.iso.datetime().nullable().optional(),
  })
  .superRefine((value, ctx) => {
    const profile = value.kind === 'PROFILE';
    if (profile !== (value.fields !== undefined))
      ctx.addIssue({ code: 'custom', message: 'Only profile grants name fields, and they must.' });
    if (value.fields && new Set(value.fields).size !== value.fields.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate field.' });
    if (!profile && value.canDelegate)
      ctx.addIssue({ code: 'custom', message: 'Only profile grants can delegate.' });
  })
  // Equivalent requests normalize to one digest, so a retry with the same meaning replays.
  .transform((value) => ({
    guildId: value.guildId,
    granteeAccountId: value.granteeAccountId,
    kind: value.kind,
    fields: value.fields ? [...value.fields].sort() : [],
    canDelegate: value.canDelegate === true,
    expiresAt: value.expiresAt ? new Date(value.expiresAt).toISOString() : null,
  }));
export const RevokeGuildRoleInputSchema = z.strictObject({ guildId: uuid, grantId: uuid });
export const GuildRoleGrantViewSchema = z.strictObject({
  version: z.literal('v1'),
  id: z.uuid(),
  guildId: z.uuid(),
  granteeAccountId: z.string().min(1).max(200),
  kind: z.enum(['PROFILE', 'WORK', 'TREASURY', 'DISPUTE']),
  fields: z.array(profileFields).max(2),
  canDelegate: z.boolean(),
  validFrom: z.iso.datetime(),
  expiresAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
  grantedByAccountId: z.string().min(1).max(200),
});
export type GuildRoleGrantView = z.infer<typeof GuildRoleGrantViewSchema>;
export const OWNERSHIP_TRANSFER_MAX_DAYS = 30;
export const ProposeOwnershipTransferInputSchema = z
  .strictObject({ guildId: uuid, toAccountId: InternalId, expiresAt: z.iso.datetime() })
  .transform((value) => ({ ...value, expiresAt: new Date(value.expiresAt).toISOString() }));
export const RespondOwnershipTransferInputSchema = z.strictObject({
  guildId: uuid,
  transferId: uuid,
  decision: z.enum(['ACCEPT', 'DECLINE', 'WITHDRAW']),
});
export const OwnershipTransferViewSchema = z.strictObject({
  version: z.literal('v1'),
  id: z.uuid(),
  guildId: z.uuid(),
  fromAccountId: z.string().min(1).max(200),
  toAccountId: z.string().min(1).max(200),
  state: z.enum(['PROPOSED', 'ACCEPTED', 'DECLINED', 'WITHDRAWN', 'EXPIRED']),
  expiresAt: z.iso.datetime(),
  decidedAt: z.iso.datetime().nullable(),
  applied: z.boolean(),
});
export type OwnershipTransferView = z.infer<typeof OwnershipTransferViewSchema>;
export const GUILD_DRAFT_UPDATE_LIMIT = 50;
/** Per author and Guild: open drafts plus drafts withdrawn before ever being published (rows are never deleted). */
export const GUILD_UNPUBLISHED_UPDATE_LIMIT = 100;
export const GUILD_UPDATE_PAGE_MAX = 20;
export const DraftGuildUpdateInputSchema = z.strictObject({
  guildId: uuid,
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(4000),
});
export const GuildUpdateRefInputSchema = z.strictObject({ guildId: uuid, updateId: uuid });
export const ListPublicGuildUpdatesInputSchema = z.strictObject({
  limit: z.number().int().min(1).max(GUILD_UPDATE_PAGE_MAX).optional(),
  before: uuid.optional(),
});
export const ManagedGuildUpdateSchema = z.strictObject({
  version: z.literal('v1'),
  id: z.uuid(),
  guildId: z.uuid(),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(4000),
  state: z.enum(['DRAFT', 'PUBLISHED', 'WITHDRAWN']),
  authorAccountId: z.string().min(1).max(200),
  createdAt: z.iso.datetime(),
  publishedAt: z.iso.datetime().nullable(),
});
export type ManagedGuildUpdate = z.infer<typeof ManagedGuildUpdateSchema>;
/** The whole public projection of an update: text and time, no author, Guild or state. */
export const PublicGuildUpdateSchema = z.strictObject({
  id: z.uuid(),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(4000),
  publishedAt: z.iso.datetime(),
});
export type PublicGuildUpdate = z.infer<typeof PublicGuildUpdateSchema>;
export const PublicGuildUpdatesPageSchema = z.strictObject({
  updates: z.array(PublicGuildUpdateSchema).max(GUILD_UPDATE_PAGE_MAX),
  nextCursor: z.uuid().nullable(),
});
export const ActivateGuildInputSchema = z.strictObject({
  guildDraftId: uuid,
  expectedDraftRevision: z.number().int().min(1).max(2147483646),
  activationRef: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/),
});
export const EditGuildProfileInputSchema = z.strictObject({
  guildId: uuid,
  expectedRevision: z.number().int().min(1).max(2147483646),
  profile: z
    .strictObject({ name: profileName.optional(), description: profileDescription.optional() })
    .refine((p) => p.name !== undefined || p.description !== undefined),
});
export const ManagedGuildSchema = z.strictObject({
  version: z.literal('v1'),
  id: z.uuid(),
  slug: PublicGuildSchema.shape.slug,
  name: PublicGuildSchema.shape.name,
  description: PublicGuildSchema.shape.description,
  founderAccountId: z.string().min(1).max(200),
  revision: z.number().int().min(1),
  state: z.literal('ACTIVE'),
  primaryToken: z.null(),
});
export type ManagedGuild = z.infer<typeof ManagedGuildSchema>;
export class GuildStorageError extends Error {
  constructor(
    readonly code:
      | 'INVALID_INPUT'
      | 'UNAUTHENTICATED'
      | 'ACCOUNT_RESTRICTED'
      | 'FORBIDDEN'
      | 'NOT_FOUND'
      | 'WRITES_DISABLED'
      | 'REVISION_CONFLICT'
      | 'GUILD_EXISTS'
      | 'SLUG_UNAVAILABLE'
      | 'GRANT_LIMIT'
      | 'TRANSFER_PENDING'
      | 'UPDATE_LIMIT'
      | 'STORAGE_CONTRACT'
      | 'STORAGE_UNAVAILABLE',
  ) {
    super(code);
    this.name = 'GuildStorageError';
  }
}
