import { z } from 'zod';
import type { CommandReceiptTransaction } from '../command-receipts';
import { PublicGuildSchema } from '../contracts/entities';

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
export type GuildAuthorityKind = 'PROFILE' | 'WORK' | 'TREASURY' | 'DISPUTE';
export const GUILD_AUTHORITY_KINDS: readonly GuildAuthorityKind[] = [
  'PROFILE',
  'WORK',
  'TREASURY',
  'DISPUTE',
];
const profileName = z.string().trim().pipe(PublicGuildSchema.shape.name);
const profileDescription = z.string().trim().pipe(PublicGuildSchema.shape.description);
export const ActivateGuildInputSchema = z.strictObject({
  guildDraftId: z.uuid(),
  expectedDraftRevision: z.number().int().min(1).max(2147483646),
  activationRef: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/),
});
export const EditGuildProfileInputSchema = z.strictObject({
  guildId: z.uuid(),
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
      | 'STORAGE_CONTRACT'
      | 'STORAGE_UNAVAILABLE',
  ) {
    super(code);
    this.name = 'GuildStorageError';
  }
}
